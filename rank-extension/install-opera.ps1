$ErrorActionPreference = "Stop"

$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankExtensionOpera"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

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
  $roots=@("$env:LOCALAPPDATA\Programs","$env:ProgramFiles","$env:ProgramFiles(x86)") | Where-Object { $_ -and (Test-Path $_) }
  foreach($root in $roots){
    $found=Get-ChildItem $root -Filter launcher.exe -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\Opera" } | Select-Object -First 1
    if($found){$operaPath=$found.FullName;break}
  }
}

if($operaPath){
  $startup=[Environment]::GetFolderPath("Startup")
  $shortcutPath=Join-Path $startup "Zipify Rank Opera.lnk"
  $ws=New-Object -ComObject WScript.Shell
  $sc=$ws.CreateShortcut($shortcutPath)
  $sc.TargetPath=$operaPath
  $sc.Arguments="--start-minimized"
  $sc.WorkingDirectory=Split-Path $operaPath
  $sc.Save()

  Start-Process $operaPath "opera://extensions/"
}

Write-Host ""
Write-Host "Zipify Opera Rank Agent stable files updated:"
Write-Host $dir
Write-Host ""
Write-Host "ONE FINAL BROWSER STEP:"
Write-Host "In opera://extensions click Reload on Zipify Rank Agent."
Write-Host ""
Write-Host "After that the agent uses the pincode from Dashboard Settings automatically."
Write-Host "Opera is also configured to start with Windows."
