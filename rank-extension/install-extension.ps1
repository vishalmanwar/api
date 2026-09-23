$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtension"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Disable the old Playwright scheduled task so it stops producing failed snapshots.
$oldTask = Get-ScheduledTask -TaskName "Zipify Rank Agent" -ErrorAction SilentlyContinue
if ($oldTask) {
  Unregister-ScheduledTask -TaskName "Zipify Rank Agent" -Confirm:$false
}

$base = "https://raw.githubusercontent.com/vishalmanwar/api/master/rank-extension"
$files = @("manifest.json","popup.html","popup.js","background.js")
foreach ($file in $files) {
  Invoke-WebRequest "$base/$file" -OutFile (Join-Path $dir $file)
}

Write-Host ""
Write-Host "Zipify Chrome Rank Extension files are ready at:"
Write-Host $dir
Write-Host ""
Write-Host "Chrome will now open the Extensions page."
Write-Host "1. Turn ON Developer mode (top-right)."
Write-Host "2. Click Load unpacked."
Write-Host "3. Select this folder:"
Write-Host $dir
Write-Host ""
Write-Host "Then pin 'Zipify Amazon Rank Collector' from the puzzle icon."

$chrome = Get-Command chrome.exe -ErrorAction SilentlyContinue
if (-not $chrome) {
  $paths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chromePath = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1
} else {
  $chromePath = $chrome.Source
}

if ($chromePath) {
  Start-Process $chromePath "chrome://extensions/"
} else {
  Write-Host "Open chrome://extensions/ manually."
}
