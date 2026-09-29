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

$base = "https://raw.githubusercontent.com/vishalmanwar/api/5290c7893ca8144f7d99c82b499df88f8058805f/rank-extension"
$files = @("manifest.json","popup.html","popup.css","popup.js","background.js","runner.html","runner.js")
foreach ($file in $files) {
  $dest = Join-Path $dir $file
  $tmp = $dest + ".download"
  Invoke-WebRequest "$base/$file" -OutFile $tmp
  Move-Item -Force $tmp $dest
}

$manifest = Get-Content (Join-Path $dir "manifest.json") -Raw | ConvertFrom-Json
$background = Get-Content (Join-Path $dir "background.js") -Raw`n$runner = Get-Content (Join-Path $dir "runner.js") -Raw
if ($manifest.version -ne "1.7.0") {
  throw "Extension update verification failed. Expected manifest 1.7.0, got $($manifest.version)."
}
if ($runner -notmatch "2026\.09\.29\.57-runner-v1") {
  throw "Extension update verification failed. Persistent runner-v1 was not downloaded."
}

# Opera can keep an unpacked Manifest V3 service worker cached even after a full
# browser restart. Open the extensions page so the operator can explicitly reload
# the unpacked Zipify extension and activate the newly downloaded background.js.
Start-Process $operaPath
Start-Sleep -Seconds 2
Start-Process $operaPath "opera://extensions"

Write-Host ""
Write-Host "Zipify Opera Rank Agent files updated and Opera restarted."
Write-Host "Installed manifest: 1.7.0"
Write-Host "Installed agent build: 2026.09.29.57-runner-v1"
Write-Host "IMPORTANT: On the Opera Extensions page that opened, click Reload on Zipify Multi-Market Rank Agent once."
Write-Host ""
