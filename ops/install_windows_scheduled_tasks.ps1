Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir "lib/RemodexEnv.ps1")

$WorkspaceDir = Resolve-RemodexWorkspaceDir -ScriptRoot $ScriptDir
$EnvFile = if ($env:REMODEX_ENV_FILE) { $env:REMODEX_ENV_FILE } else { Join-Path $WorkspaceDir "ops/remodex.env" }

Import-RemodexEnvFile -Path $EnvFile

if (-not $env:REMODEX_WORKSPACE) { $env:REMODEX_WORKSPACE = $WorkspaceDir }
if (-not $env:REMODEX_NODE_BIN) { $env:REMODEX_NODE_BIN = "node" }
if (-not $env:REMODEX_SCHEDULER_KIND) { $env:REMODEX_SCHEDULER_KIND = "windows_task_scheduler" }
if ($env:REMODEX_SCHEDULER_KIND -ne "windows_task_scheduler") {
  throw "install_windows_scheduled_tasks.ps1 only supports REMODEX_SCHEDULER_KIND=windows_task_scheduler"
}

& $env:REMODEX_NODE_BIN (Join-Path $env:REMODEX_WORKSPACE "ops/render_scheduler_artifacts.mjs") | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "render_scheduler_artifacts failed"
}

$TaskPrefix = if ($env:REMODEX_WINDOWS_TASK_PREFIX) { $env:REMODEX_WINDOWS_TASK_PREFIX } else { "Remodex" }
$GeneratedDir = Join-Path $env:REMODEX_WORKSPACE "ops/windows-task-scheduler/generated"
$BridgeTaskName = "$TaskPrefix-BridgeDaemon"
$SchedulerTaskName = "$TaskPrefix-SchedulerTick"
$GatewayTaskName = "$TaskPrefix-DiscordGatewayAdapter"
$DashboardTaskName = "$TaskPrefix-DashboardServer"
$BridgeXml = Join-Path $GeneratedDir "$BridgeTaskName.xml"
$SchedulerXml = Join-Path $GeneratedDir "$SchedulerTaskName.xml"
$GatewayXml = Join-Path $GeneratedDir "$GatewayTaskName.xml"
$DashboardXml = Join-Path $GeneratedDir "$DashboardTaskName.xml"

$Utf8 = [System.Text.Encoding]::UTF8
Register-ScheduledTask -TaskName $BridgeTaskName -Xml ([System.IO.File]::ReadAllText($BridgeXml, $Utf8)) -Force | Out-Null
Register-ScheduledTask -TaskName $SchedulerTaskName -Xml ([System.IO.File]::ReadAllText($SchedulerXml, $Utf8)) -Force | Out-Null
if (Test-Path $GatewayXml) {
  Register-ScheduledTask -TaskName $GatewayTaskName -Xml ([System.IO.File]::ReadAllText($GatewayXml, $Utf8)) -Force | Out-Null
}
if (Test-Path $DashboardXml) {
  Register-ScheduledTask -TaskName $DashboardTaskName -Xml ([System.IO.File]::ReadAllText($DashboardXml, $Utf8)) -Force | Out-Null
}

Write-Host "Registered tasks:"
Write-Host $BridgeTaskName
Write-Host $SchedulerTaskName
if (Test-Path $GatewayXml) {
  Write-Host $GatewayTaskName
}
if (Test-Path $DashboardXml) {
  Write-Host $DashboardTaskName
}
