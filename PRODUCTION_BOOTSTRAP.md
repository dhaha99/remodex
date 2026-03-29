# Production Bootstrap

이 문서는 Remodex를 검증용 probe 묶음이 아니라 실제 운영 서비스처럼 띄우는 최소 절차를 정리한다. 평시 운영 규칙은 [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md), 장애 대응은 [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)를 따른다.

현재 bootstrap 자산은 `scheduler adapter` 경계를 갖는다. macOS는 `launchd_launchagent`, Windows는 `windows_task_scheduler` asset을 생성할 수 있다. 다만 Windows 쪽은 아직 실제 실행 증거가 없으므로 pilot 준비 단계로 본다.

중요:

- 현재 저장소에 들어 있는 bridge HTTP 서버는 **loopback internal ingress**다.
- 정식 Discord 운영 연결의 canonical path는 **Discord Gateway adapter**이며, 이 문서의 bridge bootstrap만으로는 production Discord ingress가 완성되지 않는다.
- `REMODEX_DISCORD_PUBLIC_KEY_PATH`는 현재 internal probe / webhook fallback 경계에만 직접 관련된다.
- `REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=true`일 때만 scheduler/bootstrap 자산에 Gateway adapter service가 포함된다.
- `REMODEX_ENABLE_DASHBOARD_SERVER=true`일 때만 scheduler/bootstrap 자산에 dashboard service가 포함된다.

## Included Assets

- env 샘플: [ops/remodex.env.example](./ops/remodex.env.example)
- Discord command registrar: [ops/register_discord_commands.mjs](./ops/register_discord_commands.mjs)
- Discord live preflight: [ops/check_discord_gateway_live_preflight.mjs](./ops/check_discord_gateway_live_preflight.mjs)
- Discord live proof runner: [ops/run_discord_gateway_live_proof.mjs](./ops/run_discord_gateway_live_proof.mjs)
- Discord live proof finalizer: [ops/finalize_discord_gateway_live_proof.mjs](./ops/finalize_discord_gateway_live_proof.mjs)
- scheduler adapter renderer: [ops/render_scheduler_artifacts.mjs](./ops/render_scheduler_artifacts.mjs)
- Gateway adapter wrapper: [ops/run_discord_gateway_adapter.sh](./ops/run_discord_gateway_adapter.sh)
- Gateway adapter wrapper (Windows): [ops/run_discord_gateway_adapter.ps1](./ops/run_discord_gateway_adapter.ps1)
- bridge wrapper: [ops/run_bridge_daemon.sh](./ops/run_bridge_daemon.sh)
- bridge wrapper (Windows): [ops/run_bridge_daemon.ps1](./ops/run_bridge_daemon.ps1)
- dashboard wrapper: [ops/run_dashboard_server.sh](./ops/run_dashboard_server.sh)
- dashboard wrapper (Windows): [ops/run_dashboard_server.ps1](./ops/run_dashboard_server.ps1)
- scheduler wrapper: [ops/run_scheduler_tick.sh](./ops/run_scheduler_tick.sh)
- scheduler wrapper (Windows): [ops/run_scheduler_tick.ps1](./ops/run_scheduler_tick.ps1)
- plist renderer: [ops/render_launchd_plists.mjs](./ops/render_launchd_plists.mjs)
- install helper: [ops/install_launchd_services.sh](./ops/install_launchd_services.sh)
- uninstall helper: [ops/uninstall_launchd_services.sh](./ops/uninstall_launchd_services.sh)
- Windows install helper: [ops/install_windows_scheduled_tasks.ps1](./ops/install_windows_scheduled_tasks.ps1)
- Windows uninstall helper: [ops/uninstall_windows_scheduled_tasks.ps1](./ops/uninstall_windows_scheduled_tasks.ps1)
- macOS metrics collector: [ops/collect_macos_runtime_metrics.sh](./ops/collect_macos_runtime_metrics.sh)
- macOS smoke runner: [ops/run_macos_smoke.sh](./ops/run_macos_smoke.sh)
- macOS smoke fixture bootstrap: [ops/bootstrap_macos_smoke_fixture.mjs](./ops/bootstrap_macos_smoke_fixture.mjs)
- macOS smoke stack runner: [ops/run_macos_smoke_stack.sh](./ops/run_macos_smoke_stack.sh)
- macOS smoke verdict summarizer: [ops/summarize_macos_smoke_stack.mjs](./ops/summarize_macos_smoke_stack.mjs)

## Bootstrap Order

