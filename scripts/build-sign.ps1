Write-Host "📦 Building the application..." -ForegroundColor Cyan
pnpm dist:win

# Pick the appx matching the version we just built, not whatever sorts first --
# electron-builder leaves older artifacts in dist/, so a bare wildcard would
# grab a stale package.
$version = (Get-Content .\package.json -Raw | ConvertFrom-Json).version
$appxFile = Get-ChildItem -Path .\dist -Filter "*$version.appx" | Select-Object -First 1

if ($appxFile) {
    Write-Host "🚚 Moving $($appxFile.Name) to code-signing..." -ForegroundColor Cyan

    # Create directory if it doesn't exist
    if (!(Test-Path -Path ".\code-signing")) { New-Item -ItemType Directory -Path ".\code-signing" | Out-Null }

    # Copy and rename
    Copy-Item -Path $appxFile.FullName -Destination ".\code-signing\package.appx"

    # Move into directory and sign
    Set-Location -Path ".\code-signing"
    Write-Host "✍️ Signing the application..." -ForegroundColor Cyan

    # EXACT SIGNTOOL PATH ADDED HERE
    $signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"

    # The '&' tells PowerShell to execute the string path as a command
    & $signtool sign /debug /fd SHA256 /a /f ADBBA92C-68FC-4614-8695-A08D2C192895.pfx package.appx

    Set-Location -Path ".."
    Write-Host "✅ Build and sign complete!" -ForegroundColor Green
} else {
    Write-Host "❌ No .appx file found for version $version." -ForegroundColor Red
}
