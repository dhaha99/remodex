# Incident Recovery Runbook

이 문서는 장애 시 복구 절차를 정리한다. 기준 문서는 [STRATEGY.md](./STRATEGY.md), [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md), [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)다.

## Core Rule

복구 중에도 아래 불변식은 깨면 안 된다.

- shared memory truth 없이 추측으로 replay하지 않는다.
- `processed/*`와 `processed_correlation_index.md`를 먼저 본다.
- `runtime/inflight_delivery.json`을 새 turn보다 먼저 본다.
- background는 `human_gate_candidates`를 소비하지 않는다.
- 같은 `correlation_key`에 second `consumed` 영수증을 만들지 않는다.

## Incident 1: Bridge Daemon Down

증상:

- `/health` 응답이 없다.
- Discord/operator 입력이 들어와도 outbox, inbox, quarantine이 갱신되지 않는다.

확인:

1. daemon 프로세스가 살아 있는지 본다.
2. daemon state와 `router/outbox` 갱신 시각을 본다.
3. public key, port, shared base가 맞는지 본다.

복구:

1. daemon을 재기동한다.
2. `/health`가 `ok: true`가 될 때까지 확인한다.
3. 미처리 operator 입력은 ingress source에서 재전송하거나 quarantine/inbox로 재기록한다.

## Incident 2: Scheduler Not Waking

증상:

- background mode인데 `scheduler_runtime.json`이 갱신되지 않는다.
- dispatch queue가 쌓여도 turn 수가 늘지 않는다.

확인:

1. `background_trigger_toggle`가 background 값인지 본다.
2. `foreground_session_active`가 false인지 본다.
3. scheduler 서비스 또는 launchd가 실제로 살아 있는지 본다.
4. `scheduler_runtime.json`의 마지막 `decision`과 `reasons`를 본다.

복구:

1. toggle truth를 바로잡는다.
2. scheduler를 재기동한다.
3. 필요하면 foreground에서 same-thread drain으로 임시 takeover한다.

## Incident 3: Stale Inflight

증상:

- `runtime/inflight_delivery.json`이 남아 있고 delivery가 계속 `inflight_wait`다.
- dispatch queue가 비워지지 않는다.

확인:

1. inflight의 `thread_id`, `turn_id`, `correlation_key`를 본다.
2. app-server에서 해당 turn이 terminal인지 확인한다.
3. 같은 `correlation_key`가 이미 `processed/*`에 있는지 확인한다.

복구:

1. turn이 아직 `inProgress`면 기다린다.
2. turn이 terminal인데 processed가 없으면 recovery/scheduler가 `completed_inflight`를 한 번 수행하게 한다.
3. processed가 이미 있으면 기존 영수증을 재사용하고 inflight만 정리한다.

주의:

- inflight를 먼저 지우고 새 turn을 열면 duplicate replay가 난다.

## Incident 4: Duplicate Processed Receipt Suspicion

증상:

- 같은 `correlation_key`에 `consumed` 영수증이 두 개 이상 있다.
- turn 수는 늘지 않았는데 processed만 추가로 늘었다.

확인:

1. 모든 `processed/*`에서 같은 `correlation_key`를 찾는다.
2. `origin`, `processed_by`, `turn_id`를 비교한다.
3. `direct_delivery`와 `inflight_recovery`가 같은 turn에 대해 둘 다 `consumed`를 찍었는지 본다.

복구:

1. background mode를 잠시 끈다.
2. duplicate receipt를 만든 코드 경로를 막기 전까지 자동 churn을 다시 켜지 않는다.
3. canonical receipt 하나만 truth로 보고 index를 정렬한다.

## Incident 5: Human Gate Stuck

증상:

- `coordinator_status`가 계속 `waiting_on_approval`이다.
- `router/pending_approvals.json` 또는 `human_gate_candidates/`가 줄지 않는다.

확인:

1. active approval `source_ref`가 무엇인지 본다.
2. candidate가 foreground human gate 후보함에 들어가 있는지 본다.
3. operator ACL과 approval source가 맞는지 본다.

복구:

1. foreground mode로 전환한다.
2. foreground 메인 또는 `/projects/<project>/human-gate` 경로로 closure를 수행한다.
3. approval lane이 닫혔는지 확인한다.
4. 그 뒤 ordinary unread inbox를 같은 thread의 다음 turn으로 drain한다.

## Incident 6: Foreground/Background Conflict

증상:

- 앱에서 직접 작업 중인데 scheduler가 계속 wake한다.
- 같은 project에서 foreground와 background가 경쟁하는 흔적이 보인다.

확인:

1. `background_trigger_toggle` truth를 본다.
2. `scheduler_runtime`의 blocked reason에 `foreground_session_active`가 있는지 본다.
3. bridge가 defer 대신 deliver를 했는지 본다.

복구:

1. foreground mode를 truth에 다시 기록한다.
2. scheduler가 blocked로 바뀔 때까지 확인한다.
3. 남아 있는 dispatch queue는 foreground가 drain한다.

## Incident 7: Quarantine Growth

증상:

- `router/quarantine/`에 파일이 계속 늘어난다.

확인:

1. `missing_project`인지 `missing_role`인지 구분한다.
2. unresolved routing 문제인지 operator 권한 문제인지 본다.
3. same source family가 반복되는지 본다.

복구:

1. project mapping 또는 ACL을 바로잡는다.
2. 무효 입력은 quarantine 증거로 남기고 실행하지 않는다.
3. 반복 source family면 ingress 쪽 payload를 먼저 고친다.

## Incident 8: Restart Recovery

증상:

- app-server, daemon, scheduler 중 하나 이상이 재시작됐다.
- unread inbox와 dispatch queue가 남아 있다.

복구 순서:

1. app-server를 먼저 복구한다.
2. daemon을 복구해 ingress와 status mirror를 다시 붙인다.
3. `processed/*`, `processed_correlation_index.md`, `inflight_delivery.json`을 먼저 점검한다.
4. `pending_approvals`와 `human_gate_candidates`가 있으면 foreground human gate부터 처리한다.
5. ordinary unread inbox와 dispatch queue는 project별로 same-thread replay한다.

## Operator Escalation Rules

- `must_human_check`가 켜지면 background 자동 진행을 즉시 중단한다.
- project mismatch, missing binding, duplicate receipt는 자동 우회하지 않는다.
- same failure class가 두 번 반복되면 같은 remedy를 세 번째 반복하지 않고 producer/carrier/consumer 전 경로를 다시 본다.

## Minimal Recovery Checklist

1. binding 확인
2. coordinator status 확인
3. processed/index 확인
4. inflight 확인
5. pending approvals / human gate 확인
6. foreground/background toggle 확인
7. 그 다음에만 replay 또는 drain
