import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** WindowsPowerShell uses the built-in ACL APIs. Paths travel as data, never as script text. */
function runAcl(script: string, paths: string[]): void {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('windows_system_directory_missing')
  execFileSync(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $user=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    'foreach ($path in (ConvertFrom-Json $env:READY_ACL_PATHS)) { ' +
    "$item=Get-Item -LiteralPath $path -Force; if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unexpected reparse point' }; " +
    script + ' }',
  ], { env: { ...process.env, READY_ACL_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 15000 })
}

export function protectPrivateDirectories(paths: string[]): void {
  runAcl([
    '$acl=New-Object Security.AccessControl.DirectorySecurity',
    '$acl.SetOwner($user)',
    '$acl.SetAccessRuleProtection($true,$false)',
    "$rule=New-Object Security.AccessControl.FileSystemAccessRule($user,'FullControl','ContainerInherit,ObjectInherit','None','Allow')",
    '$acl.AddAccessRule($rule)',
    '$item.SetAccessControl($acl)',
  ].join('; '), paths)
}

export function verifyPrivateFile(path: string): void {
  runAcl([
    '$acl=$item.GetAccessControl()',
    '$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
    "if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $user -or $rules[0].AccessControlType -ne 'Allow' -or $acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $user) { throw 'unexpected private file ACL' }",
  ].join('; '), [path])
}
