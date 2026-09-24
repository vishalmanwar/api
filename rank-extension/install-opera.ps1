$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtensionOpera"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$base = "https://raw.githubusercontent.com/vishalmanwar/api/master/rank-extension"
$files = @("manifest.json","popup.html","popup.css","popup.js","background.js")
foreach ($file in $files) {
  Invoke-WebRequest "$base/$file" -OutFile (Join-Path $dir $file)
}

Write-Host ""
Write-Host "Zipify Opera Rank Extension files are ready at:"
Write-Host $dir
Write-Host ""
Write-Host "Opera will now open the Extensions page."
Write-Host "1. Turn ON Developer mode."
Write-Host "2. Click Load unpacked."
Write-Host "3. Select this folder:"
Write-Host $dir
Write-Host ""
Write-Host "Then open Amazon.in in Opera, manually set pincode 380015, keep that tab open, and run Zipify Rank Agent once."

$candidates = @(
  "$env:LOCALAPPDATA\Programs\Opera\launcher.exe",
  "$env:LOCALAPPDATA\Programs\Opera\opera.exe",
  "$env:LOCALAPPDATA\Programs\Opera GX\launcher.exe",
  "$env:LOCALAPPDATA\Programs\Opera GX\opera.exe",
  "$env:ProgramFiles\Opera\launcher.exe",
  "$env:ProgramFiles\Opera\opera.exe",
  "$env:ProgramFiles(x86)\Opera\launcher.exe",
  "$env:ProgramFiles(x86)\Opera\opera.exe"
)

$operaPath = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $operaPath) {
  $searchRoots = @(
    "$env:LOCALAPPDATA\Programs",
    "$env:ProgramFiles",
    "$env:ProgramFiles(x86)"
  ) | Where-Object { $_ -and (Test-Path $_) }

  foreach ($root in $searchRoots) {
    $found = Get-ChildItem $root -Filter launcher.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\Opera" } |
      Select-Object -First 1
    if ($found) { $operaPath = $found.FullName; break }
  }
}

if ($operaPath) {
  Start-Process $operaPath "opera://extensions/"
} else {
  Write-Host "Opera executable was not found automatically."
  Write-Host "Open Opera manually and go to: opera://extensions/"
}
