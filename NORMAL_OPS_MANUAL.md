# Normal Ops Manual

이 문서는 Remodex를 평시 운영하는 방법을 정리한다. 기준 문서는 [STRATEGY.md](./STRATEGY.md), [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md), [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)다.

## Runtime Topology

- `Codex app-server`
  - project 메인 thread를 실제로 이어서 실행하는 경계다.
- `Discord Gateway adapter`
  - canonical production Discord ingress다.
- `bridge daemon`
  - internal bridge runtime, status 응답, human gate candidate 기록을 담당한다.
- `scheduler tick`
  - background mode에서만 project를 깨우고 `dispatch_queue` 또는 `inbox`를 같은 thread에 이어 붙인다.
- `shared memory`
  - project별 운영 truth다. 메인, bridge, scheduler 모두 이 파일들을 기준으로 판단한다.

구분:

- Discord 실운영 연결은 Gateway adapter가 담당한다.
- bridge daemon의 HTTP는 loopback admin/probe surface다.
- webhook relay는 fallback일 뿐 canonical path가 아니다.

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
- `router/discord_gateway_adapter_state.json`
- `router/discord_gateway_events.jsonl`

## Preflight

1. `Codex app-server`가 살아 있는지 확인한다.
2. bridge daemon `/health`가 `ok: true`인지 확인한다.
3. canonical ingress를 쓰는 경우 `router/discord_gateway_adapter_state.json`에서 `ready_seen`, `last_event_type`, `session_id`를 확인한다.
4. project에 `coordinator_binding.json`이 있고 현재 thread binding이 맞는지 확인한다.
5. foreground/background 모드가 현재 운영 의도와 일치하는지 확인한다.
6. `must_human_check`, `human_gate_candidates`, `pending_approvals`가 남아 있지 않은지 확인한다.

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

Gateway adapter가 정규화해 bridge로 넘기는 operator action은 여덟 가지다.

- `projects`
  - 사용 가능한 프로젝트 목록과 현재 힌트를 돌려주고, select menu를 함께 붙인다.
  - shared memory 등록 프로젝트뿐 아니라, 아직 attach되지 않은 기존 Codex thread 후보도 같이 보여준다.
- `use-project`
  - 현재 guild/channel에 기본 프로젝트를 바인딩한다.
- `background-on`
  - 현재 project를 background mode로 바꾼다.
- `foreground-on`
  - 현재 project를 foreground mode로 되돌린다.
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
- 첫 진입에서 shared memory 프로젝트가 비어 있어도, `/projects`는 app-server의 기존 Codex thread를 attach 후보로 같이 보여줘야 한다.
- 기존 Codex 메인 thread가 있으면 `새 프로젝트 등록`보다 `기존 Codex 스레드 연결`이 우선이다.
- `project`는 명시적으로 줄 수도 있고, 채널 기본 프로젝트나 single-project default로 자동 결정될 수도 있다.
- `/projects`에서 프로젝트를 고르면 같은 카드 안에서 `상태 보기`, `이 채널에 고정`, `작업 지시` 버튼을 이어서 쓸 수 있다.
- project 카드에는 `백그라운드 시작`, `앱 복귀` 버튼도 함께 붙어야 한다.
- `/background-on`, `/foreground-on`은 `project`를 직접 받을 수도 있고, 채널 기본 프로젝트가 있으면 생략할 수도 있다.
- background 전환 응답은 `mode`, `scheduler`, `blocked_reasons`를 같이 보여줘야 한다.
- foreground 전환 응답은 `mode: foreground`, `scheduler: blocked_expected`를 분명히 보여줘야 한다.
- background 전환은 scheduler arm일 뿐이고, `must_human_check`, `pending_human_gate`, approval 대기 중인 lane까지 우회시키면 안 된다.
- `/projects`에서 attach 후보를 고르면 runtime은 `project_identity + coordinator_binding + channel binding`을 만들고, 그 뒤부터 ordinary project 카드와 같은 흐름으로 들어간다.
- attach 후보 기준은 숨은 heuristic 하나로 강제하면 안 되고, 최소한 `추천 보기`, `다른 저장소 포함 전체 보기`, `직접 연결(thread id)` 세 경로를 operator가 직접 고를 수 있어야 한다.
- `전체 보기`는 raw loaded thread를 그대로 뿌리면 안 되고, 저장소 이름과 최근 힌트가 붙은 식별 가능한 기존 Codex thread만 보여줘야 한다.
- 다른 저장소의 기존 Codex 메인 thread도 attach 가능해야 하고, attach 후에는 `project_identity + coordinator_binding + channel binding`을 현재 runtime에 생성하는 편이 맞다.
- `/attach-thread`는 자동완성을 지원하고, live alert에 보이는 short id 8자리 prefix도 unique하면 canonical thread id로 해석되는 편이 맞다.
- `작업 지시` 버튼은 modal을 열고, 입력 텍스트는 `intent`와 같은 규약으로 shared memory에 기록된다.
- 여러 프로젝트가 보이는데 `project`가 비어 있고 채널 기본 프로젝트도 없으면 quarantine이 아니라 `project_required` 안내로 응답해야 한다.
- project 입력은 자동완성으로 고를 수 있어야 한다.
- `status`는 즉답 가능하지만, 최신 판단이 필요하면 메인을 한 번 더 깨워 refresh해야 한다.
- `approve-candidate`는 `ops-admin`만 허용한다.
- 권한이 없으면 quarantine으로 빠져야 정상이다.
- project가 빠진 경우는 `project_required` 또는 `unknown_project` 안내로 먼저 돌려주고, 다중 프로젝트에서 추측 라우팅하면 안 된다.

## Status Checks

일상 점검은 아래 순서가 안전하다.

1. `/health`로 daemon과 app-server 연결 상태를 본다.
2. Discord에서 `/projects`로 프로젝트 목록과 attach 후보를 먼저 본다.
3. attach 후보가 기대보다 적으면 `다른 저장소 포함 전체 보기`로 식별 가능한 기존 thread를 넓혀 본다.
4. thread id를 이미 알고 있으면 `직접 연결` 또는 `/attach-thread thread_id:<...>`를 쓴다.
5. 기존 Codex thread가 없을 때만 새 프로젝트 등록을 고려한다.
6. dashboard 또는 router truth에서 `gateway_adapter_state`, `last_project_interaction`, `gateway_interaction` timeline을 본다.
7. `/projects/<project>/status` 또는 `status_response` outbox를 본다.
8. `coordinator_status`, `background_trigger_toggle`, `pending_approvals`, `human_gate_candidates`를 같이 본다.
9. `processed/`와 `processed_correlation_index.md`가 마지막 operator action과 일치하는지 본다.

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
