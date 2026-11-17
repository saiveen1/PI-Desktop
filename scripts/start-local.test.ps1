$ErrorActionPreference = 'Stop'
if (-not $env:PI_SCRATCH_DIR) { throw 'PI_SCRATCH_DIR is required for isolated launcher tests.' }
$fixture = Join-Path $env:PI_SCRATCH_DIR ("local launch ' " + [guid]::NewGuid().ToString('N'))
$source = Join-Path $PSScriptRoot 'start-local.ps1'
$fixtureMutex = 'Local\PI-Desktop-LauncherTest-' + [guid]::NewGuid().ToString('N')
$fixtureSource = (Get-Content -LiteralPath $source -Raw).Replace('Local\PI-Desktop-SharedProfileLauncher', $fixtureMutex)
$originalLocation = Get-Location
$originalEnvironment = @{}
foreach ($name in @('PI_DESKTOP_DATA_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'PI_LOCAL_TEST_REPORT')) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$script:checks = 0
function Assert-True($condition, $message) {
    if (-not $condition) { throw "Assertion failed: $message" }
    $script:checks++
}
function Assert-Failure([scriptblock]$action, [string]$pattern) {
    $failure = $null
    try { & $action | Out-Null } catch { $failure = $_.Exception.Message }
    Assert-True ($failure -match $pattern) "Expected '$pattern', received '$failure'"
}
try {
    $null = New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts'), (Join-Path $fixture 'node_modules'), (Join-Path $fixture 'profile')
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'start-local.cmd') -Destination $fixture
    # Exercise the real CMD entry with only the PowerShell boundary substituted.
    Set-Content -LiteralPath (Join-Path $fixture 'scripts/start-local.ps1') -Encoding ASCII -Value @'
Write-Output ('FORWARDED=' + ($args -join '|'))
exit 0
'@
    $entry = Join-Path $fixture 'start-local.cmd'
    function Invoke-TestEntry([string]$Arguments = '-CheckOnly') {
        $entryInfo = New-Object Diagnostics.ProcessStartInfo
        $entryInfo.FileName = $env:ComSpec
        $entryInfo.Arguments = '/d /s /c ""{0}" {1}"' -f $entry, $Arguments
        $entryInfo.UseShellExecute = $false
        $entryInfo.RedirectStandardOutput = $true
        $entryInfo.RedirectStandardInput = $true
        $entryProcess = [Diagnostics.Process]::Start($entryInfo)
        try {
            $entryProcess.StandardInput.Close()
            $entryOutput = $entryProcess.StandardOutput.ReadToEnd()
            $entryProcess.WaitForExit()
            return @{ Code = $entryProcess.ExitCode; Output = $entryOutput }
        } finally { $entryProcess.Dispose() }
    }
    $entryResult = Invoke-TestEntry
    Assert-True ($entryResult.Code -eq 0 -and $entryResult.Output -match 'FORWARDED=-CheckOnly\s*$') "CMD stays in the current console; received: $($entryResult.Output)"
    $entryResult = Invoke-TestEntry -Arguments '-BackupConfig -CheckOnly'
    Assert-True ($entryResult.Code -eq 0 -and $entryResult.Output -match 'FORWARDED=-BackupConfig\|-CheckOnly\s*$') 'CMD forwards the optional configuration backup switch explicitly'
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts/start-local.ps1'), $fixtureSource)
    $data = Join-Path $fixture 'profile'
    Set-Content -LiteralPath (Join-Path $data 'pi.sqlite') -Value 'fixture sentinel, not a database' -Encoding ASCII
    $config = Join-Path $fixture 'start-local.data-dir.local'
    Set-Content -LiteralPath $config -Value $data -Encoding UTF8
    $script:fakePnpm = Join-Path $fixture 'fake-pnpm.cmd'
    Set-Content -LiteralPath $script:fakePnpm -Encoding ASCII -Value @'
@echo off
> "%PI_LOCAL_TEST_REPORT%" echo %PI_DESKTOP_DATA_DIR%
>> "%PI_LOCAL_TEST_REPORT%" echo %*
>> "%PI_LOCAL_TEST_REPORT%" echo %CD%
>> "%PI_LOCAL_TEST_REPORT%" echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
>> "%PI_LOCAL_TEST_REPORT%" echo NODE_OPTIONS=[%NODE_OPTIONS%]
echo fixture build output must remain visible
exit /b 7
'@
    . (Join-Path $fixture 'scripts/start-local.ps1')
    # Only external OS/process boundaries are substituted.
    $script:owners = @()
    $script:missingTool = ''
    $script:ownerCheck = 0
    $script:ownerAtCheck = 0
    function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
        if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM query.' }
        $script:ownerCheck++
        if ($script:ownerCheck -eq $script:ownerAtCheck) { return [pscustomobject]@{ Name = 'host-core.exe'; ProcessId = 9 } }
        return $script:owners
    }
    function Get-Command($Name, $CommandType, $ErrorAction) {
        if ($Name -eq $script:missingTool) { throw "Missing tool: $Name" }
        return [pscustomobject]@{ Source = $script:fakePnpm }
    }
    function Read-Host { throw 'Launching must not require interactive confirmation.' }
    function Invoke-CimMethod { throw 'Launching must not create a detached WMI child.' }
    $script:exportCount = 0
    $script:exportExit = 0
    function cargo.exe {
        $script:exportCount++
        $script:exportArgs = $args
        if ($script:exportExit -eq 0) { [IO.File]::WriteAllText($args[-1], '{"format":"pi-desktop-local-config","version":1}') }
        $global:LASTEXITCODE = $script:exportExit
    }
    $env:PI_LOCAL_TEST_REPORT = Join-Path $fixture 'result.txt'
    $env:PI_DESKTOP_DATA_DIR = 'do-not-inherit-this-profile'
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:NODE_OPTIONS = '--untrusted-parent-option'

    $backupRoot = $data + '.config-backups'
    Assert-True ((Invoke-LocalDesktop -BackupConfig -CheckOnly) -eq 0) 'check-only with backup requested succeeds without doing it'
    Assert-True (-not (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'check-only has no backup or launch'
    Assert-Failure { Invoke-LocalDesktop -CheckOnly -DataDir 'relative-profile' } 'absolute Windows path'
    Assert-Failure { Invoke-LocalDesktop -CheckOnly -DataDir (Join-Path $fixture 'missing') } 'does not contain pi.sqlite'
    Remove-Item -LiteralPath $config
    Assert-Failure { Invoke-LocalDesktop -CheckOnly } 'Create start-local.data-dir.local'
    Set-Content -LiteralPath $config -Value $data -Encoding UTF8
    $script:missingTool = 'cargo.exe'
    Assert-Failure { Invoke-LocalDesktop -CheckOnly } 'Missing tool: cargo.exe'
    $script:missingTool = ''
    Remove-Item -LiteralPath (Join-Path $fixture 'node_modules')
    Assert-Failure { Invoke-LocalDesktop -CheckOnly } 'Workspace dependencies are missing'
    $null = New-Item -ItemType Directory -Path (Join-Path $fixture 'node_modules')

    foreach ($name in @('PI-Desktop.exe', 'host-core.exe', 'electron.exe')) {
        $script:owners = @([pscustomobject]@{ Name = $name; ProcessId = 8; ExecutablePath = (Join-Path $fixture $name) })
        Assert-Failure { Invoke-LocalDesktop -CheckOnly } 'No processes were stopped'
    }
    $script:owners = @([pscustomobject]@{ Name = 'electron.exe'; ProcessId = 8; ExecutablePath = 'C:\unrelated\electron.exe' })
    Assert-True ((Invoke-LocalDesktop -CheckOnly) -eq 0) 'unrelated Electron is not blocked'
    $script:owners = @([pscustomobject]@{ Name = 'electron.exe'; ProcessId = 8; ExecutablePath = $null })
    Assert-Failure { Invoke-LocalDesktop -CheckOnly } 'No processes were stopped'
    $script:owners = @()
    $external = Join-Path $fixture 'external'
    $null = [IO.Directory]::CreateDirectory($external)
    $null = New-Item -ItemType Junction -Path $backupRoot -Target $external
    try { Assert-Failure { Invoke-LocalDesktop -BackupConfig } 'must not be a junction' } finally { [IO.Directory]::Delete($backupRoot) }
    Assert-True (@(Get-ChildItem -LiteralPath $external -Force).Count -eq 0) 'linked backup root remains untouched'
    $script:ownerCheck = 0
    $script:ownerAtCheck = 2
    Assert-Failure { Invoke-LocalDesktop } 'No processes were stopped'
    Assert-True (-not (Test-Path -LiteralPath $backupRoot)) 'owner before backup prevents profile copying'
    $script:ownerCheck = 0
    $script:ownerAtCheck = 3
    Assert-Failure { Invoke-LocalDesktop -BackupConfig } 'No processes were stopped'
    Assert-True (-not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'owner during backup prevents pnpm'
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Directory -Filter '*.partial').Count -eq 1) 'interrupted backup is marked partial'
    $script:ownerAtCheck = 0

    # Default launch must not even open the database: deny all file sharing.
    $locked = [IO.File]::Open((Join-Path $data 'pi.sqlite'), 'Open', 'ReadWrite', 'None')
    $exportsBeforeDefault = $script:exportCount
    try { $code = Invoke-LocalDesktop } finally { $locked.Dispose() }
    Assert-True ($code -eq 7 -and $script:exportCount -eq $exportsBeforeDefault) 'default launch runs without opening or exporting configuration'
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Directory | Where-Object { $_.Name -notlike '*.partial' }).Count -eq 0) 'default launch creates no completed backup'
    Remove-Item -LiteralPath $env:PI_LOCAL_TEST_REPORT
    $script:exportExit = 5
    Assert-Failure { Invoke-LocalDesktop -BackupConfig } 'Configuration export failed \(exit 5\)'
    Assert-True (-not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'requested export failure prevents pnpm'
    $script:exportExit = 0

    $code = Invoke-LocalDesktop -BackupConfig
    Assert-True ($code -eq 7) 'pnpm failure returned without capturing its stdout'
    $report = Get-Content -LiteralPath $env:PI_LOCAL_TEST_REPORT
    $backups = @(Get-ChildItem -LiteralPath $backupRoot -Directory | Where-Object { $_.Name -notlike '*.partial' })
    Assert-True ($backups.Count -eq 1) 'completed configuration export published only after success'
    $backup = $backups[0].FullName
    Assert-True ((Get-Acl -LiteralPath $backup).AreAccessRulesProtected) 'backup profile permissions are protected from the backup parent inheritance'
    Assert-True (@(Get-ChildItem -LiteralPath $backup -Recurse -Force).Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $backup 'configuration.json'))) 'backup contains only the configuration export, no database or session copies'
    Assert-True ($script:exportArgs[-3] -eq '--backup-config' -and $script:exportArgs[-2] -eq $data) 'host exporter receives literal selected profile and output paths'
    Assert-True ($report[0] -eq $data -and $report[1] -eq 'dev --inherit-data-dir' -and $report[2] -eq $fixture) 'real command gets exact cwd, args and explicit profile'
    Assert-True ($report[3] -eq 'ELECTRON_RUN_AS_NODE=[]' -and $report[4] -eq 'NODE_OPTIONS=[]') 'child environment is sanitized'
    Assert-True ($env:PI_DESKTOP_DATA_DIR -eq 'do-not-inherit-this-profile' -and $env:ELECTRON_RUN_AS_NODE -eq '1' -and $env:NODE_OPTIONS -eq '--untrusted-parent-option') 'caller environment restored'
    Assert-True ((Get-Location).Path -eq $originalLocation.Path) 'caller cwd restored'
    Remove-Item -LiteralPath $env:PI_LOCAL_TEST_REPORT

    $null = Invoke-LocalDesktop -BackupConfig -DataDir ($data + '\')
    Assert-True (@(Get-ChildItem -LiteralPath $backupRoot -Directory | Where-Object { $_.Name -notlike '*.partial' }).Count -eq 2) 'repeat launch with trailing slash retains previous backup'
    # Run the actual bootstrap through CMD with only process/tool discovery replaced.
    $production = $fixtureSource
    $externalBoundaries = @'
function Get-CimInstance { return @() }
function Get-Command { return [pscustomobject]@{ Source = (Join-Path $script:LocalDesktopRoot 'fake-pnpm.cmd') } }
'@
    $production = $production.Replace('$script:LocalDesktopRoot = Split-Path -Parent $PSScriptRoot', ('$script:LocalDesktopRoot = Split-Path -Parent $PSScriptRoot' + "`r`n" + $externalBoundaries))
    Set-Content -LiteralPath (Join-Path $fixture 'scripts/start-local.ps1') -Encoding UTF8 -Value $production
    $entryResult = Invoke-TestEntry
    Assert-True ($entryResult.Code -eq 0 -and $entryResult.Output -match 'Preflight passed') 'CMD check-only reaches production bootstrap without starting a build'
    $entryResult = Invoke-TestEntry -Arguments ('-DataDir "{0}"' -f $data)
    Assert-True ($entryResult.Code -eq 7 -and $entryResult.Output -match 'fixture build output must remain visible' -and $entryResult.Output -match 'Dev command exited with code 7') 'CMD preserves real build output and exact nonzero exit status'
    $fakeCommand = (Get-Content -LiteralPath $script:fakePnpm -Raw).Replace('exit /b 7', 'exit /b 0')
    Set-Content -LiteralPath $script:fakePnpm -Encoding ASCII -Value $fakeCommand
    $entryResult = Invoke-TestEntry -Arguments ('-DataDir "{0}"' -f $data)
    Assert-True ($entryResult.Code -eq 0 -and $entryResult.Output -match 'Dev command exited with code 0') 'CMD returns success only when the foreground command succeeds'
    Assert-True ((Get-Content -LiteralPath (Join-Path $data 'pi.sqlite') -Raw).Trim() -eq 'fixture sentinel, not a database') 'fixture profile untouched'
    Write-Host "PASS: $script:checks launcher assertions; no real Desktop or WMI child launched."
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $fixture) {
        $scratchRoot = [IO.Path]::GetFullPath($env:PI_SCRATCH_DIR).TrimEnd('\') + '\'
        if (-not [IO.Path]::GetFullPath($fixture).StartsWith($scratchRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup escaped session scratch.' }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}
