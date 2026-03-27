# WBS

이 문서는 [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) 를 계층 구조로 분해한 Work Breakdown Structure다.

각 leaf는 실제 수행 가능한 배치여야 하며, 반드시 `status`와 `plan_ref`를 가진다.

## Status Legend

- `completed`
- `in_progress`
- `pending`
- `blocked`
- `deferred`
- `cancelled`

## WBS Tree

### 1.0 Governance And Traceability

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 1.1 | `completed` | `EP-000` | 전략-계획-WBS traceability 구조 | [Recommended Score Rubric](./STRATEGY.md#recommended-score-rubric) |
| 1.2 | `completed` | `EP-000` | [EXECUTION_PLAN.md](./EXECUTION_PLAN.md) | [Core Principles](./STRATEGY.md#core-principles) |
| 1.3 | `completed` | `EP-000` | [WBS.md](./WBS.md) | [Go / No-Go](./STRATEGY.md#go--no-go) |

### 2.0 Project Control Plane Foundation

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 2.1 | `completed` | `EP-110` | namespace bootstrap runtime | [Routing And Namespace Rule](./STRATEGY.md#routing-and-namespace-rule) |
| 2.1.1 | `completed` | `EP-110` | workspace/project registry loader | [Project Identity Schema](./STRATEGY.md#project-identity-schema) |
| 2.1.2 | `completed` | `EP-110` | unresolved route quarantine path | [Routing Schema](./STRATEGY.md#routing-schema) |
| 2.2 | `completed` | `EP-120` | coordinator binding/lease manager | [Coordinator Lease Rule](./STRATEGY.md#coordinator-lease-rule) |
| 2.2.1 | `completed` | `EP-120` | thread binding resolver | [Coordinator Lease Schema](./STRATEGY.md#coordinator-lease-schema) |
| 2.2.2 | `completed` | `EP-120` | project mismatch fail-closed | [Main Coordinator Protocol](./STRATEGY.md#main-coordinator-protocol) |
| 2.3 | `completed` | `EP-130` | coordinator status mirror | [Coordinator Status Schema](./STRATEGY.md#coordinator-status-schema) |
| 2.3.1 | `completed` | `EP-130` | `thread/status/changed` -> local state mirror | [Coordinator Delivery State Rule](./STRATEGY.md#coordinator-delivery-state-rule) |
| 2.3.2 | `completed` | `EP-130` | approval loop-safe state transitions | [Human Gate](./STRATEGY.md#human-gate) |
| 2.4 | `completed` | `EP-140` | processed receipt/index dedupe core | [Processed Receipt Schema](./STRATEGY.md#processed-receipt-schema) |
| 2.4.1 | `completed` | `EP-140` | receipt writer | [Machine-Checkable Processed Dedupe Guard](./STRATEGY.md#machine-checkable-processed-dedupe-guard) |
| 2.4.2 | `completed` | `EP-140` | processed index updater | [Idempotency and Dedupe](./STRATEGY.md#idempotency-and-dedupe) |

### 3.0 Bridge Control Plane

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 3.1 | `completed` | `EP-210` | bridge runtime skeleton | [Bridge Protocol](./STRATEGY.md#bridge-protocol) |
| 3.1.1 | `completed` | `EP-210` | JSON-RPC/thread helper extraction | [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern) |
| 3.1.2 | `completed` | `EP-210` | shared memory reader/writer boundary | [Persistence vs Delivery Rule](./STRATEGY.md#persistence-vs-delivery-rule) |
| 3.1.3 | `completed` | `EP-210` | no-direct-injection runtime guard | [Intent, Not Direct Injection](./STRATEGY.md#3-intent-not-direct-injection) |
| 3.2 | `completed` | `EP-220` | status responder | [Main Situational Awareness Rule](./STRATEGY.md#main-situational-awareness-rule) |
| 3.2.1 | `completed` | `EP-220` | snapshot query service | [Main Prompt Contract Rule](./STRATEGY.md#main-prompt-contract-rule) |
| 3.2.2 | `completed` | `EP-220` | operator-facing formatter | [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern) |
| 3.3 | `completed` | `EP-230` | intent normalizer and inbox writer | [Intent Schema](./STRATEGY.md#intent-schema) |
| 3.3.1 | `completed` | `EP-230` | `status`/`intent`/`reply`/`approve-candidate` command mapping | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 3.3.2 | `completed` | `EP-230` | source_ref/correlation_key propagation | [Event Correlation Rule](./STRATEGY.md#event-correlation-rule) |
| 3.4 | `completed` | `EP-240` | dispatch arbitration | [Dispatch Queue Rule](./STRATEGY.md#dispatch-queue-rule) |
| 3.4.1 | `completed` | `EP-240` | busy/checkpoint delivery gate | [Delivery Gate Rule](./STRATEGY.md#delivery-gate-rule) |
| 3.4.2 | `completed` | `EP-240` | foreground defer path | [Autonomous Night Shift Gate](./STRATEGY.md#autonomous-night-shift-gate) |

### 4.0 Discord Operator Console

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 4.1 | `completed` | `EP-310` | signed ingress endpoint | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 4.1.1 | `completed` | `EP-310` | signature verification | [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule) |
| 4.1.2 | `completed` | `EP-310` | replay rejection and quarantine | [Routing And Namespace Rule](./STRATEGY.md#routing-and-namespace-rule) |
| 4.2 | `completed` | `EP-320` | outbound operator replies | [Mode F: Discord + Cron Operator Console Mode](./STRATEGY.md#mode-f-discord--cron-operator-console-mode) |
| 4.2.1 | `completed` | `EP-320` | status response publisher | [Conversation Bridge Thread Pattern](./STRATEGY.md#conversation-bridge-thread-pattern) |
| 4.2.2 | `completed` | `EP-320` | human gate / blocker notification publisher | [Human Gate](./STRATEGY.md#human-gate) |

### 5.0 Scheduler And Autonomy

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 5.1 | `completed` | `EP-410` | launchd scheduler runtime | [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule) |
| 5.1.1 | `completed` | `EP-410` | runtime state writer | [Scheduler Runtime Schema](./STRATEGY.md#scheduler-runtime-schema) |
| 5.1.2 | `completed` | `EP-410` | wake event creator | [Trigger Event Schema](./STRATEGY.md#trigger-event-schema) |
| 5.2 | `completed` | `EP-420` | foreground/background arbitration | [Background Trigger Toggle Schema](./STRATEGY.md#background-trigger-toggle-schema) |
| 5.2.1 | `completed` | `EP-420` | foreground lock enforcement | [Autonomous Night Shift Gate](./STRATEGY.md#autonomous-night-shift-gate) |
| 5.2.2 | `completed` | `EP-420` | background trigger disable path | [Background Cron Toggle Rule](./MAIN_COORDINATOR_PROMPT_CONTRACT.md#background-cron-toggle-rule) |

### 6.0 Human Gate And Recovery

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 6.1 | `completed` | `EP-510` | foreground-only human gate closure | [Human Gate](./STRATEGY.md#human-gate) |
| 6.1.1 | `completed` | `EP-510` | candidate 기록 경로 | [State Ownership](./STRATEGY.md#state-ownership) |
| 6.1.2 | `completed` | `EP-510` | live app-server approval closure | [Codex App Server](./STRATEGY.md#references) |
| 6.2 | `completed` | `EP-520` | same-thread post-approval drain | [Dispatch Queue Rule](./STRATEGY.md#dispatch-queue-rule) |
| 6.2.1 | `completed` | `EP-520` | ordinary unread drain after approval lane | [Restart Recovery](./STRATEGY.md#restart-recovery) |
| 6.2.2 | `completed` | `EP-520` | processed receipt on drain | [Machine-Checkable Processed Dedupe Guard](./STRATEGY.md#machine-checkable-processed-dedupe-guard) |
| 6.3 | `completed` | `EP-530` | recovery replay guard | [Idempotency and Dedupe](./STRATEGY.md#idempotency-and-dedupe) |
| 6.3.1 | `completed` | `EP-530` | recovery unread replay precheck | [Restart Recovery](./STRATEGY.md#restart-recovery) |
| 6.3.2 | `completed` | `EP-530` | skipped_duplicate receipt path | [Processed Receipt Schema](./STRATEGY.md#processed-receipt-schema) |
| 6.4 | `completed` | `EP-540` | multi-project isolation | [Multi-Project Namespace Rule](./STRATEGY.md#multi-project-namespace-rule) |
| 6.4.1 | `completed` | `EP-540` | project-local recovery routing | [Portfolio Router Rule](./STRATEGY.md#portfolio-router-rule) |
| 6.4.2 | `completed` | `EP-540` | project-local approval lane takeover | [Human Gate](./STRATEGY.md#human-gate) |

### 7.0 Hardening And Operations

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 7.1 | `completed` | `EP-610` | overload/backoff hardening | [Validation](./STRATEGY.md#validation) |
| 7.1.1 | `completed` | `EP-610` | app-server overload retry discipline | [Codex App Server](./STRATEGY.md#references) |
| 7.1.2 | `completed` | `EP-610` | inflight claim cleanup | [Failure Signals](./STRATEGY.md#failure-signals) |
| 7.2 | `completed` | `EP-610` | soak and restart churn tests | [Go / No-Go](./STRATEGY.md#go--no-go) |
| 7.2.1 | `completed` | `EP-610` | long-run scheduler churn | [Autonomous Trigger Mode](./STRATEGY.md#mode-g-autonomous-trigger-mode) |
| 7.2.2 | `completed` | `EP-610` | long-run operator ingress churn | [Mode F: Discord + Cron Operator Console Mode](./STRATEGY.md#mode-f-discord--cron-operator-console-mode) |
| 7.3 | `completed` | `EP-610` | operator runbook/manual | [References](./STRATEGY.md#references) |
| 7.3.1 | `completed` | `EP-610` | normal ops manual | [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md) |
| 7.3.2 | `completed` | `EP-610` | incident / recovery runbook | [Restart Recovery](./STRATEGY.md#restart-recovery) |

### 8.0 Production Bootstrap

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 8.1 | `completed` | `EP-710` | launchd/env/bootstrap assets | [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule) |
| 8.1.1 | `completed` | `EP-710` | env example and wrapper scripts | [Background Cron Toggle Rule](./MAIN_COORDINATOR_PROMPT_CONTRACT.md#background-cron-toggle-rule) |
| 8.1.2 | `completed` | `EP-710` | plist renderer and install helpers | [Scheduler Runtime Schema](./STRATEGY.md#scheduler-runtime-schema) |
| 8.1.3 | `completed` | `EP-710` | production bootstrap document | [References](./STRATEGY.md#references) |

## Rollup Rules

- parent WBS는 child 중 하나라도 `in_progress`면 `in_progress`다.
- child가 모두 `completed`면 parent는 `completed`다.
- child 중 하나라도 `blocked`이고 나머지가 `completed`가 아니면 parent는 `blocked`다.
- 전략 변경으로 leaf가 무효화되면 `cancelled`로 바꾸고 plan ref도 같이 갱신한다.

## Current Active WBS

- Active WBS: `none`
- Active Plan Ref: `EP-610`
- Why active:
  - 모든 leaf WBS가 완료됐다.
  - 이후 작업은 새 전략 변경 또는 운영 중 incident에 의해 다시 열리는 배치만 남는다.
- Next smallest batch:
  - none
