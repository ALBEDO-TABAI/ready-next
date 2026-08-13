#!/usr/bin/env python3
import hashlib
import json
import os
import stat
import sys


def fail(message):
    raise RuntimeError(message)


def open_directory_chain(root_fd, relative_directory, create=False):
    current = os.dup(root_fd)
    try:
        for segment in [part for part in relative_directory.split('/') if part]:
            if segment in ('.', '..'):
                fail('unsafe release output directory')
            try:
                next_fd = os.open(
                    segment,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0),
                    dir_fd=current,
                )
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(segment, 0o755, dir_fd=current)
                next_fd = os.open(
                    segment,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0),
                    dir_fd=current,
                )
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise


def hash_fd(fd):
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode):
        fail('release transaction input must be a regular file')
    digest = hashlib.sha256()
    offset = 0
    while offset < before.st_size:
        chunk = os.pread(fd, min(1024 * 1024, before.st_size - offset), offset)
        if not chunk:
            break
        digest.update(chunk)
        offset += len(chunk)
    after = os.fstat(fd)
    identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_mode)
    final_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_mode)
    if identity != final_identity or offset != before.st_size:
        fail('release transaction file changed while it was read')
    return {'bytes': offset, 'sha256': digest.hexdigest()}


def open_source(path):
    return os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))


def open_relative(directory_fd, name, flags, mode=0o644):
    if '/' in name or name in ('', '.', '..'):
        fail('unsafe release transaction leaf')
    return os.open(name, flags | getattr(os, 'O_NOFOLLOW', 0), mode, dir_fd=directory_fd)


def copy_exclusive(source_path, destination_fd, destination_name, expected):
    source_fd = open_source(source_path)
    output_fd = None
    try:
        source_identity = hash_fd(source_fd)
        if source_identity != expected:
            fail('release transaction source identity mismatch')
        output_fd = open_relative(
            destination_fd,
            destination_name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL,
        )
        offset = 0
        while offset < source_identity['bytes']:
            chunk = os.pread(source_fd, min(1024 * 1024, source_identity['bytes'] - offset), offset)
            if not chunk:
                break
            written = 0
            while written < len(chunk):
                written += os.write(output_fd, chunk[written:])
            offset += len(chunk)
        os.fsync(output_fd)
        if offset != source_identity['bytes']:
            fail('release transaction copy was incomplete')
        if hash_fd(output_fd) != expected:
            fail('release transaction copied identity mismatch')
    finally:
        if output_fd is not None:
            os.close(output_fd)
        os.close(source_fd)


def identity_at(directory_fd, name):
    fd = open_relative(directory_fd, name, os.O_RDONLY)
    try:
        return hash_fd(fd)
    finally:
        os.close(fd)


def remove_if_regular(directory_fd, name):
    try:
        value = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(value.st_mode):
        fail('stale release transaction output is not a regular file')
    os.unlink(name, dir_fd=directory_fd)


