# Dashboard MVP

이 문서는 Remodex 운영 이력을 사람이 빠르게 읽기 위한 `관측용 대시보드`의 최소 범위를 정의한다.

기준 문서:

- [STRATEGY.md](./STRATEGY.md)
- [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
- [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)
- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)

## Purpose

대시보드의 목적은 세 가지다.

1. 현재 어떤 project가 어떤 상태인지 한 화면에서 본다.
2. background / foreground / human gate / recovery 이력이 시간축으로 어떻게 흘렀는지 본다.
3. Discord나 로그 파일을 직접 뒤지지 않고도 운영자가 바로 다음 판단을 할 수 있게 한다.

핵심 전제:

- 대시보드는 `제어면`이 아니라 `관측면`이다.
- 대시보드는 새로운 truth를 만들지 않는다.
- 모든 값은 기존 shared memory와 runtime 파일에서 읽는다.

## Non-Goals

MVP에서 하지 않는 것:

- repo 수정
- worker 지시
- approval 직접 집행
- coordinator lease 변경
- background trigger 토글 쓰기
- 별도 영속 DB 구축

즉 MVP는 `읽기 전용 운영 상황판`이다.

## Users

- 운영자
  - 지금 어느 project가 멈췄는지 본다.
- foreground coordinator
  - foreground 복귀 전에 approval lane, unread, duplicate risk를 본다.
- incident 대응자
  - blocked reason, human gate, inflight, processed drift를 본다.

## Source Of Truth

대시보드는 아래 파일만 읽는다.

### Project-level truth

- `state/coordinator_binding.json`
- `state/coordinator_status.json`
- `state/background_trigger_toggle.json`
- `state/processed_correlation_index.md`
- `runtime/inflight_delivery.json`
- `runtime/scheduler_runtime.json`
- `inbox/`
- `dispatch_queue/`
- `processed/`
- `human_gate_candidates/`

### Workspace-level truth

- `router/outbox/`
- `router/quarantine/`
- `router/pending_approvals.json`

## Core Principles

### 1. Read-Only First

대시보드는 파일을 읽어 보여주기만 한다.  
MVP에서는 어떤 버튼도 shared memory나 repo를 수정하지 않는다.

### 2. Portfolio First, Project Deep-Dive Second

운영자는 먼저 여러 project를 한 번에 본 뒤, 문제 project만 깊게 들어간다.

### 3. Time-Ordered History

현재 값만 보여주면 부족하다.  
`왜 멈췄는지`, `언제 human gate가 생겼는지`, `언제 foreground takeover가 일어났는지`는 시간축으로 봐야 한다.

### 4. Same Names As Runtime

UI 용어는 runtime truth 이름과 다르게 새로 만들지 않는다.

예:

- `waiting_on_approval`
- `background_trigger_enabled`
- `dispatch_queue`
- `human_gate_candidates`
- `processed`
- `blocked reason`

## MVP Screens

### 1. Portfolio Overview

project별 핵심 요약을 한 화면에 보여준다.

필수 컬럼:

- `project_key`
- `coordinator_status`
- `background mode`
- `foreground session active`
- `scheduler last decision`
- `dispatch_queue count`
- `inbox count`
- `human_gate count`
- `pending approvals count`
- `last processed`
- `last outbox event`

### 2. Project Detail

한 project를 열면 현재 truth를 상세히 보여준다.

필수 섹션:

- coordinator
  - binding thread
  - lease / epoch
  - current status
- mode
  - foreground/background toggle
  - scheduler runtime
  - inflight delivery
- queues
  - inbox count
  - dispatch_queue count
  - processed count
  - human_gate_candidates count
- approvals
  - pending approvals
  - active approval source ref
- last action
  - last processed correlation
  - last outbox event
  - last blocked reason

### 3. Timeline / History

project 단위 운영 이력을 시간축으로 본다.

표시 이벤트:

- status change
- scheduler decision
- outbox status response
- human gate notification
- processed receipt
- duplicate skip
- foreground takeover
- recovery replay

### 4. Human Gate View

승인 대기만 따로 모아서 보여준다.

필수 필드:

- `project_key`
- `thread_id`
- `source_ref`
- `method`
- `observed_at`
- `active approval source`
- `foreground required`

### 5. Incident Quick View

아래 상황만 따로 모은다.

- `must_human_check`
- `pending_human_gate`
- `foreground_session_active + background_trigger_enabled`
- stale `inflight_delivery`
- duplicate processed mismatch
- quarantine accumulation

## Data Model

MVP는 별도 DB 없이 메모리 집계만 한다.

### Portfolio Card

```json
{
  "workspace_key": "remodex",
  "project_key": "project-alpha",
  "coordinator_status": "waiting_on_approval",
  "background_trigger_enabled": true,
  "foreground_session_active": false,
  "scheduler_decision": "blocked",
  "blocked_reasons": ["pending_human_gate"],
  "dispatch_queue_count": 1,
  "inbox_count": 0,
  "human_gate_count": 1,
  "pending_approvals_count": 1,
  "last_processed_correlation": "discord-approve-001",
  "last_outbox_type": "human_gate_notification",
  "updated_at": "2026-03-27T10:30:00+09:00"
}
```

### Timeline Entry

```json
{
  "project_key": "project-alpha",
  "timestamp": "2026-03-27T10:31:00+09:00",
  "kind": "scheduler_decision",
  "summary": "blocked: pending_human_gate",
  "source_path": "runtime/scheduler_runtime.json"
}
```

## Read Path Priority

UI가 project를 읽을 때 순서는 고정한다.

1. `state/coordinator_binding.json`
2. `state/coordinator_status.json`
3. `state/background_trigger_toggle.json`
4. `runtime/scheduler_runtime.json`
5. `runtime/inflight_delivery.json`
6. `router/pending_approvals.json`
7. `human_gate_candidates/`
8. `dispatch_queue/`
9. `inbox/`
10. `processed/`
11. `state/processed_correlation_index.md`
12. `router/outbox/`

## Refresh Model

MVP refresh 원칙:

- portfolio overview: `5~10초`
- project detail: `3~5초`
- timeline: on-open + manual refresh
- human gate view: `3초`

중요:

- polling은 괜찮지만 write lock이나 rename race를 깨면 안 된다.
- 부분 파일을 읽을 위험이 있으면 마지막 성공 snapshot을 유지해야 한다.

## Alert Rules

MVP에서 바로 보이게 할 경고는 아래 다섯 가지면 충분하다.

1. `must_human_check = true`
2. `pending_human_gate > 0`
3. `foreground_session_active = true` 이면서 `background_trigger_enabled = true`
4. `inflight_delivery.json`이 오래 남음
5. 최근 `processed` 없이 queue만 줄어든 흔적

## API Shape

MVP 구현 시 권장 읽기 API:

- `GET /api/portfolio`
- `GET /api/projects/:projectKey`
- `GET /api/projects/:projectKey/timeline`
- `GET /api/human-gates`
- `GET /api/incidents`

이 API는 모두 shared memory read-only adapter 위에 올린다.

## Implementation Order

1. portfolio aggregator
2. project detail aggregator
3. timeline normalizer
4. human gate / incident views
5. minimal web UI

## Done Criteria

대시보드 MVP는 아래를 만족하면 완료다.

- operator가 파일을 직접 열지 않고도 project 상태를 식별할 수 있다.
- blocked reason과 human gate를 한 화면에서 본다.
- foreground takeover 전에 unread/approval/inflight 위험을 식별할 수 있다.
- timeline에서 최근 scheduler / outbox / processed 이력을 읽을 수 있다.
- UI가 새 truth를 만들지 않는다.
