# Execution Plan

이 문서는 [STRATEGY.md](./STRATEGY.md) 를 수행 가능한 단위로 분해한 실행 계획이다.

전략 문서가 `불변 원칙`을 정의한다면, 이 문서는 `실행 순서`, `진행 상태`, `종료 조건`, `검증 연결`을 정의한다.

## Governing Documents

- 전략 원문: [STRATEGY.md](./STRATEGY.md)
- 메인 읽기 계약: [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md)
- 검증 근거: [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)
- 실행 분해 구조: [WBS.md](./WBS.md)
- 대시보드 명세: [DASHBOARD_MVP.md](./DASHBOARD_MVP.md)
- Windows 포팅 점검표: [WINDOWS_PORTABILITY_CHECKLIST.md](./WINDOWS_PORTABILITY_CHECKLIST.md)
- Windows bootstrap: [WINDOWS_BOOTSTRAP.md](./WINDOWS_BOOTSTRAP.md)
- macOS soak 계획: [MACOS_SOAK_TEST_PLAN.md](./MACOS_SOAK_TEST_PLAN.md)
- Discord live proof runbook: [DISCORD_LIVE_PROOF_RUNBOOK.md](./DISCORD_LIVE_PROOF_RUNBOOK.md)

## Status Legend

- `completed`: 산출물과 종료 조건이 충족됐다.
- `in_progress`: 현재 활성 배치다.
- `pending`: 아직 시작하지 않았다.
- `blocked`: 선행 조건 또는 외부 제약 때문에 진행 불가다.
- `deferred`: 지금은 뒤로 미뤘지만 범위에서 제외하지 않았다.
- `cancelled`: 범위에서 제거했다.

## Execution Control Rules

- 모든 실행 단위는 반드시 `status`를 가진다.
- 모든 실행 단위는 최소 1개의 전략 레퍼런스를 가진다.
- 모든 실행 단위는 가능하면 검증 근거 또는 필요한 검증 계획을 가진다.
- WBS leaf 상태가 바뀌면 이 문서의 대응 package 상태도 같이 갱신한다.
- 전략과 수행 계획이 충돌하면 `전략 불변식`이 우선이고, 수행 순서 충돌은 이 문서가 우선한다.

## Current Snapshot

- Strategy baseline: `Shared Working Memory Strategy v3`
- Execution plan version: `2026-03-29`
- Current phase: `Phase 16 - Discord Conversation Surface complete`
- Current active package: `none`
- Current active WBS: `none`
- Immediate next smallest batch:
  - `Windows 실제 실행 증거 수집 배치가 요청되면 시작`

## Phase Overview

| Phase | Goal | Status |
| --- | --- | --- |
| P0 | 전략 분해, traceability, WBS 통제면 수립 | `completed` |
| P1 | project-scoped state/control plane 기반 정리 | `completed` |
| P2 | bridge runtime과 dispatch 제어면 구현 | `completed` |
| P3 | Discord operator console ingress/egress 구현 | `completed` |
| P4 | scheduler/autonomy 경로 구현 | `completed` |
| P5 | human gate / recovery / same-thread continuation 구현 | `completed` |
| P6 | hardening, soak, operator runbook 정리 | `completed` |
| P7 | production bootstrap assets 정리 | `completed` |
| P8 | dashboard observability MVP 명세 및 구현 준비 | `completed` |
| P9 | 플랫폼 포팅 점검과 자원 안정성 계획 | `completed` |
| P10 | Windows adapter 구현과 macOS soak 실행 | `completed` |
| P11 | Discord Gateway ingress 정식 경계 구현 | `completed` |
| P12 | Discord operator UX 개선 | `completed` |
| P13 | Discord component UX 개선 | `completed` |
| P14 | Discord existing-thread attach UX 개선 | `completed` |
| P15 | Discord foreground/background mode toggle UX 개선 | `completed` |

## Work Packages

### EP-000 Strategy Decomposition And Traceability