def main():
    request = json.load(sys.stdin)
    root = os.path.abspath(request['root'])
    if os.path.realpath(root) != root:
        fail('release root must be a physical path')
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0))
    artifact_dir_fd = receipt_dir_fd = None
    artifact_temp = artifact_backup = receipt_temp = None
    receipt_created = False
    artifact_promoted = False
    artifact_backed_up = False
    try:
        receipt_dir_fd = open_directory_chain(root_fd, request['receiptDirectory'], create=True)
        action = request.get('action', 'promote')
        if action == 'write-receipt':
            try:
                existing = identity_at(receipt_dir_fd, request['receiptLeaf'])
                if existing != request['receiptIdentity']:
                    fail('existing structural receipt conflicts with verified package')
            except FileNotFoundError:
                copy_exclusive(
                    request['receiptSource'],
                    receipt_dir_fd,
                    request['receiptLeaf'],
                    request['receiptIdentity'],
                )
            return 0
        artifact_dir_fd = open_directory_chain(root_fd, request['artifactDirectory'], create=True)
        artifact_temp = f".{request['artifactLeaf']}.{request['suffix']}.verified"
        artifact_backup = f".{request['artifactLeaf']}.{request['suffix']}.previous"
        receipt_temp = f".{request['receiptLeaf']}.{request['suffix']}.verified"
        if action == 'finalize':
            remove_if_regular(artifact_dir_fd, artifact_backup)
            return 0
        if action == 'rollback':
            remove_if_regular(artifact_dir_fd, request['artifactLeaf'])
            try:
                os.rename(artifact_backup, request['artifactLeaf'], src_dir_fd=artifact_dir_fd, dst_dir_fd=artifact_dir_fd)
            except FileNotFoundError:
                pass
            if request.get('receiptCreated'):
                remove_if_regular(receipt_dir_fd, request['receiptLeaf'])
            return 0
        if action != 'promote':
            fail('unknown release transaction action')
        for directory_fd, name in (
            (artifact_dir_fd, artifact_temp),
            (artifact_dir_fd, artifact_backup),
            (receipt_dir_fd, receipt_temp),
        ):
            remove_if_regular(directory_fd, name)

        copy_exclusive(request['artifactSource'], artifact_dir_fd, artifact_temp, request['artifactIdentity'])
        if request['receiptAlreadyExists']:
            if identity_at(receipt_dir_fd, request['receiptLeaf']) != request['receiptIdentity']:
                fail('existing release receipt changed before promotion')
        else:
            copy_exclusive(request['receiptSource'], receipt_dir_fd, receipt_temp, request['receiptIdentity'])
            os.link(
                receipt_temp,
                request['receiptLeaf'],
                src_dir_fd=receipt_dir_fd,
                dst_dir_fd=receipt_dir_fd,
                follow_symlinks=False,
            )
            receipt_created = True
            os.unlink(receipt_temp, dir_fd=receipt_dir_fd)

        try:
            current = os.stat(request['artifactLeaf'], dir_fd=artifact_dir_fd, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode):
                fail('existing release artifact is not a regular file')
            os.rename(
                request['artifactLeaf'],
                artifact_backup,
                src_dir_fd=artifact_dir_fd,
                dst_dir_fd=artifact_dir_fd,
            )
            artifact_backed_up = True
        except FileNotFoundError:
            pass
        os.rename(artifact_temp, request['artifactLeaf'], src_dir_fd=artifact_dir_fd, dst_dir_fd=artifact_dir_fd)
        artifact_promoted = True
        if identity_at(artifact_dir_fd, request['artifactLeaf']) != request['artifactIdentity']:
            fail('promoted release artifact identity mismatch')
        if identity_at(receipt_dir_fd, request['receiptLeaf']) != request['receiptIdentity']:
            fail('promoted release receipt identity mismatch')
        os.fsync(artifact_dir_fd)
        os.fsync(receipt_dir_fd)
        print(json.dumps({
            'artifactBackedUp': artifact_backed_up,
            'receiptCreated': receipt_created,
        }))
        return 0
    except Exception:
        try:
            if artifact_promoted:
                os.unlink(request['artifactLeaf'], dir_fd=artifact_dir_fd)
            if artifact_backed_up:
                os.rename(artifact_backup, request['artifactLeaf'], src_dir_fd=artifact_dir_fd, dst_dir_fd=artifact_dir_fd)
            if receipt_created:
                os.unlink(request['receiptLeaf'], dir_fd=receipt_dir_fd)
        finally:
            if artifact_dir_fd is not None and artifact_temp is not None:
                remove_if_regular(artifact_dir_fd, artifact_temp)
            if receipt_dir_fd is not None and receipt_temp is not None:
                remove_if_regular(receipt_dir_fd, receipt_temp)
        raise
    finally:
        if artifact_dir_fd is not None:
            os.close(artifact_dir_fd)
        if receipt_dir_fd is not None:
            os.close(receipt_dir_fd)
        os.close(root_fd)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
