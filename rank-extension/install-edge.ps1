$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtension"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# Remove old Playwright task if it still exists.
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
Write-Host "Zipify Edge Rank Extension files are ready at:"
Write-Host $dir
Write-Host ""
Write-Host "Microsoft Edge will now open the Extensions page."
Write-Host "1. Turn ON Developer mode."
Write-Host "2. Click Load unpacked."
Write-Host "3. Select this folder:"
Write-Host $dir
Write-Host ""
Write-Host "Then pin 'Zipify Amazon Rank Collector' from the Extensions icon."

$edgePaths = @(
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edgePath) {
  Start-Process $edgePath "edge://extensions/"
} else {
  Write-Host "Microsoft Edge executable was not found automatically."
  Write-Host "Open Edge manually and go to: edge://extensions/"
}
