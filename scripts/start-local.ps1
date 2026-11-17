[CmdletBinding()]
param([switch]$BackupConfig, [switch]$CheckOnly, [string]$DataDir)

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

function Backup-LocalDesktopConfig {
    param([string]$DataDir)

    if ($DataDir.TrimEnd('\', '/') -eq [IO.Path]::GetPathRoot($DataDir).TrimEnd('\', '/')) {
        throw 'Configuration backup requires a profile directory below the volume or share root.'
    }
    $backupRoot = $DataDir.TrimEnd('\', '/') + '.config-backups'
    $null = [IO.Directory]::CreateDirectory($backupRoot)
    if ((Get-Item -LiteralPath $backupRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The configuration backup directory must not be a junction or symbolic link.'
    }
    $backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    $pending = $backup + '.partial'
    $null = [IO.Directory]::CreateDirectory($pending)
    $permissions = Get-Acl -LiteralPath $DataDir
    $permissions.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $pending -AclObject $permissions
    Write-Host 'Exporting application preferences and provider/model configuration only.'
    & cargo.exe run --quiet --locked --manifest-path (Join-Path $script:LocalDesktopRoot 'Cargo.toml') -p host-core --bin pi-desktop-host-core -- --backup-config $DataDir (Join-Path $pending 'configuration.json') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Configuration export failed (exit $LASTEXITCODE)." }
    Assert-LocalDesktopStopped
    [IO.Directory]::Move($pending, $backup)
    Write-Host "Configuration backup: $backup"
}

function Invoke-LocalDesktop {
    param([switch]$BackupConfig, [switch]$CheckOnly, [string]$DataDir)

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
    if ($DataDir.Length -gt [IO.Path]::GetPathRoot($DataDir).Length) {
        $DataDir = $DataDir.TrimEnd('\', '/')
    }
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
    $mutex = [Threading.Mutex]::new($false, 'Local\PI-Desktop-SharedProfileLauncher')
    $held = $false
    try {
        try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another shared-profile launcher is already active.' }
        Write-Warning 'This writes your real data and may migrate it. Chromium state remains separate in Dev.'
        Write-Host 'Do not start the installed app while this source version is running.'
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
            if ($BackupConfig) {
                Backup-LocalDesktopConfig -DataDir $DataDir
                Assert-LocalDesktopStopped
            }
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
        $code = Invoke-LocalDesktop -BackupConfig:$BackupConfig -CheckOnly:$CheckOnly -DataDir $DataDir
        exit $code
    } catch {
        Write-Error -Message $_.Exception.Message -ErrorAction Continue
        exit 1
    }
}
