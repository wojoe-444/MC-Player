# Start the LAN port follower detached (see scripts/lan-watch.js). Safe to run twice: it does nothing when one is already running.
#   powershell -NoProfile -File scripts/start-lan-watch.ps1
$repo = Split-Path -Parent $PSScriptRoot
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'lan-watch\.js' }
if ($running) { Write-Output "already running pid $($running[0].ProcessId)"; exit 0 }
$log = Join-Path (Split-Path -Parent $repo) 'bot-shared'
$p = Start-Process -FilePath 'node' -ArgumentList @('scripts/lan-watch.js') -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $log 'lan-watch.out.log') -RedirectStandardError (Join-Path $log 'lan-watch.err.log')
Write-Output "started lan-watch pid $($p.Id)"
