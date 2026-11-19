// The launcher joins the lease's job before creating Codex. Its non-inheritable job handle
// is the lifetime of the tree: losing either Ready or Codex also ends the descendants.
#include <windows.h>
#include <tlhelp32.h>
#include <wincrypt.h>
#include <shlwapi.h>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "shlwapi.lib")

static void check(bool ok) {
    if (!ok) throw GetLastError();
}

static std::wstring jobName(const std::wstring& digest) {
    if (digest.size() != 64 || digest.find_first_not_of(L"0123456789abcdef") != std::wstring::npos)
        throw ERROR_INVALID_PARAMETER;
    return L"Local\\ReadyNext.Codex." + digest;
}

static std::wstring inheritedJobName() {
    std::wstring markers;
    for (auto key : {L"READY_CODEX_PROCESS_LEASE_ID", L"READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID",
                     L"READY_CODEX_CONNECTION_EPOCH", L"READY_CODEX_STATE_DIR"}) {
        const wchar_t* value = _wgetenv(key);
        if (!value || !*value) throw ERROR_INVALID_DATA;
        if (!markers.empty()) markers.push_back(L'\0');
        markers += value;
    }
    BYTE digest[32];
    DWORD size = sizeof(digest);
    check(CryptHashCertificate2(L"SHA256", 0, nullptr, reinterpret_cast<const BYTE*>(markers.data()),
                                static_cast<DWORD>(markers.size() * sizeof(wchar_t)), digest, &size));
    std::wstring hex;
    for (BYTE b : digest) {
        hex += L"0123456789abcdef"[b >> 4];
        hex += L"0123456789abcdef"[b & 15];
    }
    return jobName(hex);
}

static std::map<DWORD, DWORD> parentPids() {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    check(snapshot != INVALID_HANDLE_VALUE);
    PROCESSENTRY32W entry{sizeof(entry)};
    std::map<DWORD, DWORD> parents;
    check(Process32FirstW(snapshot, &entry));
    do {
        parents[entry.th32ProcessID] = entry.th32ParentProcessID;
    } while (Process32NextW(snapshot, &entry));
    check(GetLastError() == ERROR_NO_MORE_FILES);
    CloseHandle(snapshot);
    return parents;
}

static unsigned long long createdAt(HANDLE process) {
    FILETIME created, exited, kernel, user;
    check(GetProcessTimes(process, &created, &exited, &kernel, &user));
    return (static_cast<unsigned long long>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
}

static DWORD launch(const wchar_t* executable) {
    wchar_t self[32768];
    DWORD length = GetModuleFileNameW(nullptr, self, ARRAYSIZE(self));
    check(length && length < ARRAYSIZE(self));
    std::wstring sibling(self, length);
    sibling.replace(sibling.find_last_of(L'\\') + 1, std::wstring::npos, L"codex.exe");
    if (_wcsicmp(sibling.c_str(), executable)) throw ERROR_INVALID_PARAMETER;

    DWORD parentPid = parentPids().at(GetCurrentProcessId());
    HANDLE main = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid);
    check(main != nullptr);
    if (createdAt(main) > createdAt(GetCurrentProcess())) throw ERROR_PROCESS_ABORTED;
    HANDLE job = CreateJobObjectW(nullptr, inheritedJobName().c_str());
    check(job && GetLastError() != ERROR_ALREADY_EXISTS);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)));
    check(AssignProcessToJobObject(job, GetCurrentProcess()));
    if (WaitForSingleObject(main, 0) != WAIT_TIMEOUT) throw ERROR_PROCESS_ABORTED;

    STARTUPINFOW startup{sizeof(startup)};
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child{};
    // Retain the exact executable and argument quoting supplied by Node.
    std::wstring command = PathGetArgsW(GetCommandLineW());
    check(CreateProcessW(sibling.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                         nullptr, nullptr, &startup, &child));
    CloseHandle(child.hThread);
    HANDLE watched[] = {main, child.hProcess};
    DWORD finished = WaitForMultipleObjects(2, watched, FALSE, INFINITE);
    check(finished != WAIT_FAILED);
    DWORD status = ERROR_PROCESS_ABORTED;
    if (finished == WAIT_OBJECT_0 + 1) check(GetExitCodeProcess(child.hProcess, &status));
    return status; // process exit closes the job handle
}

static HANDLE openJob(const wchar_t* digest, DWORD access) {
    HANDLE job = OpenJobObjectW(access, FALSE, jobName(digest).c_str());
    if (!job && GetLastError() != ERROR_FILE_NOT_FOUND) throw GetLastError();
    return job;
}

static std::vector<DWORD> members(HANDLE job) {
    std::vector<ULONG_PTR> buffer(32);
    for (;;) {
        auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
        if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
                                      static_cast<DWORD>(buffer.size() * sizeof(ULONG_PTR)), nullptr)) {
            if (list->NumberOfAssignedProcesses == list->NumberOfProcessIdsInList)
                return {list->ProcessIdList, list->ProcessIdList + list->NumberOfProcessIdsInList};
        } else {
            check(GetLastError() == ERROR_MORE_DATA);
        }
        buffer.resize(buffer.size() * 2);
    }
}

static void report(DWORD pid, DWORD parent, HANDLE job) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
    if (!process && GetLastError() == ERROR_INVALID_PARAMETER) return; // already exited
    check(process != nullptr);
    BOOL member = FALSE;
    if (job) check(IsProcessInJob(process, job, &member));
    DWORD status = WaitForSingleObject(process, 0);
    check(status != WAIT_FAILED);
    if ((!job || member) && status == WAIT_TIMEOUT) {
        wchar_t image[32768];
        DWORD size = ARRAYSIZE(image);
        check(QueryFullProcessImageNameW(process, 0, image, &size));
        std::wstring row = std::to_wstring(pid) + L"\t" + std::to_wstring(parent) + L"\t" +
            std::to_wstring(createdAt(process)) + L"\t" + (member ? L"1\t" : L"0\t") + image + L"\n";
        DWORD bytes = static_cast<DWORD>(row.size() * sizeof(wchar_t)), written;
        check(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), row.data(), bytes, &written, nullptr) && written == bytes);
    }
    CloseHandle(process);
}

int wmain(int argc, wchar_t** argv) {
    try {
        if (argc >= 2 && std::wstring(argv[1]) == L"list" && (argc == 3 || argc == 4)) {
            auto parents = parentPids();
            DWORD owner = std::stoul(argv[2]);
            report(owner, parents[owner], nullptr);
            HANDLE job = argc == 4 ? openJob(argv[3], JOB_OBJECT_QUERY) : nullptr;
            if (job) for (DWORD pid : members(job)) report(pid, parents[pid], job);
            return 0;
        }
        if (argc == 3 && std::wstring(argv[1]) == L"terminate") {
            HANDLE job = openJob(argv[2], JOB_OBJECT_TERMINATE);
            if (job) check(TerminateJobObject(job, ERROR_PROCESS_ABORTED));
            return 0;
        }
        if (argc >= 2) return launch(argv[1]);
        return ERROR_INVALID_PARAMETER;
    } catch (DWORD code) {
        std::fprintf(stderr, "Ready Codex job error %lu\n", code);
        return 1;
    } catch (...) {
        return 1;
    }
}
