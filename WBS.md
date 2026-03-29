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

### 9.0 Dashboard Observability

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 9.1 | `completed` | `EP-810` | dashboard MVP specification | [Observability Dashboard Rule](./STRATEGY.md#observability-dashboard-rule) |
| 9.1.1 | `completed` | `EP-810` | read-only dashboard boundary | [State Ownership](./STRATEGY.md#state-ownership) |
| 9.1.2 | `completed` | `EP-810` | portfolio/project/timeline data contract | [Multi-Project Namespace Rule](./STRATEGY.md#multi-project-namespace-rule) |
| 9.1.3 | `completed` | `EP-810` | human gate / incident view definition | [Human Gate](./STRATEGY.md#human-gate) |
| 9.2 | `completed` | `EP-820` | dashboard read model and UI | [Observability Dashboard Rule](./STRATEGY.md#observability-dashboard-rule) |
| 9.2.1 | `completed` | `EP-820` | portfolio overview aggregator | [Main Situational Awareness Rule](./STRATEGY.md#main-situational-awareness-rule) |
| 9.2.2 | `completed` | `EP-820` | project detail and timeline normalizer | [Restart Recovery](./STRATEGY.md#restart-recovery) |
| 9.2.3 | `completed` | `EP-820` | human gate / incident panel | [Go / No-Go](./STRATEGY.md#go--no-go) |

### 10.0 Portability And Resource Safety

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 10.1 | `completed` | `EP-910` | Windows 포팅 점검표 | [Platform Portability Rule](./STRATEGY.md#platform-portability-rule) |
| 10.1.1 | `completed` | `EP-910` | macOS-specific hard dependency inventory | [Execution Modes](./STRATEGY.md#execution-modes) |
| 10.1.2 | `completed` | `EP-910` | Windows Go / No-Go and porting order | [Go / No-Go](./STRATEGY.md#go--no-go) |
| 10.2 | `completed` | `EP-920` | macOS 24h soak 계획 | [Resource Safety Rule](./STRATEGY.md#resource-safety-rule) |
| 10.2.1 | `completed` | `EP-920` | soak 단계 / 시나리오 / 지표 정의 | [Validation](./STRATEGY.md#validation) |
| 10.2.2 | `completed` | `EP-920` | acceptance threshold / hard failure 정의 | [Failure Signals](./STRATEGY.md#failure-signals) |
| 10.3 | `completed` | `EP-930` | Windows runtime adapter | [Platform Portability Rule](./STRATEGY.md#platform-portability-rule) |
| 10.3.1 | `completed` | `EP-930` | scheduler adapter abstraction | [Autonomous Trigger Loop Rule](./STRATEGY.md#autonomous-trigger-loop-rule) |
| 10.3.2 | `completed` | `EP-930` | PowerShell wrapper / bootstrap | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 10.4 | `completed` | `EP-940` | macOS soak 실행 | [Resource Safety Rule](./STRATEGY.md#resource-safety-rule) |
| 10.4.1 | `completed` | `EP-940` | 30min smoke | [Validation](./STRATEGY.md#validation) |
| 10.4.2 | `completed` | `EP-940` | 6h churn + 24h overnight | [Go / No-Go](./STRATEGY.md#go--no-go) |

### 11.0 Discord Gateway Ingress

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 11.1 | `completed` | `EP-950` | Gateway adapter runtime | [Ingress Architecture Decision](./STRATEGY.md#ingress-architecture-decision) |
| 11.1.1 | `completed` | `EP-950` | Discord Gateway session and event consumer | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 11.1.2 | `completed` | `EP-950` | interaction ack and follow-up response transport | [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule) |
| 11.2 | `completed` | `EP-950` | Gateway normalization to shared memory | [Shared External Memory](./STRATEGY.md#2-shared-external-memory) |
| 11.2.1 | `completed` | `EP-950` | status / intent / reply mapping | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 11.2.2 | `completed` | `EP-950` | approval candidate and ACL mapping | [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule) |
| 11.3 | `completed` | `EP-950` | production ingress bootstrap and validation | [Ingress Architecture Decision](./STRATEGY.md#ingress-architecture-decision) |
| 11.3.1 | `completed` | `EP-950` | no-public-raw-bridge exposure check | [Ingress Architecture Decision](./STRATEGY.md#ingress-architecture-decision) |
| 11.3.2 | `completed` | `EP-950` | end-to-end Discord live ingress proof | [Validation](./STRATEGY.md#validation) |

### 12.0 Discord Operator UX

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 12.1 | `completed` | `EP-960` | project catalog and autocomplete | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 12.1.1 | `completed` | `EP-960` | `/projects` catalog command | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 12.1.2 | `completed` | `EP-960` | `project` option autocomplete | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 12.2 | `completed` | `EP-960` | implicit project resolution UX | [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule) |
| 12.2.1 | `completed` | `EP-960` | `/use-project` channel binding | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 12.2.2 | `completed` | `EP-960` | channel binding / single-project default / resolution help | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |

### 13.0 Discord Component UX

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 13.1 | `completed` | `EP-970` | project picker components | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 13.1.1 | `completed` | `EP-970` | `/projects` select menu card | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 13.1.2 | `completed` | `EP-970` | project-selected action buttons | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 13.2 | `completed` | `EP-970` | modal-based intent capture | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 13.2.1 | `completed` | `EP-970` | `작업 지시` button -> modal open | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 13.2.2 | `completed` | `EP-970` | modal submit -> inbox/dispatch | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |

### 14.0 Discord Existing Thread Attach UX

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 14.1 | `completed` | `EP-980` | existing Codex thread discovery | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 14.1.1 | `completed` | `EP-980` | app-server `thread/list` / `thread/read` attach catalog | [Project Identity And Routing Rule](./STRATEGY.md#project-identity-and-routing-rule) |
| 14.1.2 | `completed` | `EP-980` | `/projects` attachable thread select menu | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 14.1.3 | `completed` | `EP-980` | 추천 보기 / 전체 보기 / 직접 연결 attach control | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 14.2 | `completed` | `EP-980` | existing thread attach bootstrap | [Project Identity And Routing Rule](./STRATEGY.md#project-identity-and-routing-rule) |
| 14.2.1 | `completed` | `EP-980` | `project_identity/coordinator_binding` 생성 | [Project Identity And Routing Rule](./STRATEGY.md#project-identity-and-routing-rule) |
| 14.2.2 | `completed` | `EP-980` | attach 후 channel binding 및 ordinary operator flow 재사용 | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 14.2.3 | `completed` | `EP-980` | `/attach-thread` direct attach command | [Project Identity And Routing Rule](./STRATEGY.md#project-identity-and-routing-rule) |
| 14.2.4 | `completed` | `EP-980` | `attach-thread.thread_id` autocomplete + short-id prefix resolution | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |

### 15.0 Discord Mode Toggle UX

| WBS | Status | Plan Ref | Deliverable | Strategy Ref |
| --- | --- | --- | --- | --- |
| 15.1 | `completed` | `EP-990` | Discord mode toggle command surface | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 15.1.1 | `completed` | `EP-990` | `/background-on`, `/foreground-on` slash command | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 15.1.2 | `completed` | `EP-990` | mode toggle command normalization | [Discord Identity And Authorization Rule](./STRATEGY.md#discord-identity-and-authorization-rule) |
| 15.2 | `completed` | `EP-990` | project 카드 foreground/background control | [Autonomous Night Shift Gate](./STRATEGY.md#autonomous-night-shift-gate) |
| 15.2.1 | `completed` | `EP-990` | `백그라운드 시작`, `앱 복귀` 버튼 | [Discord Operator Console Rule](./STRATEGY.md#discord-operator-console-rule) |
| 15.2.2 | `completed` | `EP-990` | mode 전환 후 scheduler 상태 설명 | [Background Cron Toggle Rule](./MAIN_COORDINATOR_PROMPT_CONTRACT.md#background-cron-toggle-rule) |

## Rollup Rules

- parent WBS는 child 중 하나라도 `in_progress`면 `in_progress`다.
- child가 모두 `completed`면 parent는 `completed`다.
- child 중 하나라도 `blocked`이고 나머지가 `completed`가 아니면 parent는 `blocked`다.
- 전략 변경으로 leaf가 무효화되면 `cancelled`로 바꾸고 plan ref도 같이 갱신한다.

## Current Active WBS

- Active WBS: `none`
- Active Plan Ref: `none`
- Why active:
  - `11.0`은 real Discord guild slash command까지 포함한 live ingress proof로 완료됐다.
- `12.0`은 `/projects`, 자동완성, `/use-project`, implicit project resolution까지 포함해 operator UX를 정리했다.
- `13.0`은 `/projects` 선택 카드, 상태/고정/작업 지시 버튼, modal submit까지 포함해 component UX를 정리했다.
- `14.0`은 shared memory가 비어 있어도 existing Codex thread를 발견해 attach하는 첫 진입 경로를 정리했고, 추천 보기만 강제하지 않고 전체 보기/직접 연결까지 제공한다.
- `15.0`은 foreground/background 전환을 터미널 파일 수정이 아니라 Discord 버튼과 slash command에서 직접 수행하도록 정리했다.
  - canonical ingress는 이제 문서, 코드, bootstrap, local probe, live external edge 증거를 모두 갖췄다.
- Next smallest batch:
  - `실제 launchd 등록 또는 Windows 실제 실행 증거 수집이 필요할 때 새 배치를 연다`
