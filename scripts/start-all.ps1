# Make sure the LAN port follower and both bots are running; start whatever is missing. Safe to run any number of times (it only starts what is not there).
#   powershell -NoProfile -File scripts/start-all.ps1
# Run at logon and every few minutes by the scheduled task from scripts/register-autostart.ps1, so a reboot or a dead supervisor never leaves the bots idle.
# The bots keep retrying the LAN port themselves (run.js backs off to 60 s), and lan-watch.js keeps lan-port.txt current, so nothing here needs the world to be open.
$repo = Split-Path -Parent $PSScriptRoot
$root = Split-Path -Parent $repo
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
& powershell -NoProfile -File (Join-Path $PSScriptRoot 'start-lan-watch.ps1')
foreach ($b in @(@{ bot = 'ozo'; dir = 'Minecraft-Survival' }, @{ bot = 'smeo'; dir = 'Minecraft-Smeo' })) {
  $runtime = Join-Path $root $b.dir
  if (-not (Test-Path $runtime)) { continue }
  $up = $procs | Where-Object { $_.CommandLine -match ('start-bot\.js\s+' + $b.bot + '(\s|$)') }
  if ($up) { Write-Output "$($b.bot) already running pid $($up[0].ProcessId)"; continue }
  & powershell -NoProfile -File (Join-Path $PSScriptRoot 'start-detached.ps1') -Bot $b.bot -Runtime ($runtime -replace '\\', '/')
}
