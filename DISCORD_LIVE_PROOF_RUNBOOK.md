# Discord Live Proof Runbook

이 문서는 `EP-950 / 11.3.2`를 실제 Discord 앱 자격증명으로 닫기 위한 절차를 정리한다.

목표:

- canonical ingress가 `Discord Gateway adapter` 경로로 실제로 붙는지 증명한다.
- `preflight -> command registration -> adapter READY -> operator interaction -> proof bundle`까지 한 번에 남긴다.
- 실패 시 원인이 자격증명, loopback 경계, command registration, interaction 미발생 중 어디인지 바로 분리한다.

연결 문서:

- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
- [EXECUTION_PLAN.md](./EXECUTION_PLAN.md)
- [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)

## Required Inputs

- `REMODEX_DISCORD_APPLICATION_ID`
- `REMODEX_DISCORD_BOT_TOKEN` 또는 `REMODEX_DISCORD_BOT_TOKEN_PATH`
- 가능하면 `REMODEX_DISCORD_GUILD_ID`
- `CODEX_APP_SERVER_WS_URL`
- loopback bridge/dashboard host 유지

권장:

- `REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS=true`
- `REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION=true`
- `REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS=120000`

## Proof Procedure

1. `ops/remodex.env`에 Discord application id, bot token path, guild id를 채운다.
2. `node ops/check_discord_gateway_live_preflight.mjs`를 먼저 실행한다.
3. blocker가 없으면 다음 중 하나를 실행한다.
   - macOS/Linux: `zsh ops/run_discord_gateway_live_proof.sh`
   - Windows: `pwsh -File ops/run_discord_gateway_live_proof.ps1`
4. `REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION=true`로 켰다면, timeout 안에 테스트 guild에서 slash command 하나를 실제로 실행한다.
   - 권장 첫 command: `/projects`
   - 또는 `/status project:<project-key>`
   - 채널 기본 프로젝트를 이미 `/use-project`로 바인딩했다면 `/status`만 실행해도 된다.
   - 반드시 **guild 채널에서 app slash command UI로 실행**한다.
   - DM 창이나 일반 텍스트 메시지 `/status project:...`는 proof interaction으로 잡히지 않는다.
5. wrapper는 runner 뒤에 finalizer를 자동으로 실행한다.
6. run이 끝나면 아래 두 파일을 같이 확인한다.
   - `runtime/live-discord-proof/live-proof-bundle.json`
   - `runtime/live-discord-proof/live-proof-final-summary.json`

## Pass Conditions

- `preflight.ok = true`
- `register_commands_result = completed` 또는 의도적으로 `skipped`
- `proof.ready_seen = true`
- `proof.interaction_observed = true` when `EXPECT_INTERACTION=true`
- bundle 전체 `ok = true`
- `live-proof-final-summary.json.ok = true`

## Primary Artifacts

- `runtime/live-discord-proof/live-proof-bundle.json`
- `runtime/live-discord-proof/live-proof-final-summary.json`
- `runtime/live-discord-proof/gateway-adapter.stdout.log`
- `runtime/live-discord-proof/gateway-adapter.stderr.log`
- `runtime/live-discord-proof/register-commands.stdout.log`
- `runtime/live-discord-proof/register-commands.stderr.log`
- shared memory:
  - `router/discord_gateway_adapter_state.json`
  - `router/discord_gateway_events.jsonl`

## Failure Split

### 1. preflight fail

의미:

- token, application id, guild id, app-server ws, loopback host 중 하나가 잘못됐다.

조치:

- `live-proof-bundle.json.phase = preflight`
- `blockers[]`를 그대로 수정한다.

### 2. register command fail

의미:

- bot token scope, application id, guild id, Discord API 권한 또는 네트워크 문제가 있다.

조치:

- `register-commands.stderr.log` 확인
- guild id를 먼저 쓰고, global 등록은 나중으로 미룬다.

### 3. adapter READY fail

의미:

- Gateway session, bot token, Discord API reachability, reconnect 경계에 문제가 있다.

조치:

- `gateway-adapter.stderr.log`
- `router/discord_gateway_adapter_state.json`
- `router/discord_gateway_events.jsonl`

### 4. interaction not observed

의미:

- adapter는 READY까지 갔지만 테스트 guild에서 실제 slash command가 안 들어왔다.

조치:

- guild command가 sync됐는지 확인
- timeout 안에 guild 채널에서 `/status` app command를 직접 실행
- 필요하면 `REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS`를 늘린다

### 5. final summary fail

의미:

- bundle은 생성됐지만 canonical pass 조건이 아직 충족되지 않았다.
- 대표적으로 `gateway_ready_not_observed`, `interaction_not_observed`, `live_proof_bundle_not_ok`가 blocker로 나온다.

조치:

- `live-proof-final-summary.json.blockers[]`를 우선 기준으로 본다.
- `recent_interactions`, `recent_outbox`, `recent_quarantine`를 같이 확인해 ingress, command, quarantine 문제를 분리한다.

## Notes

- canonical ingress proof는 raw bridge HTTP를 public edge로 노출하는 검증이 아니다.
- Gateway adapter는 production ingress고, bridge daemon은 계속 loopback internal surface여야 한다.
- `EXPECT_INTERACTION=false`로 먼저 READY-only proof를 찍고, 그 다음 interaction proof를 찍는 2단계 접근도 가능하다.
- 최종 pass/fail은 `live-proof-bundle.json` 하나가 아니라 `live-proof-final-summary.json`을 기준으로 판단한다.