- Status: `completed`
- WBS refs: `1.1`, `1.2`, `1.3`
- Strategy refs:
  - [Core Principles](./STRATEGY.md#core-principles)
  - [Recommended Score Rubric](./STRATEGY.md#recommended-score-rubric)
- Deliverables:
  - [EXECUTION_PLAN.md](./EXECUTION_PLAN.md)
  - [WBS.md](./WBS.md)
  - strategy 상호 참조
- Exit criteria:
  - 전략 -> 계획 -> WBS traceability가 양방향으로 연결됨
  - 모든 package와 WBS leaf가 status를 가짐

### EP-110 Project Namespace Bootstrap Runtime

- Status: `completed`
- WBS refs: `2.1`
- Strategy refs:
  - [Routing And Namespace Rule](./STRATEGY.md#routing-and-namespace-rule)
  - [Directory Layout](./STRATEGY.md#directory-layout)
  - [State Ownership](./STRATEGY.md#state-ownership)
- Validation basis:
  - [Probe 7](./verification/VERIFICATION_LOG.md#2026-03-25---probe-7-multi-project-routing-isolation-alpha--beta--quarantine)
  - [Probe 23](./verification/VERIFICATION_LOG.md#2026-03-26---probe-23-multi-project-recovery-router)
- Exit criteria:
  - workspace/project namespace bootstrap 코드가 canonical layout을 만들 수 있음
  - project mismatch와 unresolved route를 fail-closed 처리함

### EP-120 Coordinator Lease And Binding Runtime

- Status: `completed`
- WBS refs: `2.2`
- Strategy refs:
  - [Coordinator Lease Rule](./STRATEGY.md#coordinator-lease-rule)
  - [Coordinator Lease Schema](./STRATEGY.md#coordinator-lease-schema)
  - [Main Coordinator Protocol](./STRATEGY.md#main-coordinator-protocol)
- Validation basis:
  - [Probe 2](./verification/VERIFICATION_LOG.md#2026-03-25---probe-2-thread-resume--reconnect)
  - [Probe 19](./verification/VERIFICATION_LOG.md#2026-03-25---probe-19-bridge-fail-closed-on-missing-or-mismatched-binding)
- Exit criteria:
  - thread binding, resume, lease ownership 확인이 코드 경계로 정리됨
  - missing binding / project mismatch가 dispatch 전에 차단됨

### EP-130 Coordinator Status Mirror

- Status: `completed`
- WBS refs: `2.3`
- Strategy refs:
  - [Coordinator Status Schema](./STRATEGY.md#coordinator-status-schema)
  - [Coordinator Delivery State Rule](./STRATEGY.md#coordinator-delivery-state-rule)
- Validation basis:
  - [Probe 14](./verification/VERIFICATION_LOG.md#2026-03-25---probe-14-status-mirror-from-real-app-server-notifications)
- Exit criteria:
  - app-server `thread/status/changed`를 local state truth로 반영함
  - approval/waiting flags를 loop-safe하게 반영함

### EP-140 Processed Dedupe Core

- Status: `completed`
- WBS refs: `2.4`
- Strategy refs:
  - [Processed Receipt Schema](./STRATEGY.md#processed-receipt-schema)
  - [Machine-Checkable Processed Dedupe Guard](./STRATEGY.md#machine-checkable-processed-dedupe-guard)
  - [Idempotency and Dedupe](./STRATEGY.md#idempotency-and-dedupe)
- Validation basis:
  - [Probe 27](./verification/VERIFICATION_LOG.md#2026-03-26---probe-27-processedcorrelationkey-dedupe)
  - [Probe 31](./verification/VERIFICATION_LOG.md#2026-03-26---probe-31-processed-receipt--index-consistency)
  - [Probe 42](./verification/VERIFICATION_LOG.md#2026-03-26---probe-42-same-thread-post-approval-drain-with-processed-receipt--recovery-dedupe)
- Exit criteria:
  - foreground/background/recovery가 동일한 correlation dedupe를 사용함
  - duplicate replay가 code path상 구조적으로 차단됨

### EP-210 Bridge Runtime Skeleton

- Status: `completed`
- WBS refs: `3.1`
- Strategy refs:
  - [Bridge Protocol](./STRATEGY.md#bridge-protocol)
  - [Coordinator Delivery State Rule](./STRATEGY.md#coordinator-delivery-state-rule)
  - [Dispatch Queue Rule](./STRATEGY.md#dispatch-queue-rule)
  - [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern)
- Validation basis:
  - [Probe 18](./verification/VERIFICATION_LOG.md#2026-03-25---probe-18-inbox-event---bridge-dispatch---same-thread-follow-up-turn)
  - [Probe 19](./verification/VERIFICATION_LOG.md#2026-03-25---probe-19-bridge-fail-closed-on-missing-or-mismatched-binding)
  - [Probe 43](./verification/VERIFICATION_LOG.md#2026-03-26---probe-43-project-local-conversation-bridge-thread)
  - [Probe 44](./verification/VERIFICATION_LOG.md#2026-03-27---probe-44-bridge-daemon-signed-ingress---async-delivery)
- Progress evidence:
  - 공용 helper 추출: [scripts/lib/app_server_jsonrpc.mjs](./scripts/lib/app_server_jsonrpc.mjs)
  - shared memory runtime: [scripts/lib/shared_memory_runtime.mjs](./scripts/lib/shared_memory_runtime.mjs)
  - bridge runtime: [scripts/lib/bridge_runtime.mjs](./scripts/lib/bridge_runtime.mjs)
  - daemon entry: [scripts/remodex_bridge_daemon.mjs](./scripts/remodex_bridge_daemon.mjs)
- Exit criteria:
  - bridge runtime이 `status`, `intent`, `reply`, `approve-candidate` 입력을 공통 경로로 처리함
  - direct injection 없이 inbox/dispatch만 사용함
  - conversation bridge thread를 optional operator surface로 붙일 수 있음

### EP-220 Shared-Memory Status Responder

- Status: `completed`
- WBS refs: `3.2`
- Strategy refs:
  - [Main Situational Awareness Rule](./STRATEGY.md#main-situational-awareness-rule)
  - [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern)
- Validation basis:
  - [Probe 6](./verification/VERIFICATION_LOG.md#2026-03-25---probe-6-shared-memory-contract-reconstruction-continue--halt)
  - [Probe 43](./verification/VERIFICATION_LOG.md#2026-03-26---probe-43-project-local-conversation-bridge-thread)
  - [Probe 44](./verification/VERIFICATION_LOG.md#2026-03-27---probe-44-bridge-daemon-signed-ingress---async-delivery)
- Exit criteria:
  - bridge가 snapshot 기반 `/status` 응답을 생성함
  - refresh 없이 답할 수 있는 질문과 main refresh가 필요한 질문을 구분함

### EP-230 Intent Normalization And Inbox Write

- Status: `completed`
- WBS refs: `3.3`
- Strategy refs:
  - [Intent Schema](./STRATEGY.md#intent-schema)
  - [Persistence vs Delivery Rule](./STRATEGY.md#persistence-vs-delivery-rule)
- Validation basis:
  - [Probe 12](./verification/VERIFICATION_LOG.md#2026-03-25---probe-12-discord-ingress-normalization-and-routing)
  - [Probe 32](./verification/VERIFICATION_LOG.md#2026-03-26---probe-32-discord-operator-roundtrip)
  - [Probe 44](./verification/VERIFICATION_LOG.md#2026-03-27---probe-44-bridge-daemon-signed-ingress---async-delivery)
- Exit criteria:
  - operator 입력이 canonical inbox event로 정규화됨
  - source_ref / correlation_key / target_thread가 빠지지 않음

### EP-240 Dispatch Queue Arbitration

- Status: `completed`
- WBS refs: `3.4`
- Strategy refs:
  - [Coordinator Delivery State Rule](./STRATEGY.md#coordinator-delivery-state-rule)
  - [Dispatch Queue Rule](./STRATEGY.md#dispatch-queue-rule)
- Validation basis:
  - [Probe 8](./verification/VERIFICATION_LOG.md#2026-03-25---probe-8-dispatch-timing-arbitration-busy---queue---checkpoint---deliver)
  - [Probe 22](./verification/VERIFICATION_LOG.md#2026-03-26---probe-22-foreground-activebridge-defer)
  - [Probe 45](./verification/VERIFICATION_LOG.md#2026-03-27---probe-45-scheduler-runtime-blocked-vs-delivered-with-completion-fallback)
- Exit criteria:
  - busy/checkpoint/waiting 상태별 전달 규칙이 구현됨
  - foreground active면 defer, checkpoint면 deliver가 안정적으로 분기됨

### EP-310 Discord Signed Ingress

- Status: `completed`
- WBS refs: `4.1`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule)
- Validation basis:
  - [Probe 15](./verification/VERIFICATION_LOG.md#2026-03-25---probe-15-discord-style-signature-verification-and-replay-rejection)
  - [Probe 30](./verification/VERIFICATION_LOG.md#2026-03-26---probe-30-discord-transport-end-to-end)
  - [Probe 44](./verification/VERIFICATION_LOG.md#2026-03-27---probe-44-bridge-daemon-signed-ingress---async-delivery)
- Exit criteria:
  - signature verification, replay rejection, quarantine routing이 live ingress에서 동작함

### EP-320 Discord Outbound Operator Replies

- Status: `completed`
- WBS refs: `4.2`
- Strategy refs:
  - [Mode F: Discord + Cron Operator Console Mode](./STRATEGY.md#mode-f-discord--cron-operator-console-mode)
  - [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern)
- Validation basis:
  - [Probe 32](./verification/VERIFICATION_LOG.md#2026-03-26---probe-32-discord-operator-roundtrip)
  - [Probe 43](./verification/VERIFICATION_LOG.md#2026-03-26---probe-43-project-local-conversation-bridge-thread)
  - [Probe 44](./verification/VERIFICATION_LOG.md#2026-03-27---probe-44-bridge-daemon-signed-ingress---async-delivery)
  - [Probe 46](./verification/VERIFICATION_LOG.md#2026-03-27---probe-46-bridge-daemon-delivery-with-foreground-owned-human-gate-closure)
- Exit criteria:
  - bridge가 상태 답변, human gate 알림, next batch 요약을 Discord로 보낼 수 있음

### EP-410 Scheduler Runtime And Trigger Loop

- Status: `completed`
- WBS refs: `5.1`
- Strategy refs:
  - [Scheduler Runtime Schema](./STRATEGY.md#scheduler-runtime-schema)
  - [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule)
  - [Autonomous Trigger Mode](./STRATEGY.md#mode-g-autonomous-trigger-mode)
- Validation basis:
  - [Probe 4](./verification/VERIFICATION_LOG.md#2026-03-25---probe-4-real-launchd-registration--periodic-tick--bootout)
  - [Probe 5](./verification/VERIFICATION_LOG.md#2026-03-25---probe-5-one-shot-launchd---app-server---resumed-thread-turn)
  - [Probe 35](./verification/VERIFICATION_LOG.md#2026-03-26---probe-35-launchd-tick-after-discord-ingress)
  - [Probe 45](./verification/VERIFICATION_LOG.md#2026-03-27---probe-45-scheduler-runtime-blocked-vs-delivered-with-completion-fallback)
- Exit criteria:
  - launchd/bridge/runtime이 같은 truth를 읽고 wake를 생성함
  - scheduler는 lightweight precheck만 하고 deep 판단은 메인에 남김

### EP-420 Foreground/Background Arbitration

- Status: `completed`
- WBS refs: `5.2`
- Strategy refs:
  - [Background Trigger Toggle Schema](./STRATEGY.md#background-trigger-toggle-schema)
  - [Autonomous Night Shift Gate](./STRATEGY.md#autonomous-night-shift-gate)
- Validation basis:
  - [Probe 3](./verification/VERIFICATION_LOG.md#2026-03-25---probe-3-scheduler-gate-precheck--conditional-wake)
  - [Probe 21](./verification/VERIFICATION_LOG.md#2026-03-26---probe-21-foreground-return-blocks-background-scheduler)
  - [Probe 22](./verification/VERIFICATION_LOG.md#2026-03-26---probe-22-foreground-activebridge-defer)
- Exit criteria:
  - foreground active면 background wake와 dispatch가 구조적으로 차단됨

### EP-510 Human Gate Closure

- Status: `completed`
- WBS refs: `6.1`
- Strategy refs:
  - [Human Gate](./STRATEGY.md#human-gate)
  - [State Ownership](./STRATEGY.md#state-ownership)
- Validation basis:
  - [Probe 37](./verification/VERIFICATION_LOG.md#2026-03-26---probe-37-discord-human-gate-closure-to-live-app-server-approval)
  - [Probe 40](./verification/VERIFICATION_LOG.md#2026-03-26---probe-40-launchd-human-gate-candidate-fail-closed)
  - [Probe 46](./verification/VERIFICATION_LOG.md#2026-03-27---probe-46-bridge-daemon-delivery-with-foreground-owned-human-gate-closure)
- Exit criteria:
  - background는 candidate를 관측만 하고
  - foreground만 approval closure를 live app-server로 연결함

### EP-520 Post-Approval Same-Thread Drain

- Status: `completed`
- WBS refs: `6.2`
- Strategy refs:
  - [Dispatch Queue Rule](./STRATEGY.md#dispatch-queue-rule)
  - [Human Gate](./STRATEGY.md#human-gate)
  - [Restart Recovery](./STRATEGY.md#restart-recovery)
- Validation basis:
  - [Probe 41](./verification/VERIFICATION_LOG.md#2026-03-26---probe-41-same-thread-unread-inbox-drain-after-approval-lane)
  - [Probe 42](./verification/VERIFICATION_LOG.md#2026-03-26---probe-42-same-thread-post-approval-drain-with-processed-receipt--recovery-dedupe)
- Exit criteria:
  - approval lane 뒤 ordinary unread를 same-thread next turn으로 drain함
  - drain path도 processed receipt/index를 남김

### EP-530 Restart Recovery And Replay Safety

- Status: `completed`
- WBS refs: `6.3`
- Strategy refs:
  - [Restart Recovery](./STRATEGY.md#restart-recovery)
  - [Idempotency and Dedupe](./STRATEGY.md#idempotency-and-dedupe)
- Validation basis:
  - [Probe 20](./verification/VERIFICATION_LOG.md#2026-03-26---probe-20-restart-recovery-via-threadread--threadresume--inbox-replay)
  - [Probe 38](./verification/VERIFICATION_LOG.md#2026-03-26---probe-38-human-gate-candidate-processed-receipt--recovery-dedupe)
  - [Probe 42](./verification/VERIFICATION_LOG.md#2026-03-26---probe-42-same-thread-post-approval-drain-with-processed-receipt--recovery-dedupe)
- Exit criteria:
  - recovery/router가 unread replay 전에 processed truth를 먼저 확인함
  - duplicate skip도 audit 가능한 receipt로 남김

### EP-540 Multi-Project Isolation

- Status: `completed`
- WBS refs: `6.4`
- Strategy refs:
  - [Multi-Project Namespace Rule](./STRATEGY.md#multi-project-namespace-rule)
  - [Portfolio Router Rule](./STRATEGY.md#portfolio-router-rule)
- Validation basis:
  - [Probe 24](./verification/VERIFICATION_LOG.md#2026-03-26---probe-24-multi-project-human-gate-isolation)
  - [Probe 39](./verification/VERIFICATION_LOG.md#2026-03-26---probe-39-multi-project-foreground-approval-takeover)
- Exit criteria:
  - blocked project가 다른 project replay를 멈추지 않음
  - approval lane과 ordinary lane이 project별로 분리됨

### EP-610 Hardening, Soak, And Runbooks

- Status: `completed`
- WBS refs: `7.1`, `7.2`, `7.3`
- Strategy refs:
  - [Validation](./STRATEGY.md#validation)
  - [Failure Signals](./STRATEGY.md#failure-signals)
  - [Go / No-Go](./STRATEGY.md#go--no-go)
- Validation plan:
  - [Probe 47](./verification/VERIFICATION_LOG.md#2026-03-27---probe-47-app-server-turnstart-overload-backoff)
  - [Probe 48](./verification/VERIFICATION_LOG.md#2026-03-27---probe-48-bridge-runtime-inflight-recovery)
  - [Probe 49](./verification/VERIFICATION_LOG.md#2026-03-27---probe-49-bridge-daemon-human-gate-notification-dedupe)
  - [Probe 50](./verification/VERIFICATION_LOG.md#2026-03-27---probe-50-scheduler-long-run-churn)
  - [Probe 51](./verification/VERIFICATION_LOG.md#2026-03-27---probe-51-operator-ingress-churn-with-inflight-completion-and-post-turn-receipt-dedupe)
- Deliverables:
  - [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
  - [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)
- Exit criteria:
  - 장시간 운영 기준 위험 항목이 runbook과 soak evidence로 닫힘

## Current Active Package Detail

### EP-610

- Status: `completed`
- Reason:
  - functional control-plane은 실증 기준으로 닫혔다.
  - overload/backoff, inflight recovery, notification dedupe, scheduler churn, operator ingress churn까지 runtime+probe 기준으로 닫혔다.
  - 정상 운영 매뉴얼과 incident / recovery runbook도 문서화됐다.
- Current next smallest batch:
  1. none
- Exit signal:
  - hardening risk가 soak evidence와 runbook 초안으로 관리 가능 수준까지 내려감

### EP-710 Production Bootstrap Assets

- Status: `completed`
- WBS refs: `8.1`
- Strategy refs:
  - [Background Cron Toggle Rule](./MAIN_COORDINATOR_PROMPT_CONTRACT.md#background-cron-toggle-rule)
  - [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule)
  - [Scheduler Runtime Schema](./STRATEGY.md#scheduler-runtime-schema)
- Deliverables:
  - [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
  - [ops/remodex.env.example](./ops/remodex.env.example)
  - [ops/run_bridge_daemon.sh](./ops/run_bridge_daemon.sh)
  - [ops/run_scheduler_tick.sh](./ops/run_scheduler_tick.sh)
  - [ops/render_launchd_plists.mjs](./ops/render_launchd_plists.mjs)
  - [ops/install_launchd_services.sh](./ops/install_launchd_services.sh)
  - [ops/uninstall_launchd_services.sh](./ops/uninstall_launchd_services.sh)
- Validation basis:
  - [Probe 52](./verification/VERIFICATION_LOG.md#2026-03-27---probe-52-production-bootstrap-asset-validation)
- Exit criteria:
  - 운영자가 probe 파일이 아니라 실제 launchd asset으로 bridge/scheduler를 설치할 수 있음
  - env example, wrapper, plist renderer, bootstrap 문서가 서로 일치함

### EP-810 Dashboard Observability MVP Spec

- Status: `completed`
- WBS refs: `9.1`
- Strategy refs:
  - [Observability Dashboard Rule](./STRATEGY.md#observability-dashboard-rule)
  - [Multi-Project Namespace Rule](./STRATEGY.md#multi-project-namespace-rule)
  - [Main Situational Awareness Rule](./STRATEGY.md#main-situational-awareness-rule)
- Deliverables:
  - [DASHBOARD_MVP.md](./DASHBOARD_MVP.md)
  - strategy / README / execution traceability 반영
- Exit criteria:
  - 대시보드가 read-only observability layer라는 경계가 문서에 고정됨
  - MVP 화면, 데이터 소스, refresh 모델, 비목표가 정의됨

### EP-820 Dashboard Read Model And UI

- Status: `completed`
- WBS refs: `9.2`
- Strategy refs:
  - [Observability Dashboard Rule](./STRATEGY.md#observability-dashboard-rule)
  - [Routing And Namespace Rule](./STRATEGY.md#routing-and-namespace-rule)
  - [Scheduler Runtime Schema](./STRATEGY.md#scheduler-runtime-schema)
- Deliverables:
  - [scripts/lib/dashboard_read_model.mjs](./scripts/lib/dashboard_read_model.mjs)
  - [scripts/remodex_dashboard_server.mjs](./scripts/remodex_dashboard_server.mjs)
  - [DASHBOARD_MVP.md](./DASHBOARD_MVP.md)
- Validation basis:
  - [Probe 53](./verification/VERIFICATION_LOG.md#2026-03-27---probe-53-dashboard-read-model-portfolio--detail--timeline--human-gate--incident)
  - [Probe 54](./verification/VERIFICATION_LOG.md#2026-03-27---probe-54-dashboard-http-root--json-endpoints)
- Exit criteria:
  - portfolio snapshot이 shared memory truth와 일치함
  - human gate / blocked reason / last processed가 project별로 정확히 보임
  - HTML root와 JSON endpoint가 read-only로 응답함

### EP-910 Windows Portability Assessment

- Status: `completed`
- WBS refs: `10.1`
- Strategy refs:
  - [Platform Portability Rule](./STRATEGY.md#platform-portability-rule)
  - [Execution Modes](./STRATEGY.md#execution-modes)
  - [Go / No-Go](./STRATEGY.md#go--no-go)
- Deliverables:
  - [WINDOWS_PORTABILITY_CHECKLIST.md](./WINDOWS_PORTABILITY_CHECKLIST.md)
  - README / strategy / execution traceability 반영
- Exit criteria:
  - 현재 구현이 왜 macOS-first인지와 Windows gap이 명확히 문서화됨
  - portable core와 OS adapter 경계가 분리됨
  - Windows pilot의 Go / No-Go가 정의됨

### EP-920 macOS Resource Safety And Soak Plan

- Status: `completed`
- WBS refs: `10.2`
- Strategy refs:
  - [Resource Safety Rule](./STRATEGY.md#resource-safety-rule)
  - [Validation](./STRATEGY.md#validation)
  - [Failure Signals](./STRATEGY.md#failure-signals)
- Deliverables:
  - [MACOS_SOAK_TEST_PLAN.md](./MACOS_SOAK_TEST_PLAN.md)
  - README / strategy / execution traceability 반영
- Exit criteria:
  - 30min / 6h / 24h soak 단계와 수집 지표가 정의됨
  - hard failure 기준과 acceptance threshold가 문서화됨
  - unattended 운영 전 요구 증거가 명확해짐

### EP-930 Windows Runtime Adapter

- Status: `completed`
- WBS refs: `10.3`
- Strategy refs:
  - [Platform Portability Rule](./STRATEGY.md#platform-portability-rule)
  - [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule)
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
- Validation basis:
  - [Probe 55](./verification/VERIFICATION_LOG.md#2026-03-27---probe-55-scheduler-adapter-abstraction)
  - [Probe 56](./verification/VERIFICATION_LOG.md#2026-03-27---probe-56-windows-bootstrap-assets-and-path-normalization)
- Deliverables:
  - Windows scheduler adapter
  - PowerShell wrapper set
  - path/env normalization
  - Windows bootstrap document
- Exit criteria:
  - launchd 의존 없이 Windows에서 bridge/scheduler bootstrap 가능
  - 핵심 런타임 entrypoint가 OS-agnostic path resolution을 사용
- Progress evidence:
  - [ops/lib/scheduler_adapter.mjs](./ops/lib/scheduler_adapter.mjs)
  - [ops/render_scheduler_artifacts.mjs](./ops/render_scheduler_artifacts.mjs)
  - launchd helper가 unsupported scheduler kind에서 fail-closed
  - [ops/lib/RemodexEnv.ps1](./ops/lib/RemodexEnv.ps1)
  - [ops/run_bridge_daemon.ps1](./ops/run_bridge_daemon.ps1)
  - [ops/run_scheduler_tick.ps1](./ops/run_scheduler_tick.ps1)
  - [ops/install_windows_scheduled_tasks.ps1](./ops/install_windows_scheduled_tasks.ps1)
  - [ops/uninstall_windows_scheduled_tasks.ps1](./ops/uninstall_windows_scheduled_tasks.ps1)
  - [WINDOWS_BOOTSTRAP.md](./WINDOWS_BOOTSTRAP.md)

### EP-940 macOS Soak Execution

- Status: `completed`
- WBS refs: `10.4`
- Strategy refs:
  - [Resource Safety Rule](./STRATEGY.md#resource-safety-rule)
  - [Validation](./STRATEGY.md#validation)
  - [Go / No-Go](./STRATEGY.md#go--no-go)
- Validation basis:
  - [Probe 57](./verification/VERIFICATION_LOG.md#2026-03-27---probe-57-macos-smoke-bootstrap-and-metrics-collection)
  - [Probe 58](./verification/VERIFICATION_LOG.md#2026-03-27---probe-58-macos-smoke-stack-assets-and-fixture-bootstrap)
  - [Probe 59](./verification/VERIFICATION_LOG.md#2026-03-27---probe-59-1s-host-side-macos-smoke-stack)
  - [Probe 60](./verification/VERIFICATION_LOG.md#2026-03-27---probe-60-30min-host-side-macos-smoke-stack)
  - [Probe 61](./verification/VERIFICATION_LOG.md#2026-03-27---probe-61-short-host-side-macos-churn-stack)
  - [Probe 62](./verification/VERIFICATION_LOG.md#2026-03-28---probe-62-6h-host-side-macos-churn-stack)
  - [Probe 63](./verification/VERIFICATION_LOG.md#2026-03-28---probe-63-macos-churn-graceful-shutdown-drain)
  - [Probe 64](./verification/VERIFICATION_LOG.md#2026-03-28---probe-64-24h-overnight-runtime-checkpoint)
  - [Probe 70](./verification/VERIFICATION_LOG.md#2026-03-28---probe-70-24h-overnight-final-verdict-collection)
- Deliverables:
  - 30min smoke evidence
  - 6h churn evidence
  - graceful shutdown/drain evidence
  - 24h overnight evidence
  - soak summary verdict
- Progress evidence:
  - [MACOS_SOAK_TEST_PLAN.md](./MACOS_SOAK_TEST_PLAN.md)
  - [ops/collect_macos_runtime_metrics.sh](./ops/collect_macos_runtime_metrics.sh)
  - [ops/run_macos_smoke.sh](./ops/run_macos_smoke.sh)
  - [ops/run_dashboard_server.sh](./ops/run_dashboard_server.sh)
  - [ops/bootstrap_macos_smoke_fixture.mjs](./ops/bootstrap_macos_smoke_fixture.mjs)
  - [ops/run_macos_smoke_stack.sh](./ops/run_macos_smoke_stack.sh)
  - [ops/summarize_macos_smoke_stack.mjs](./ops/summarize_macos_smoke_stack.mjs)
  - [ops/bootstrap_macos_churn_fixture.mjs](./ops/bootstrap_macos_churn_fixture.mjs)
  - [ops/run_macos_churn_driver.mjs](./ops/run_macos_churn_driver.mjs)
  - [ops/run_macos_churn_stack.sh](./ops/run_macos_churn_stack.sh)
  - [ops/summarize_macos_churn_stack.mjs](./ops/summarize_macos_churn_stack.mjs)
  - [ops/drain_macos_churn_shutdown.mjs](./ops/drain_macos_churn_shutdown.mjs)
  - [ops/finalize_macos_churn_stack.mjs](./ops/finalize_macos_churn_stack.mjs)
  - [verification/macos_24h_overnight_stack_summary.json](./verification/macos_24h_overnight_stack_summary.json)
  - [verification/macos_24h_shutdown_drain_summary.json](./verification/macos_24h_shutdown_drain_summary.json)
  - [verification/macos_24h_overnight_final_verdict_probe_summary.json](./verification/macos_24h_overnight_final_verdict_probe_summary.json)
- Exit criteria:
  - metrics artifact가 수집됨
  - duplicate replay / orphan process / runaway growth가 없는지 판정됨
  - 최종 청결성은 `shutdown_drain_summary.json`까지 포함해 판정됨

### EP-950 Discord Gateway Ingress

- Status: `completed`
- WBS refs: `11.1`, `11.2`, `11.3`
- Strategy refs:
  - [Ingress Architecture Decision](./STRATEGY.md#ingress-architecture-decision)
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule)
- Validation basis:
  - Discord Gateway live ingress evidence
  - interaction ack / follow-up response evidence
  - no-public-raw-bridge exposure evidence
  - [Probe 71](./verification/VERIFICATION_LOG.md#2026-03-28---probe-71-discord-gateway-live-preflight-assets)
  - [Probe 72](./verification/VERIFICATION_LOG.md#2026-03-28---probe-72-discord-gateway-live-proof-harness-assets)
  - [Probe 73](./verification/VERIFICATION_LOG.md#2026-03-28---probe-73-discord-live-proof-wrapper-and-runbook-assets)
  - [Probe 74](./verification/VERIFICATION_LOG.md#2026-03-28---probe-74-discord-gateway-adapter-near-live-integration)
  - [Probe 75](./verification/VERIFICATION_LOG.md#2026-03-28---probe-75-discord-gateway-bootstrap-assets-integration)
  - [Probe 76](./verification/VERIFICATION_LOG.md#2026-03-28---probe-76-dashboard-gateway-observability)
  - [Probe 77](./verification/VERIFICATION_LOG.md#2026-03-28---probe-77-discord-live-proof-finalizer)
  - [Probe 79](./verification/VERIFICATION_LOG.md#2026-03-29---probe-79-live-discord-preflight-registration-and-gateway-ready)
  - [Probe 80](./verification/VERIFICATION_LOG.md#2026-03-29---probe-80-end-to-end-discord-live-ingress-proof)
- Progress evidence:
  - [scripts/lib/discord_gateway_session.mjs](./scripts/lib/discord_gateway_session.mjs)
  - [scripts/lib/discord_gateway_adapter_runtime.mjs](./scripts/lib/discord_gateway_adapter_runtime.mjs)
  - [scripts/lib/discord_interaction_callback_transport.mjs](./scripts/lib/discord_interaction_callback_transport.mjs)
  - [scripts/lib/discord_gateway_operator_responder.mjs](./scripts/lib/discord_gateway_operator_responder.mjs)
  - [scripts/lib/shared_memory_runtime.mjs](./scripts/lib/shared_memory_runtime.mjs)
  - [scripts/remodex_discord_gateway_adapter.mjs](./scripts/remodex_discord_gateway_adapter.mjs)
  - [ops/lib/scheduler_adapter.mjs](./ops/lib/scheduler_adapter.mjs)
  - [ops/run_discord_gateway_adapter.sh](./ops/run_discord_gateway_adapter.sh)
  - [ops/run_discord_gateway_adapter.ps1](./ops/run_discord_gateway_adapter.ps1)
  - [ops/install_launchd_services.sh](./ops/install_launchd_services.sh)
  - [ops/uninstall_launchd_services.sh](./ops/uninstall_launchd_services.sh)
  - [ops/install_windows_scheduled_tasks.ps1](./ops/install_windows_scheduled_tasks.ps1)
  - [ops/uninstall_windows_scheduled_tasks.ps1](./ops/uninstall_windows_scheduled_tasks.ps1)
  - [ops/check_discord_gateway_live_preflight.mjs](./ops/check_discord_gateway_live_preflight.mjs)
  - [ops/run_discord_gateway_live_proof.mjs](./ops/run_discord_gateway_live_proof.mjs)
  - [ops/finalize_discord_gateway_live_proof.mjs](./ops/finalize_discord_gateway_live_proof.mjs)
  - [ops/run_discord_gateway_live_proof.sh](./ops/run_discord_gateway_live_proof.sh)
  - [ops/run_discord_gateway_live_proof.ps1](./ops/run_discord_gateway_live_proof.ps1)
  - [ops/register_discord_commands.mjs](./ops/register_discord_commands.mjs)
  - [DISCORD_LIVE_PROOF_RUNBOOK.md](./DISCORD_LIVE_PROOF_RUNBOOK.md)
  - [verification/discord_gateway_session_probe_summary.json](./verification/discord_gateway_session_probe_summary.json)
  - [verification/discord_gateway_callback_transport_probe_summary.json](./verification/discord_gateway_callback_transport_probe_summary.json)
  - [verification/discord_gateway_command_mapping_probe_summary.json](./verification/discord_gateway_command_mapping_probe_summary.json)
  - [verification/no_public_raw_bridge_exposure_probe_summary.json](./verification/no_public_raw_bridge_exposure_probe_summary.json)
  - [verification/discord_command_registration_assets_probe_summary.json](./verification/discord_command_registration_assets_probe_summary.json)
  - [verification/discord_gateway_live_preflight_probe_summary.json](./verification/discord_gateway_live_preflight_probe_summary.json)
  - [verification/discord_gateway_live_proof_assets_probe_summary.json](./verification/discord_gateway_live_proof_assets_probe_summary.json)
  - [verification/discord_live_proof_wrapper_assets_probe_summary.json](./verification/discord_live_proof_wrapper_assets_probe_summary.json)
  - [verification/discord_gateway_adapter_near_live_probe_summary.json](./verification/discord_gateway_adapter_near_live_probe_summary.json)
  - [verification/discord_gateway_bootstrap_assets_probe_summary.json](./verification/discord_gateway_bootstrap_assets_probe_summary.json)
  - [verification/dashboard_gateway_observability_probe_summary.json](./verification/dashboard_gateway_observability_probe_summary.json)
  - [verification/discord_gateway_live_proof_finalizer_probe_summary.json](./verification/discord_gateway_live_proof_finalizer_probe_summary.json)
- Deliverables:
  - Discord Gateway adapter
  - Gateway event normalization to shared memory
  - operator reply / status / approval response transport
  - production ingress bootstrap and runbook
  - live proof final summary collector
- Exit criteria:
  - Discord가 public webhook 없이 로컬 노드와 안정적으로 왕복한다
  - raw bridge daemon은 loopback-only 상태를 유지한다
  - operator status / intent / reply / approval candidate가 Gateway 경로로 same-thread delivery까지 이어진다
  - live Discord 자격증명으로 same path를 external edge까지 닫은 증거가 확보된다
  - live guild slash command 1건이 final summary `ok = true`로 수집된다

### EP-960 Discord Operator UX

- Status: `completed`
- WBS refs: `12.1`, `12.2`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule)
- Validation basis:
  - [Probe 82](./verification/VERIFICATION_LOG.md#2026-03-29---probe-82-discord-project-selection-ux)
  - [Probe 83](./verification/VERIFICATION_LOG.md#2026-03-29---probe-83-discord-command-registration-assets-refresh)
- Progress evidence:
  - [scripts/lib/discord_command_manifest.mjs](./scripts/lib/discord_command_manifest.mjs)
  - [scripts/lib/discord_transport.mjs](./scripts/lib/discord_transport.mjs)
  - [scripts/lib/discord_gateway_adapter_runtime.mjs](./scripts/lib/discord_gateway_adapter_runtime.mjs)
  - [scripts/lib/discord_gateway_operator_responder.mjs](./scripts/lib/discord_gateway_operator_responder.mjs)
  - [scripts/lib/discord_interaction_callback_transport.mjs](./scripts/lib/discord_interaction_callback_transport.mjs)
  - [scripts/probe_discord_project_selection_ux.mjs](./scripts/probe_discord_project_selection_ux.mjs)
  - [scripts/probe_discord_command_registration_assets.mjs](./scripts/probe_discord_command_registration_assets.mjs)
  - [verification/discord_project_selection_ux_probe_summary.json](./verification/discord_project_selection_ux_probe_summary.json)
  - [verification/discord_command_registration_assets_probe_summary.json](./verification/discord_command_registration_assets_probe_summary.json)
- Deliverables:
  - `/projects` project catalog command
  - project option autocomplete
  - `/use-project` channel default project binding
  - project omission fallback via channel binding / single-project default
  - `project_required` / `unknown_project` operator help path
- Exit criteria:
  - 사용자가 내부 `project_key`를 미리 외우지 않아도 `/projects`와 자동완성으로 프로젝트를 찾을 수 있다
  - 채널 기본 프로젝트 바인딩 후 `/status`, `/intent`, `/reply`에서 `project` 생략이 가능하다
  - 단일 프로젝트 workspace에서는 별도 binding 없이 `project`를 생략할 수 있다
  - 다중 프로젝트 + 미바인딩 상태에서는 추측 라우팅 대신 안내 응답으로 끝난다

### EP-970 Discord Component UX

- Status: `completed`
- WBS refs: `13.1`, `13.2`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule)
- Validation basis:
  - [Probe 84](./verification/VERIFICATION_LOG.md#2026-03-29---probe-84-discord-component-ux)
- Progress evidence:
  - [scripts/lib/discord_gateway_adapter_runtime.mjs](./scripts/lib/discord_gateway_adapter_runtime.mjs)
  - [scripts/lib/discord_gateway_operator_responder.mjs](./scripts/lib/discord_gateway_operator_responder.mjs)
  - [scripts/lib/discord_interaction_callback_transport.mjs](./scripts/lib/discord_interaction_callback_transport.mjs)
  - [scripts/probe_discord_component_ux.mjs](./scripts/probe_discord_component_ux.mjs)
  - [verification/discord_component_ux_probe_summary.json](./verification/discord_component_ux_probe_summary.json)
- Deliverables:
  - `/projects` select menu card
  - project-selected action buttons
  - modal-based intent submission from button flow
  - component interaction -> same bridge/shared-memory contract
- Exit criteria:
  - `/projects` 응답이 select menu를 포함한다
  - 프로젝트 선택 후 status/bind/intent 버튼이 같은 카드에 나타난다
  - `작업 지시` 버튼이 modal을 열고, modal submit이 intent inbox/dispatch 경로로 이어진다

### EP-980 Discord Existing Thread Attach UX

- Status: `completed`
- WBS refs: `14.1`, `14.2`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Project Identity And Routing Rule](./STRATEGY.md#project-identity-and-routing-rule)
- Validation basis:
  - [Probe 86](./verification/VERIFICATION_LOG.md#2026-03-29---probe-86-discord-attach-existing-thread-ux)
  - [Probe 88](./verification/VERIFICATION_LOG.md#2026-03-29---probe-88-discord-attach-control-expansion)
  - [Probe 89](./verification/VERIFICATION_LOG.md#2026-03-29---probe-89-live-discord-command-refresh-after-attach-control-expansion)
- Progress evidence:
  - [scripts/lib/app_server_jsonrpc.mjs](./scripts/lib/app_server_jsonrpc.mjs)
  - [scripts/lib/discord_gateway_adapter_runtime.mjs](./scripts/lib/discord_gateway_adapter_runtime.mjs)
  - [scripts/lib/discord_gateway_operator_responder.mjs](./scripts/lib/discord_gateway_operator_responder.mjs)
  - [scripts/probe_discord_attach_existing_thread_ux.mjs](./scripts/probe_discord_attach_existing_thread_ux.mjs)
  - [verification/discord_attach_existing_thread_ux_probe_summary.json](./verification/discord_attach_existing_thread_ux_probe_summary.json)
  - [verification/discord_live_command_refresh_probe_summary.json](./verification/discord_live_command_refresh_probe_summary.json)
- Deliverables:
  - app-server existing thread discovery
  - `/projects` attachable thread choices
  - 추천 보기 / 전체 보기 / 직접 연결 attach control
  - `/attach-thread` direct attach command
  - `attach-thread.thread_id` autocomplete + short-id prefix resolution
  - attach 선택 시 `project_identity/coordinator_binding/channel binding` 생성
  - 기존 Codex 메인 thread를 Discord 채널에 연결하는 bootstrap path
- Exit criteria:
  - shared memory 등록 프로젝트가 없어도 `/projects`가 attach 가능한 existing Codex thread를 보여준다
  - operator가 숨은 heuristic 하나에 묶이지 않고 추천 보기, 전체 보기, 직접 연결 중 하나를 고를 수 있다
  - 사용자가 attach 후보를 고르면 새 프로젝트 생성 없이 기존 thread를 project-local namespace에 연결할 수 있다
  - attach 완료 후 ordinary `/status`, `/intent`, `/reply` 흐름을 같은 project key로 계속 쓸 수 있다

### EP-990 Discord Mode Toggle UX

- Status: `completed`
- WBS refs: `15.1`, `15.2`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Autonomous Night Shift Gate](./STRATEGY.md#autonomous-night-shift-gate)
  - [Background Cron Toggle Rule](./MAIN_COORDINATOR_PROMPT_CONTRACT.md#background-cron-toggle-rule)
- Validation basis:
  - [Probe 92](./verification/VERIFICATION_LOG.md#2026-03-29---probe-92-discord-mode-toggle-ux)
  - [Probe 87](./verification/VERIFICATION_LOG.md#2026-03-29---probe-87-discord-component-ux)
  - [Probe 89](./verification/VERIFICATION_LOG.md#2026-03-29---probe-89-live-discord-command-refresh-after-attach-control-expansion)
- Progress evidence:
  - [scripts/lib/discord_command_manifest.mjs](./scripts/lib/discord_command_manifest.mjs)
  - [scripts/lib/discord_transport.mjs](./scripts/lib/discord_transport.mjs)
  - [scripts/lib/discord_gateway_adapter_runtime.mjs](./scripts/lib/discord_gateway_adapter_runtime.mjs)
  - [scripts/lib/discord_gateway_operator_responder.mjs](./scripts/lib/discord_gateway_operator_responder.mjs)
  - [scripts/probe_discord_mode_toggle_ux.mjs](./scripts/probe_discord_mode_toggle_ux.mjs)
  - [verification/discord_mode_toggle_ux_probe_summary.json](./verification/discord_mode_toggle_ux_probe_summary.json)
- Deliverables:
  - `/background-on`, `/foreground-on` Discord slash command
  - project 카드의 `백그라운드 시작`, `앱 복귀` 버튼
  - `background_trigger_toggle.json` writer를 Discord operator action과 연결
  - mode 전환 응답의 `scheduler`, `blocked_reasons`, `mode` 설명
  - foreground/background 전환 후 project 카드 재렌더링
- Exit criteria:
  - operator가 터미널 없이 Discord만으로 foreground/background 모드를 바꿀 수 있다
  - background 전환 응답은 scheduler arm 여부와 차단 이유를 같이 보여준다
  - foreground 전환 응답은 scheduler 차단이 정상임을 명확히 보여준다
  - approval 대기나 `must_human_check`가 있을 때 background 전환이 그것을 우회하지 않는다

### EP-1000 Discord Conversation Surface

- Status: `completed`
- WBS refs: `16.1`, `16.2`
- Strategy refs:
  - [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule)
  - [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule)
- Validation basis:
  - [Probe 94](./verification/VERIFICATION_LOG.md#2026-03-29---probe-94-discord-conversation-surface)
  - [Probe 99](./verification/VERIFICATION_LOG.md#2026-03-30---probe-99-discord-bridge-thread-conversation)
- Progress evidence:
  - [scripts/lib/discord_transport.mjs](./scripts/lib/discord_transport.mjs)
  - [scripts/lib/discord_bot_channel_transport.mjs](./scripts/lib/discord_bot_channel_transport.mjs)
  - [scripts/lib/discord_conversation_service.mjs](./scripts/lib/discord_conversation_service.mjs)
  - [scripts/remodex_discord_gateway_adapter.mjs](./scripts/remodex_discord_gateway_adapter.mjs)
  - [scripts/probe_discord_conversation_surface.mjs](./scripts/probe_discord_conversation_surface.mjs)
  - [verification/discord_conversation_surface_probe_summary.json](./verification/discord_conversation_surface_probe_summary.json)
- Deliverables:
  - bound channel plain text bridge-thread conversation
  - bot mention 기반 unbound channel help path
  - channel message sender
  - human gate / processed completion automatic notify worker
  - adapter state separation for Discord event log vs app-server log
  - Message Content intent 미설정 시 mention/slash-only degraded fallback
  - main note를 bridge thread가 operator-facing 자연어로 다시 요약하는 notification path
- Exit criteria:
  - bound 채널 plain text 상태 질문이 실제 bridge thread turn으로 응답된다
  - bound 채널 plain text 작업 요청이 bridge thread handoff를 거쳐 inbox/dispatch로 적재되고 채널에 접수 응답이 다시 올라온다
  - unbound 채널 평문은 mention 기반 도움말로 제한된다
  - human gate / processed completion이 bridge thread 요약을 거쳐 Discord 채널 자동 알림으로 다시 올라온다
  - Gateway adapter state에 bot user와 app-server log 경로가 반영된다
  - Message Content intent가 거부돼도 adapter는 4014로 영구 정지하지 않고 degraded mode로 다시 붙는다
