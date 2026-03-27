# Production Bootstrap

이 문서는 Remodex를 검증용 probe 묶음이 아니라 실제 운영 서비스처럼 띄우는 최소 절차를 정리한다. 평시 운영 규칙은 [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md), 장애 대응은 [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)를 따른다.

## Included Assets

- env 샘플: [ops/remodex.env.example](./ops/remodex.env.example)
- bridge wrapper: [ops/run_bridge_daemon.sh](./ops/run_bridge_daemon.sh)
- scheduler wrapper: [ops/run_scheduler_tick.sh](./ops/run_scheduler_tick.sh)
- plist renderer: [ops/render_launchd_plists.mjs](./ops/render_launchd_plists.mjs)
- install helper: [ops/install_launchd_services.sh](./ops/install_launchd_services.sh)
- uninstall helper: [ops/uninstall_launchd_services.sh](./ops/uninstall_launchd_services.sh)

## Bootstrap Order

1. `ops/remodex.env.example`를 `ops/remodex.env`로 복사하고 값을 채운다.
2. `REMODEX_DISCORD_PUBLIC_KEY_PATH`를 실제 Discord public key 경로로 맞춘다.
3. `CODEX_APP_SERVER_WS_URL`가 실제 Codex app-server listener와 맞는지 확인한다.
4. `node ops/render_launchd_plists.mjs`로 launchd plist를 생성한다.
5. 필요하면 `ops/install_launchd_services.sh`를 실행해 `~/Library/LaunchAgents`로 복사한다.
6. `launchctl bootstrap ...`으로 bridge daemon, scheduler tick을 올린다.
7. `/health`, `runtime/launchd/*.log`, `state/background_trigger_toggle.json`, `runtime/scheduler_runtime.json`으로 첫 상태를 확인한다.

## Required Config

- `REMODEX_WORKSPACE`
- `REMODEX_SHARED_BASE`
- `REMODEX_WORKSPACE_KEY`
- `CODEX_APP_SERVER_WS_URL`
- `REMODEX_OPERATOR_HTTP_PORT`
- `REMODEX_DISCORD_PUBLIC_KEY_PATH`

권장:

- `REMODEX_NODE_BIN=/opt/homebrew/bin/node`
- `REMODEX_SCHEDULER_INTERVAL_SECONDS=60`
- `REMODEX_LAUNCHD_LABEL_PREFIX=com.remodex`
- `REMODEX_AUTO_CONSUME_HUMAN_GATE=false`

## First Validation

부팅 직후 최소 검증:

1. bridge daemon `/health`가 `ok: true`
2. `router/outbox`에 `status_response`가 생성 가능
3. foreground mode에서는 scheduler가 blocked reason으로 멈춤
4. background mode에서는 scheduler가 `dispatch_queue` 또는 `inbox` decision을 남김
5. 같은 `correlation_key`에 duplicate `consumed` 영수증이 생기지 않음

## Operational Warning

- app-server가 내려가 있으면 launchd만 살아도 실제 delivery는 안 된다.
- foreground에서 작업 중인데 background toggle을 끄지 않으면 경쟁 조건이 생길 수 있다.
- `human_gate_candidates`가 남아 있으면 background가 아니라 foreground에서 먼저 닫아야 한다.
- `inflight_delivery.json`이 있는데 새 turn을 열면 duplicate replay 또는 duplicate receipt가 난다.
