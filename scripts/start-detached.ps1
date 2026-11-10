# Start a bot detached from the shell that launched it, so it keeps running when that shell (or the Claude session driving it) ends.
#   powershell -NoProfile -File scripts/start-detached.ps1 -Bot ozo -Runtime C:\Users\walte\Downloads\Minecraft-Survival
# Output goes to <runtime>\start-bot.out.log and start-bot.err.log. Stop it by killing the start-bot.js process (its run.js/join.js follow).
param([Parameter(Mandatory = $true)][string]$Bot, [Parameter(Mandatory = $true)][string]$Runtime)
$repo = Split-Path -Parent $PSScriptRoot
$env:BOT_RUNTIME_DIR = $Runtime
$p = Start-Process -FilePath 'node' -ArgumentList @('scripts/start-bot.js', $Bot) -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $Runtime 'start-bot.out.log') -RedirectStandardError (Join-Path $Runtime 'start-bot.err.log')
Write-Output "started $Bot pid $($p.Id)"
