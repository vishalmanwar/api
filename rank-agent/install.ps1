param([string]$AgentToken)

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "ZipifyRankAgent"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

if (-not $AgentToken) {
  $AgentToken = Read-Host "Paste the Agent Token shown in Zipify Rank Intelligence > Settings"
}
if (-not $AgentToken) { throw "Agent token is required." }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js is not installed. Trying Node.js LTS through winget..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw "Install Node.js LTS from nodejs.org, then run this installer again." }
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
$nodePath = (Get-Command node).Source
$npmPath = (Get-Command npm).Source

$raw = "https://raw.githubusercontent.com/vishalmanwar/api/master"
Invoke-WebRequest "$raw/rank-agent/agent.mjs" -OutFile (Join-Path $dir "agent.mjs")
Invoke-WebRequest "$raw/package.json" -OutFile (Join-Path $dir "package.json")

$json = @{ api = "https://ywrtgkdkntjyeqdnrbop.supabase.co/functions/v1/rank-intelligence"; token = $AgentToken } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $dir "agent-config.json"), $json, (New-Object System.Text.UTF8Encoding($false)))

Push-Location $dir
& $npmPath install
& $npmPath exec -- playwright install chromium
Pop-Location

$taskName = "Zipify Rank Agent"
$arg = '"' + (Join-Path $dir "agent.mjs") + '"'
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arg -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Free Amazon rank collector for Zipify" -Force | Out-Null

Write-Host ""
Write-Host "Zipify Rank Agent installed. Running the first check now..."
Push-Location $dir
& $nodePath (Join-Path $dir "agent.mjs")
Pop-Location
Write-Host "Done. Keep Windows/Internet available; the agent checks for due jobs every 5 minutes."
