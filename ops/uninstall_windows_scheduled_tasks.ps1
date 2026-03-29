Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir "lib/RemodexEnv.ps1")

$WorkspaceDir = Resolve-RemodexWorkspaceDir -ScriptRoot $ScriptDir
$EnvFile = if ($env:REMODEX_ENV_FILE) { $env:REMODEX_ENV_FILE } else { Join-Path $WorkspaceDir "ops/remodex.env" }

Import-RemodexEnvFile -Path $EnvFile

if (-not $env:REMODEX_SCHEDULER_KIND) { $env:REMODEX_SCHEDULER_KIND = "windows_task_scheduler" }
if ($env:REMODEX_SCHEDULER_KIND -ne "windows_task_scheduler") {
  throw "uninstall_windows_scheduled_tasks.ps1 only supports REMODEX_SCHEDULER_KIND=windows_task_scheduler"
}

$TaskPrefix = if ($env:REMODEX_WINDOWS_TASK_PREFIX) { $env:REMODEX_WINDOWS_TASK_PREFIX } else { "Remodex" }
$BridgeTaskName = "$TaskPrefix-BridgeDaemon"
$SchedulerTaskName = "$TaskPrefix-SchedulerTick"
$GatewayTaskName = "$TaskPrefix-DiscordGatewayAdapter"
$DashboardTaskName = "$TaskPrefix-DashboardServer"

foreach ($TaskName in @($BridgeTaskName, $SchedulerTaskName, $GatewayTaskName, $DashboardTaskName)) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

Write-Host "Removed tasks if present:"
Write-Host $BridgeTaskName
Write-Host $SchedulerTaskName
Write-Host $GatewayTaskName
Write-Host $DashboardTaskName
