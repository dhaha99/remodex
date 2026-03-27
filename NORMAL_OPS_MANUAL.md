# Normal Ops Manual

이 문서는 Remodex를 평시 운영하는 방법을 정리한다. 기준 문서는 [STRATEGY.md](./STRATEGY.md), [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md), [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)다.

## Runtime Topology

- `Codex app-server`
  - project 메인 thread를 실제로 이어서 실행하는 경계다.
- `bridge daemon`
  - Discord/operator ingress, status 응답, human gate candidate 기록을 담당한다.
- `scheduler tick`
  - background mode에서만 project를 깨우고 `dispatch_queue` 또는 `inbox`를 같은 thread에 이어 붙인다.
- `shared memory`
  - project별 운영 truth다. 메인, bridge, scheduler 모두 이 파일들을 기준으로 판단한다.

## Authoritative Paths

project namespace 기준 핵심 경로:

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

workspace router 기준 핵심 경로:

- `router/outbox/`
- `router/quarantine/`
- `router/pending_approvals.json`

## Preflight

1. `Codex app-server`가 살아 있는지 확인한다.
2. bridge daemon `/health`가 `ok: true`인지 확인한다.
3. project에 `coordinator_binding.json`이 있고 현재 thread binding이 맞는지 확인한다.
4. foreground/background 모드가 현재 운영 의도와 일치하는지 확인한다.
5. `must_human_check`, `human_gate_candidates`, `pending_approvals`가 남아 있지 않은지 확인한다.

## Foreground Mode

앱에서 직접 작업할 때 쓰는 모드다.

권장 truth:

- `background_trigger_enabled: false`
- `foreground_session_active: true`
- `foreground_lock_enabled: true`

효과:

- bridge는 operator intent를 기록만 하고 즉시 난입하지 않는다.
- scheduler/launchd는 wake를 만들지 못한다.
- human gate closure와 same-thread drain은 foreground 메인만 처리한다.

운영 순서:

1. `background_trigger_toggle`를 foreground 값으로 바꾼다.
2. project status가 `idle` 또는 `checkpoint_open`인지 확인한다.
3. 메인에게 prompt contract 기준으로 상태를 재구성하게 한다.
4. human gate가 있으면 approval lane부터 닫는다.
5. 남은 unread inbox가 있으면 같은 thread의 다음 turn으로 drain한다.

## Background Mode

자는 동안 이어서 돌릴 때 쓰는 모드다.

권장 truth:

- `background_trigger_enabled: true`
- `foreground_session_active: false`
- `foreground_lock_enabled: false`

효과:

- scheduler tick이 project를 깨울 수 있다.
- bridge는 status/intent/reply를 기록하고, 허용 시점이면 같은 thread에 이어 붙일 수 있다.
- human gate가 생기면 background는 fail-closed로 멈춘다.

운영 순서:

1. foreground session을 종료한다.
2. `background_trigger_toggle`를 background 값으로 바꾼다.
3. scheduler가 실제로 살아 있는지 확인한다.
4. `router/outbox`와 `runtime/scheduler_runtime.json`을 보며 wake와 blocked reason을 확인한다.
5. 아침에 돌아오면 반드시 foreground 모드로 되돌린 뒤 takeover한다.

## Operator Actions

bridge가 받는 operator class는 네 가지다.

- `status`
  - 현재 snapshot을 읽어 `router/outbox/status_response_*`로 응답한다.
- `intent`
  - 새 작업 지시를 `inbox/`에 기록한다.
- `reply`
  - 질문 turn 뒤 같은 thread의 follow-up answer로 이어질 입력을 기록한다.
- `approve-candidate`
  - live approval을 직접 닫는 것이 아니라 foreground human gate 후보를 기록한다.

규칙:

- operator 입력은 direct injection이 아니라 반드시 shared memory로 들어간다.
- `status`는 즉답 가능하지만, 최신 판단이 필요하면 메인을 한 번 더 깨워 refresh해야 한다.
- `approve-candidate`는 `ops-admin`만 허용한다.
- project가 없거나 권한이 없으면 quarantine으로 빠져야 정상이다.

## Status Checks

일상 점검은 아래 순서가 안전하다.

1. `/health`로 daemon과 app-server 연결 상태를 본다.
2. `/projects/<project>/status` 또는 `status_response` outbox를 본다.
3. `coordinator_status`, `background_trigger_toggle`, `pending_approvals`, `human_gate_candidates`를 같이 본다.
4. `processed/`와 `processed_correlation_index.md`가 마지막 operator action과 일치하는지 본다.

정상 징후:

- foreground 중에는 `dispatch_queue`만 늘고 자동 delivery는 일어나지 않는다.
- background 중에는 `scheduler_runtime`이 `blocked`, `dispatch_queue`, `inbox`, `noop` 중 하나로 설명 가능해야 한다.
- 같은 `correlation_key`에 대해 `processed/*`는 한 번만 `consumed` 되어야 한다.

## Morning Takeover

앱으로 돌아와 직접 이어받을 때 순서는 고정한다.

1. foreground mode로 전환한다.
2. scheduler가 더 이상 wake하지 않는지 확인한다.
3. `pending_approvals`와 `human_gate_candidates`를 먼저 확인한다.
4. approval lane이 있으면 foreground 메인으로 먼저 닫는다.
5. approval lane이 닫힌 뒤 ordinary unread inbox를 같은 thread의 다음 turn으로 drain한다.
6. drain 후 `processed/*`와 `processed_correlation_index.md`가 갱신됐는지 확인한다.

## Night Shift Checklist

background로 넘기기 전 최소 체크리스트:

- binding이 현재 project 메인 thread를 정확히 가리킨다.
- foreground lock이 꺼졌다.
- scheduler가 실제로 동작한다.
- unresolved quarantine이 쌓여 있지 않다.
- human gate candidate가 없다.
- duplicate receipt나 stale inflight 같은 장애가 없다.

## Do Not

- inbox 기록 없이 메인 thread에 직접 메시지를 밀어 넣지 않는다.
- background가 `human_gate_candidates`를 소비하게 두지 않는다.
- `processed/*` 없이 dispatch queue만 비웠다고 판단하지 않는다.
- file created 시점을 turn completed와 동일시하지 않는다.
- 같은 `correlation_key`에 대해 second `consumed` 영수증을 허용하지 않는다.
