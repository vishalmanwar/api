$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtensionOpera"
if (-not (Test-Path $dir)) {
  throw "Zipify Opera extension folder was not found: $dir"
}

$base = "https://raw.githubusercontent.com/vishalmanwar/api/master/rank-extension"
$files = @("manifest.json","popup.html","popup.css","popup.js","background.js")
foreach ($file in $files) {
  Invoke-WebRequest "$base/$file" -OutFile (Join-Path $dir $file)
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

# Restart Opera so the already-loaded unpacked extension picks up the new files.
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

Start-Process $operaPath
Start-Sleep -Seconds 2
Start-Process $operaPath "--private https://www.amazon.in/"

Write-Host ""
Write-Host "Zipify Opera Rank Agent updated and Opera restarted."
Write-Host "No extension Reload click is needed for an existing unpacked installation."
Write-Host "Expected extension build: 2026.09.27.50-continue-shopping-real-click"
Write-Host ""
