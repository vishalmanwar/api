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

$base = "https://raw.githubusercontent.com/vishalmanwar/api/master/rank-extension"
$files = @("manifest.json","popup.html","popup.css","popup.js","background.js")
foreach ($file in $files) {
  $dest = Join-Path $dir $file
  $tmp = $dest + ".download"
  Invoke-WebRequest "$base/$file" -OutFile $tmp
  Move-Item -Force $tmp $dest
}

$manifest = Get-Content (Join-Path $dir "manifest.json") -Raw | ConvertFrom-Json
$background = Get-Content (Join-Path $dir "background.js") -Raw
if ($manifest.version -ne "1.6.1") {
  throw "Extension update verification failed. Expected manifest 1.6.1, got $($manifest.version)."
}
if ($background -notmatch "2026\.09\.29\.55-navigation-v3") {
  throw "Extension update verification failed. Evidence-v3 background build was not downloaded."
}

# A normal Opera restart is enough. The rank agent itself creates and destroys
# its clean private Amazon windows for each keyword; do not seed a persistent
# private Amazon session here.
Start-Process $operaPath

Write-Host ""
Write-Host "Zipify Opera Rank Agent updated and Opera restarted."
Write-Host "Installed manifest: 1.6.1"
Write-Host "Installed agent build: 2026.09.29.55-navigation-v3"
Write-Host "No extension Reload click is needed for the existing unpacked installation."
Write-Host ""
