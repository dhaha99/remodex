# Execution Plan

이 문서는 [STRATEGY.md](./STRATEGY.md) 를 수행 가능한 단위로 분해한 실행 계획이다.

전략 문서가 `불변 원칙`을 정의한다면, 이 문서는 `실행 순서`, `진행 상태`, `종료 조건`, `검증 연결`을 정의한다.

## Governing Documents

- 전략 원문: [STRATEGY.md](./STRATEGY.md)
- 메인 읽기 계약: [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md)
- 검증 근거: [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)
- 실행 분해 구조: [WBS.md](./WBS.md)

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

- Strategy baseline: `Shared Working Memory Strategy v2`
- Execution plan version: `2026-03-27`
- Current phase: `Phase 7 - Production Bootstrap Assets`
- Current active package: `none`
- Current active WBS: `none`
- Immediate next smallest batch:
  - none

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
