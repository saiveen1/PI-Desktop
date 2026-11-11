$ErrorActionPreference = 'Stop'
if (-not $env:PI_SCRATCH_DIR) { throw 'PI_SCRATCH_DIR is required for isolated launcher tests.' }
$fixture = Join-Path $env:PI_SCRATCH_DIR ("local launch ' " + [guid]::NewGuid().ToString('N'))
$source = Join-Path $PSScriptRoot 'start-local.ps1'
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
    Copy-Item -LiteralPath $source -Destination (Join-Path $fixture 'scripts/start-local.ps1')
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
    # Only external OS/process/interactive boundaries are substituted.
    $script:owners = @()
    $script:missingTool = ''
    $script:confirmation = ''
    $script:promptCount = 0
    $script:wmiCount = 0
    $script:wmiReturn = 0
    $script:lateOwner = $false
    function Get-CimInstance($ClassName, $Filter, $ErrorAction) {
        if ($ClassName -ne 'Win32_Process') { throw 'Unexpected CIM query.' }
        return $script:owners
    }
    function Get-Command($Name, $CommandType, $ErrorAction) {
        if ($Name -eq $script:missingTool) { throw "Missing tool: $Name" }
        return [pscustomobject]@{ Source = $script:fakePnpm }
    }
    function Read-Host($Prompt) {
        $script:promptCount++
        if ($script:lateOwner) { $script:owners = @([pscustomobject]@{ Name = 'host-core.exe'; ProcessId = 9 }) }
        return $script:confirmation
    }
    function Invoke-CimMethod($ClassName, $MethodName, $Arguments, $ErrorAction) {
        if ($ClassName -ne 'Win32_Process' -or $MethodName -ne 'Create') { throw 'Unexpected WMI method.' }
        $script:wmiCount++
        $script:wmiArguments = $Arguments
        return [pscustomobject]@{ ReturnValue = $script:wmiReturn; ProcessId = 123 }
    }
    $env:PI_LOCAL_TEST_REPORT = Join-Path $fixture 'result.txt'
    $env:PI_DESKTOP_DATA_DIR = 'do-not-inherit-this-profile'
    $env:ELECTRON_RUN_AS_NODE = '1'
    $env:NODE_OPTIONS = '--untrusted-parent-option'

    Assert-True ((Invoke-LocalDesktop -LaunchWindow -CheckOnly) -eq 0) 'check-only succeeds'
    Assert-True ($script:wmiCount -eq 0 -and $script:promptCount -eq 0) 'check-only has no launch or prompt'
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
    Assert-True ((Invoke-LocalDesktop) -eq 0) 'Enter cancels'
    Assert-True (-not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'cancellation did not run pnpm'
    $script:confirmation = 'BACKED UP'
    $script:lateOwner = $true
    Assert-Failure { Invoke-LocalDesktop } 'No processes were stopped'
    Assert-True (-not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'late owner prevents pnpm'
    $script:lateOwner = $false
    $script:owners = @()

    $code = Invoke-LocalDesktop
    Assert-True ($code -eq 7) 'pnpm failure returned without capturing its stdout'
    $report = Get-Content -LiteralPath $env:PI_LOCAL_TEST_REPORT
    Assert-True ($report[0] -eq $data -and $report[1] -eq 'dev --inherit-data-dir' -and $report[2] -eq $fixture) 'real command gets exact cwd, args and explicit profile'
    Assert-True ($report[3] -eq 'ELECTRON_RUN_AS_NODE=[]' -and $report[4] -eq 'NODE_OPTIONS=[]') 'child environment is sanitized'
    Assert-True ($env:PI_DESKTOP_DATA_DIR -eq 'do-not-inherit-this-profile' -and $env:ELECTRON_RUN_AS_NODE -eq '1' -and $env:NODE_OPTIONS -eq '--untrusted-parent-option') 'caller environment restored'
    Assert-True ((Get-Location).Path -eq $originalLocation.Path) 'caller cwd restored'
    Remove-Item -LiteralPath $env:PI_LOCAL_TEST_REPORT

    Assert-True ((Invoke-LocalDesktop -LaunchWindow) -eq 0) 'WMI handoff succeeds'
    Assert-True ($script:wmiArguments.CurrentDirectory -eq $fixture) 'WMI receives checkout cwd'
    $encoded = ($script:wmiArguments.CommandLine -split ' ')[-1]
    $payload = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    $script:confirmation = ''
    $promptsBeforePayload = $script:promptCount
    & ([scriptblock]::Create($payload))
    Assert-True ($script:promptCount -eq $promptsBeforePayload + 1) 'decoded WMI payload reaches the real confirmation'
    Assert-True (-not (Test-Path -LiteralPath $env:PI_LOCAL_TEST_REPORT)) 'decoded payload with quoted paths reaches cancellation safely'
    $script:wmiReturn = 2
    Assert-Failure { Invoke-LocalDesktop -LaunchWindow } 'WMI launch failed with code 2'
    Assert-True ((Get-Content -LiteralPath (Join-Path $data 'pi.sqlite') -Raw).Trim() -eq 'fixture sentinel, not a database') 'fixture profile untouched'
    Write-Host "PASS: $script:checks launcher assertions; no real Desktop or WMI child launched."
} finally {
    Set-Location -LiteralPath $originalLocation.Path
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
