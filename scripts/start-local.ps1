[CmdletBinding()]
param([switch]$LaunchWindow, [switch]$CheckOnly, [string]$DataDir)

$script:LocalDesktopRoot = Split-Path -Parent $PSScriptRoot

function Assert-LocalDesktopStopped {
    $owners = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'PI-Desktop.exe' OR Name = 'host-core.exe' OR Name = 'electron.exe'" -ErrorAction Stop | Where-Object {
        $_.Name -ne 'electron.exe' -or
        [string]::IsNullOrWhiteSpace($_.ExecutablePath) -or
        $_.ExecutablePath.StartsWith($script:LocalDesktopRoot + '\', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($owners.Count -gt 0) {
        $summary = ($owners | ForEach-Object { '{0} (PID {1})' -f $_.Name, $_.ProcessId }) -join ', '
        throw "Exit PI-Desktop from its tray and stop other profile owners first: $summary. No processes were stopped."
    }
}

function Invoke-LocalDesktop {
    param([switch]$LaunchWindow, [switch]$CheckOnly, [string]$DataDir)

    $ErrorActionPreference = 'Stop'
    $root = $script:LocalDesktopRoot
    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        $config = Join-Path $root 'start-local.data-dir.local'
        if (-not (Test-Path -LiteralPath $config -PathType Leaf)) {
            throw 'Create start-local.data-dir.local in the checkout with the absolute path of your existing data directory.'
        }
        $DataDir = (Get-Content -LiteralPath $config -Raw -Encoding UTF8).Trim()
    }
    if ($DataDir -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)' -or $DataDir -match '[\r\n"]') {
        throw 'The data directory must be one absolute Windows path.'
    }
    $DataDir = [IO.Path]::GetFullPath($DataDir)
    if (-not (Test-Path -LiteralPath (Join-Path $DataDir 'pi.sqlite') -PathType Leaf)) {
        throw 'The selected directory does not contain pi.sqlite. Refusing to create an empty profile.'
    }
    foreach ($tool in @('node.exe', 'pnpm.cmd', 'cargo.exe')) {
        $null = Get-Command $tool -CommandType Application -ErrorAction Stop
    }
    $pnpm = (Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop).Source
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules') -PathType Container)) {
        throw 'Workspace dependencies are missing. Prepare the project environment before launching.'
    }
    Assert-LocalDesktopStopped
    Write-Host "Checkout: $root"
    Write-Host "Data directory (read/write): $DataDir"
    Write-Host 'Command: pnpm dev --inherit-data-dir (no installer; required compilation still runs).'
    if ($CheckOnly) {
        Write-Host 'Preflight passed. Nothing was launched or backed up; no profile contents were read.'
        return 0
    }
    if ($LaunchWindow) {
        # Encode literal arguments instead of interpolating paths into shell syntax.
        $scriptPath = Join-Path $PSScriptRoot 'start-local.ps1'
        $payload = '. ''{0}''; try {{ $null = Invoke-LocalDesktop -DataDir ''{1}'' }} catch {{ Write-Host $_.Exception.Message -ForegroundColor Red }}' -f $scriptPath.Replace("'", "''"), $DataDir.Replace("'", "''")
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
        $command = '"{0}" -NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -EncodedCommand {1}' -f (Join-Path $PSHOME 'powershell.exe'), $encoded
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command; CurrentDirectory = $root } -ErrorAction Stop
        if ($result.ReturnValue -ne 0) { throw "WMI launch failed with code $($result.ReturnValue)." }
        Write-Host "Launcher window requested (PID $($result.ProcessId)); inspect that window for build/startup results."
        return 0
    }

    $mutex = [Threading.Mutex]::new($false, 'Local\PI-Desktop-SharedProfileLauncher')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another shared-profile launcher is already active.' }
        Write-Warning 'This writes your real data and may migrate it. Chromium state remains separate in Dev.'
        Write-Host 'Before continuing: fully exit all profile owners and make a complete offline profile backup.'
        Write-Host 'This script does NOT create or verify a backup. Do not start the installed app while Dev is running.'
        if ((Read-Host 'Type BACKED UP to confirm, or press Enter to cancel') -cne 'BACKED UP') {
            Write-Host 'Cancelled. Nothing was launched.'
            return 0
        }
        Assert-LocalDesktopStopped
        $previous = @{}
        foreach ($name in @('PI_DESKTOP_DATA_DIR', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS')) {
            $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
        Push-Location -LiteralPath $root
        try {
            $env:PI_DESKTOP_DATA_DIR = $DataDir
            [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process')
            [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
            Write-Host 'Building required dependencies and starting Dev. Keep this console open for progress/errors.'
            # /d disables user CMD AutoRun hooks before invoking the existing pnpm shim.
            & $env:ComSpec /d /c ('"{0}" dev --inherit-data-dir' -f $pnpm) | Out-Host
            $code = $LASTEXITCODE
            Write-Host "Dev command exited with code $code."
            return $code
        } finally {
            Pop-Location
            foreach ($name in $previous.Keys) {
                [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
            }
        }
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $code = Invoke-LocalDesktop -LaunchWindow:$LaunchWindow -CheckOnly:$CheckOnly -DataDir $DataDir
        if ($code -ne 0) { throw "Source launch failed (exit $code). See the output above." }
    } catch {
        Write-Error -Message $_.Exception.Message -ErrorAction Continue
        exit 1
    }
}
