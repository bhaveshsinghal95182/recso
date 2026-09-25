param(
    [string]$PackageName = 'Descentkatil.Recso',
    [ValidateRange(5, 300)]
    [int]$DurationSeconds = 15
)

# Run against an installed, signed AppX. A dev or unpacked launch does not
# exercise Windows package integrity enforcement. This does not reset app data.
$ErrorActionPreference = 'Stop'
$package = Get-AppxPackage -Name $PackageName
if (!$package) { throw "Install the signed $PackageName AppX before running this check." }
if ($package.Status -ne 'Ok') {
    throw "Package status is $($package.Status). Reinstall the signed AppX before testing."
}

[xml]$manifest = Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
$executable = Join-Path $package.InstallLocation $manifest.Package.Applications.Application.Executable
if (Get-Process -ErrorAction SilentlyContinue | Where-Object Path -EQ $executable) {
    throw 'Close the installed Recso app before running this check.'
}

$logPath = Join-Path ([IO.Path]::GetTempPath()) ("recso-appx-" + [guid]::NewGuid() + '.log')
$startedAt = Get-Date
$process = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru -ArgumentList @(
    '--enable-logging',
    ('--log-file="' + $logPath + '"')
)
try {
    $exited = $process.WaitForExit($DurationSeconds * 1000)
    $status = (Get-AppxPackage -Name $PackageName).Status
    # Read the channel even when no new events exist. Failure to read it must
    # not silently count as "no integrity failures".
    $integrityEvents = @(Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' -MaxEvents 1000 |
        Where-Object { $_.TimeCreated -ge $startedAt -and $_.Id -eq 3033 -and $_.Message.Contains($package.PackageFullName) })
    Write-Output "Package: $($package.PackageFullName); status: $status; exited: $exited"
    Write-Output "Chromium log: $logPath"
    foreach ($event in $integrityEvents) { Write-Output $event.Message }
    if ($exited -or $status -ne 'Ok' -or $integrityEvents.Count -gt 0) {
        throw 'FAIL: packaged startup exited, triggered Code Integrity, or left the package needing repair.'
    }
    $chromiumLog = Get-Content -LiteralPath $logPath -Raw
    if ($chromiumLog -match 'engine bridge failed to load|Unable to load preload script' -or
        $chromiumLog -notmatch 'engine bridge loaded') {
        throw 'FAIL: the packaged renderer did not load the engine preload bridge. See the Chromium log.'
    }
    Write-Output "PASS: packaged app survived $DurationSeconds seconds with healthy package integrity."
} finally {
    if (!$process.HasExited) {
        # Only terminate the process tree launched by this check.
        & taskkill.exe /PID $process.Id /T /F | Out-Null
    }
    $process.Dispose()
}
