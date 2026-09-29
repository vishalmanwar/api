$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtensionOpera"
if (-not (Test-Path $dir)) {
  throw "Zipify Opera extension folder was not found: $dir"
}

$candidates = @(
  "$env:LOCALAPPDATA\Programs\Opera\launcher.exe",
  "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
  "$env:ProgramFiles\Opera\launcher.exe",
  "$env:ProgramFiles\Opera\opera.exe",
  "$env:ProgramFiles(x86)\Opera\launcher.exe",
  "$env:ProgramFiles(x86)\Opera\opera.exe"
)
$operaPath = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $operaPath) {
  throw "Opera executable was not found."
}

# Fully stop Opera first so the unpacked extension cannot run while its files
# are being replaced.
$main = Get-Process -Name opera -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
foreach ($p in $main) {
  try { [void]$p.CloseMainWindow() } catch {}
}
Start-Sleep -Seconds 3

$remaining = Get-Process -Name opera -ErrorAction SilentlyContinue
if ($remaining) {
  $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$base = "https://raw.githubusercontent.com/vishalmanwar/api/2bc78bb5f86a9088fdb5d1ae93debcd0d8d0fcad/rank-extension"
$files = @("manifest.json","popup.html","popup.css","popup.js","background.js")
foreach ($file in $files) {
  $dest = Join-Path $dir $file
  $tmp = $dest + ".download"
  Invoke-WebRequest "$base/$file" -OutFile $tmp
  Move-Item -Force $tmp $dest
}

$manifest = Get-Content (Join-Path $dir "manifest.json") -Raw | ConvertFrom-Json
$background = Get-Content (Join-Path $dir "background.js") -Raw
if ($manifest.version -ne "1.6.2") {
  throw "Extension update verification failed. Expected manifest 1.6.2, got $($manifest.version)."
}
if ($background -notmatch "2026\.09\.29\.56-snapshot-v4") {
  throw "Extension update verification failed. Snapshot-v4 background build was not downloaded."
}

# Opera can keep an unpacked Manifest V3 service worker cached even after a full
# browser restart. Open the extensions page so the operator can explicitly reload
# the unpacked Zipify extension and activate the newly downloaded background.js.
Start-Process $operaPath
Start-Sleep -Seconds 2
Start-Process $operaPath "opera://extensions"

Write-Host ""
Write-Host "Zipify Opera Rank Agent files updated and Opera restarted."
Write-Host "Installed manifest: 1.6.2"
Write-Host "Installed agent build: 2026.09.29.56-snapshot-v4"
Write-Host "IMPORTANT: On the Opera Extensions page that opened, click Reload on Zipify Multi-Market Rank Agent."
Write-Host ""
