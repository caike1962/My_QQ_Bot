$ErrorActionPreference = 'Stop'

$taskName = 'NapCat'
$scriptPath = 'D:\QQBOT\NapCat.Shell.Windows.Node\napcat\launcher-user.bat'
$workDir = 'D:\QQBOT\NapCat.Shell.Windows.Node\napcat'
$userName = "$env:COMPUTERNAME\$env:USERNAME"

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$scriptPath`"" -WorkingDirectory $workDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
try { $trigger.Delay = 'PT20S' } catch { Write-Output "delay not supported, continuing without it" }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'NapCat QQ bot - auto start at logon' | Out-Null

Write-Output '=== Created ==='
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-List
(Get-ScheduledTask -TaskName $taskName).Actions | Select-Object Execute, Arguments, WorkingDirectory | Format-List
(Get-ScheduledTask -TaskName $taskName).Principal | Select-Object UserId, RunLevel, LogonType | Format-List
Write-Output "resolved user: $userName"
