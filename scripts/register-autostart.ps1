# Register (or remove) the scheduled task that keeps the bots and the LAN port follower running: at logon, then every 5 minutes. Runs as the current user,
# no admin rights, no window.
#   powershell -NoProfile -File scripts/register-autostart.ps1            register
#   powershell -NoProfile -File scripts/register-autostart.ps1 -Remove    unregister
param([switch]$Remove)
$name = 'MC-Player Bot Autostart'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; Write-Output "removed $name"; exit 0 }
$script = Join-Path $PSScriptRoot 'start-all.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT30S'
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($logon, $repeat) -Settings $settings -Description 'Keeps the Minecraft bots and the LAN port follower running (scripts/start-all.ps1)' -Force | Out-Null
Write-Output "registered $name (at logon + every 5 min)"
