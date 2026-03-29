# Windows Bootstrap

이 문서는 Remodex를 Windows에서 띄우기 위한 bootstrap 절차를 정리한다.

현재 상태:

- Windows용 bootstrap asset은 작성됨
- Task Scheduler XML 생성은 현재 macOS에서 정적 검증 완료
- Windows 실제 실행 증거는 아직 없음
- 따라서 이 문서는 `pilot 준비 문서`이며, 운영 완료 선언 문서는 아니다

연결 문서:

- [WINDOWS_PORTABILITY_CHECKLIST.md](./WINDOWS_PORTABILITY_CHECKLIST.md)
- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- [STRATEGY.md](./STRATEGY.md)

## Included Assets

- env helper: [ops/lib/RemodexEnv.ps1](./ops/lib/RemodexEnv.ps1)
- live preflight: [ops/check_discord_gateway_live_preflight.mjs](./ops/check_discord_gateway_live_preflight.mjs)
- live proof runner: [ops/run_discord_gateway_live_proof.mjs](./ops/run_discord_gateway_live_proof.mjs)
- Gateway adapter wrapper: [ops/run_discord_gateway_adapter.ps1](./ops/run_discord_gateway_adapter.ps1)
- bridge wrapper: [ops/run_bridge_daemon.ps1](./ops/run_bridge_daemon.ps1)
- scheduler wrapper: [ops/run_scheduler_tick.ps1](./ops/run_scheduler_tick.ps1)
- dashboard wrapper: [ops/run_dashboard_server.ps1](./ops/run_dashboard_server.ps1)
- task installer: [ops/install_windows_scheduled_tasks.ps1](./ops/install_windows_scheduled_tasks.ps1)
- task uninstaller: [ops/uninstall_windows_scheduled_tasks.ps1](./ops/uninstall_windows_scheduled_tasks.ps1)
- generic renderer: [ops/render_scheduler_artifacts.mjs](./ops/render_scheduler_artifacts.mjs)

## Required Config

- `REMODEX_SCHEDULER_KIND=windows_task_scheduler`
- `REMODEX_WORKSPACE`
- `REMODEX_SHARED_BASE`
- `REMODEX_WORKSPACE_KEY`
- `CODEX_APP_SERVER_WS_URL`
- `REMODEX_OPERATOR_HTTP_HOST`
- `REMODEX_OPERATOR_HTTP_PORT`
- `REMODEX_DISCORD_BOT_TOKEN_PATH` 또는 `REMODEX_DISCORD_BOT_TOKEN`
- `REMODEX_DISCORD_APPLICATION_ID`

Fallback only:

- `REMODEX_DISCORD_PUBLIC_KEY_PATH`

권장:

- `REMODEX_NODE_BIN=node`
- `REMODEX_WINDOWS_TASK_PREFIX=Remodex`
- `REMODEX_SCHEDULER_INTERVAL_SECONDS=60`
- `REMODEX_AUTO_CONSUME_HUMAN_GATE=false`
- `REMODEX_DISCORD_GATEWAY_URL=wss://gateway.discord.gg/?v=10&encoding=json`
- `REMODEX_DISCORD_GATEWAY_INTENTS=0`
- `REMODEX_DISCORD_API_BASE_URL=https://discord.com/api/v10`
- `REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=false`
- `REMODEX_ENABLE_DASHBOARD_SERVER=false`

## Bootstrap Order

1. `ops/remodex.env.example`를 `ops/remodex.env`로 복사한다.
2. `REMODEX_WORKSPACE`를 실제 Windows 절대 경로로 채운다.
3. `REMODEX_SCHEDULER_KIND=windows_task_scheduler`로 맞춘다.
4. `CODEX_APP_SERVER_WS_URL`와 Discord public key 경로를 채운다.
5. `node ops/render_scheduler_artifacts.mjs`로 task XML을 생성한다.
6. PowerShell에서 `ops/install_windows_scheduled_tasks.ps1`를 실행한다.
7. canonical Gateway path를 상시 운영할 거면 `REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=true`로 두고 artifacts를 다시 생성한다.
8. dashboard를 supervised task로 같이 올릴 거면 `REMODEX_ENABLE_DASHBOARD_SERVER=true`로 두고 artifacts를 다시 생성한다.
9. Task Scheduler에서 `BridgeDaemon`, `SchedulerTick`, 그리고 enabled 상태라면 `DiscordGatewayAdapter`, `DashboardServer` task가 등록됐는지 확인한다.
10. canonical Discord ingress를 쓸 경우 `node ops/check_discord_gateway_live_preflight.mjs`로 자격증명/loopback/app-server 경계를 먼저 확인한다.
11. canonical Discord ingress를 쓸 경우 `ops/run_discord_gateway_adapter.ps1`를 supervisor 또는 수동 세션에서 별도로 올리거나, proof 수집이 목적이면 `node ops/run_discord_gateway_live_proof.mjs`를 사용한다.
12. bridge `/health`, dashboard `/health`, shared memory runtime 파일 또는 live proof bundle로 첫 상태를 확인한다.

## Generated Artifacts

- `ops/windows-task-scheduler/generated/<prefix>-BridgeDaemon.xml`
- `ops/windows-task-scheduler/generated/<prefix>-SchedulerTick.xml`
- `ops/windows-task-scheduler/generated/<prefix>-DiscordGatewayAdapter.xml` (`REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=true`일 때만)
- `ops/windows-task-scheduler/generated/<prefix>-DashboardServer.xml` (`REMODEX_ENABLE_DASHBOARD_SERVER=true`일 때만)

## Operational Notes

- 생성되는 Task Scheduler XML은 UTF-8로 기록되고, installer도 UTF-8로 읽는다.
- PowerShell execution policy가 스크립트 실행을 막으면 정책 조정이 필요할 수 있다.
- loopback bind만 허용하는 운영 전제를 유지해야 한다.
- foreground active 동안 background trigger를 켜 두면 경쟁 실행 위험이 생긴다.
- 현재 macOS 검증 환경에는 `pwsh`/`powershell` 바이너리가 없어 실제 Windows 실행 검증은 아직 못 했다.
- Windows actual pilot 전에는 [WINDOWS_PORTABILITY_CHECKLIST.md](./WINDOWS_PORTABILITY_CHECKLIST.md)의 probe 항목을 통과해야 한다.