1. `ops/remodex.env.example`를 `ops/remodex.env`로 복사하고 값을 채운다.
2. webhook fallback을 쓸 거면 `REMODEX_DISCORD_PUBLIC_KEY_PATH`를 채우고, canonical Gateway path만 쓸 거면 빈 값으로 둔 채 `REMODEX_DISCORD_BOT_TOKEN_PATH` 또는 `REMODEX_DISCORD_BOT_TOKEN`을 맞춘다.
3. canonical Gateway path를 쓸 경우 `REMODEX_DISCORD_APPLICATION_ID`와 가능하면 `REMODEX_DISCORD_GUILD_ID`도 채운다.
4. `CODEX_APP_SERVER_WS_URL`가 실제 Codex app-server listener와 맞는지 확인한다.
5. target OS에 맞는 `REMODEX_SCHEDULER_KIND`를 설정한 뒤 `node ops/render_scheduler_artifacts.mjs`로 scheduler artifact를 생성한다.
6. macOS면 `ops/install_launchd_services.sh`, Windows면 `ops/install_windows_scheduled_tasks.ps1`를 사용한다.
7. canonical Gateway path를 쓸 경우 `node ops/check_discord_gateway_live_preflight.mjs`로 live proof 전 자격증명/loopback/app-server 경계를 먼저 확인한다.
8. canonical Gateway path를 쓸 경우 `node ops/register_discord_commands.mjs`로 slash command를 등록한다.
9. target OS의 scheduler에서 bridge daemon, scheduler tick을 올린다.
10. canonical Gateway path를 상시 운영할 거면 `REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=true`로 두고 scheduler artifact를 다시 생성한다.
11. dashboard를 supervised service로 같이 올릴 거면 `REMODEX_ENABLE_DASHBOARD_SERVER=true`로 두고 scheduler artifact를 다시 생성한다.
12. `/health`, scheduler runtime, background trigger toggle, outbox/processed truth로 첫 상태를 확인한다.
13. canonical Discord ingress를 쓸 경우 `ops/run_discord_gateway_adapter.sh`를 별도 supervised process로 올리거나, proof 수집이 목적이면 `zsh ops/run_discord_gateway_live_proof.sh` 또는 `pwsh -File ops/run_discord_gateway_live_proof.ps1`로 `bundle + final summary`를 함께 남긴다.

## Ingress Boundary

이 문서의 bootstrap은 아래 경계까지만 직접 다룬다.

- local Codex app-server
- internal bridge daemon
- scheduler tick
- dashboard

정식 Discord ingress는 별도 adapter가 필요하다.

- canonical: Discord Gateway adapter
- fallback: public webhook relay + Discord facade

금지:

- raw bridge daemon을 public endpoint로 바로 노출
- tailnet 내부 IP를 Discord endpoint로 사용
- `tailscale serve`를 Discord webhook ingress로 오인

## Required Config

- `REMODEX_WORKSPACE`
- `REMODEX_SHARED_BASE`
- `REMODEX_WORKSPACE_KEY`
- `CODEX_APP_SERVER_WS_URL`
- `REMODEX_OPERATOR_HTTP_PORT`
- `REMODEX_DISCORD_BOT_TOKEN_PATH` 또는 `REMODEX_DISCORD_BOT_TOKEN`
- `REMODEX_DISCORD_APPLICATION_ID`

Fallback only:

- `REMODEX_DISCORD_PUBLIC_KEY_PATH`

권장:

- `REMODEX_NODE_BIN=/absolute/path/to/node`
- `REMODEX_SCHEDULER_KIND=launchd_launchagent`
- `REMODEX_SCHEDULER_INTERVAL_SECONDS=60`
- `REMODEX_LAUNCHD_LABEL_PREFIX=com.remodex`
- `REMODEX_WINDOWS_TASK_PREFIX=Remodex`
- `REMODEX_AUTO_CONSUME_HUMAN_GATE=false`
- `REMODEX_DISCORD_GATEWAY_URL=wss://gateway.discord.gg/?v=10&encoding=json`
- `REMODEX_DISCORD_GATEWAY_INTENTS=0`
- `REMODEX_DISCORD_API_BASE_URL=https://discord.com/api/v10`
- `REMODEX_DISCORD_GUILD_ID=<test guild id>`
- `REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER=false`
- `REMODEX_ENABLE_DASHBOARD_SERVER=false`

## First Validation

부팅 직후 최소 검증:

1. bridge daemon `/health`가 `ok: true`
2. `router/outbox`에 `status_response`가 생성 가능
3. foreground mode에서는 scheduler가 blocked reason으로 멈춤
4. background mode에서는 scheduler가 `dispatch_queue` 또는 `inbox` decision을 남김
5. 같은 `correlation_key`에 duplicate `consumed` 영수증이 생기지 않음

## Operational Warning

- app-server가 내려가 있으면 launchd만 살아도 실제 delivery는 안 된다.
- macOS `launchd`는 일반 shell `PATH`를 기대하면 안 되므로 `REMODEX_NODE_BIN`은 절대경로로 두는 편이 안전하다.
- foreground에서 작업 중인데 background toggle을 끄지 않으면 경쟁 조건이 생길 수 있다.
- `human_gate_candidates`가 남아 있으면 background가 아니라 foreground에서 먼저 닫아야 한다.
- `inflight_delivery.json`이 있는데 새 turn을 열면 duplicate replay 또는 duplicate receipt가 난다.
- macOS soak metrics에서 `ps` 수집은 현재 샌드박스 제약을 받을 수 있으므로, unattended 운영 전 최종 측정은 실제 호스트 권한으로 다시 확인해야 한다.
