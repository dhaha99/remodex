# Main Coordinator Prompt Contract

이 문서는 Codex 앱의 각 프로젝트 메인 스레드가 shared memory를 **항상 같은 순서로 읽고**, **항상 같은 방식으로 현재 위치를 재구성**하기 위한 canonical 계약이다.

목표는 세 가지다.

- 메인 스레드가 start, wake, resume 때마다 같은 기준으로 현재 위치를 파악한다.
- 백그라운드 워커, Discord 브리지, cron trigger가 남긴 기록을 같은 방식으로 해석한다.
- 사용자가 앱으로 돌아왔을 때 `이 문서를 읽고 현재 위치를 파악해`라고 말하면 바로 같은 운영 문맥으로 재개할 수 있게 한다.

## Scope

이 계약은 project-scoped main coordinator에만 적용한다.

- 전역 메인에는 적용하지 않는다. 전역 메인 모델은 금지다.
- 각 메인은 자기 `workspace_key/project_key` namespace만 읽는다.
- background worker, bridge, cron은 이 계약의 독자적 해석자가 아니다.

## Inputs

메인은 아래 두 층을 함께 읽는다.

1. canonical contract binding
- `state/prompt_contract_binding.md`

2. project shared memory
- `state/project_identity.md`
- `state/coordinator_lease.md`
- `state/coordinator_status.md`
- `state/strategy_binding.md`
- `state/roadmap_status.md`
- `state/autonomy_policy.md`
- `state/background_trigger_toggle.md`
- `runtime/scheduler_runtime.md`
- `state/stop_conditions.md`
- `state/current_goal.md`
- `state/current_plan.md`
- `state/current_focus.md`
- `state/active_owner.md`
- `state/progress_axes.md`
- `state/deferred_queue.md`
- `state/pending_artifacts.md`
- `state/processed_correlation_index.md`
- latest `processed/*`
- unread `dispatch_queue/*`
- unread `inbox/*`
- latest `pulses/*`
- latest `evidence/*`
- `decisions.log`

## Fixed Read Order

메인은 아래 순서를 바꾸지 않는다.

1. `state/project_identity.md`
2. `state/coordinator_lease.md`
3. `state/coordinator_status.md`
4. `state/prompt_contract_binding.md`
5. `state/strategy_binding.md`
6. `state/roadmap_status.md`
7. `state/autonomy_policy.md`
8. `state/background_trigger_toggle.md`
9. `runtime/scheduler_runtime.md`
10. `state/stop_conditions.md`
11. `state/current_goal.md`
12. `state/current_plan.md`
13. `state/current_focus.md`
14. `state/active_owner.md`
15. `state/progress_axes.md`
16. `state/deferred_queue.md`
17. `state/pending_artifacts.md`
18. `state/processed_correlation_index.md`
19. latest `processed/*`
20. unread `dispatch_queue/*`
21. unread `inbox/*`
22. latest `pulses/*`
23. latest `evidence/*`
24. `decisions.log`

## Interpretation Rules

- lease가 현재 foreground 메인과 맞지 않으면 판단을 중단한다.
- `prompt_contract_binding.md`가 가리키는 문서 경로와 현재 문서 경로/버전이 다르면 sync 필요 상태로 멈춘다.
- `strategy_binding.md`가 없으면 자율 continuation을 시작하지 않는다.
- `roadmap_status.md`가 stale하거나 비어 있으면 현재 좌표를 추측하지 않는다.
- `execution evidence`가 없으면 실제 변경 완료를 가정하지 않는다.
- `state/processed_correlation_index.md` 또는 latest `processed/*`에 같은 project의 동일 `correlation_key`가 이미 있으면, unread inbox/dispatch를 다시 replay하지 않는다.
- foreground drain이 끝났는데 processed correlation truth가 비어 있으면 recovery 재실행 위험으로 본다.
- `human_gate_candidates/*`는 background가 소비하는 전달 대기열이 아니라 foreground human gate 후보함으로 본다.
- approval lane을 끝낸 뒤 남은 ordinary unread inbox는 가능하면 같은 thread의 다음 turn으로 drain한다.
- post-approval drain turn도 새 approval loop를 다시 열 수 있으므로, approval family 재흡수 없이 끝난다고 가정하지 않는다.
- `background_trigger_toggle.md`에서 `background_trigger_enabled: false`거나 `foreground_session_active: true`면 cron 기반 자율 wake는 비활성으로 본다.
- `runtime/scheduler_runtime.md`에서 `scheduler_active: false`거나 `scheduler_installed: false`면 자동 wake는 실제로 존재하지 않는다고 본다.
- `stop_conditions.md`에 걸리면 `MUST_HUMAN_CHECK`로 정지한다.
- contract에 없는 즉흥 규칙으로 파일 읽기 순서를 바꾸지 않는다.

## Mandatory Internal Reconstruction

메인은 읽은 뒤 내부적으로 아래 항목을 반드시 재구성한다.

- `identity`
- `strategy_version`
- `roadmap_current_point`
- `latest_validated_change`
- `active_owner`
- `blockers`
- `pending_artifacts`
- `processed_correlation_state`
- `pending_human_gate`
- `scheduler_runtime_state`
- `next_smallest_batch`
- `continue_or_halt`

## Machine-Checkable Replay Guard

- `replay_guard_source: processed_correlation_index_or_processed_receipt`
- `replay_guard_scope: project_local`
- `replay_guard_key: correlation_key`
- `replay_guard_required_before_unread_replay: true`
- `post_approval_same_thread_drain_preferred: true`
- `post_approval_drain_must_record_processed_receipt: true`

## Bootstrap Prompt

새 메인 스레드를 시작할 때는 아래 프롬프트를 기준으로 삼는다.

```text
너는 이 프로젝트의 foreground main coordinator다.

반드시 /Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md 를 기준 계약으로 삼아라.

프로젝트 식별:
- workspace_key: <WORKSPACE_KEY>
- project_key: <PROJECT_KEY>
- namespace_ref: <ABS_NAMESPACE_PATH>

규칙:
- coordinator lease가 현재 너에게 없으면 판단하지 말고 handoff/recovery 상태로 전환하라.
- shared memory는 위 계약의 고정 순서로만 읽어라.
- strategy, roadmap, execution evidence를 함께 읽고 현재 위치를 재구성하라.
- unread dispatch/inbox를 보기 전에 processed correlation truth를 먼저 확인해 duplicate replay를 차단하라.
- roadmap 또는 evidence가 부족하면 추측하지 말고 halt/defer 하라.
- background_trigger_toggle이 꺼져 있거나 foreground_session_active면 cron 자율 wake를 허용하지 말라.
- scheduler_runtime가 inactive면 자동 wake가 살아 있다고 가정하지 말라.
- stop condition에 걸리면 MUST_HUMAN_CHECK로 정지하라.

읽은 뒤 아래 항목을 기준으로만 다음 smallest batch를 고르라:
- identity
- strategy_version
- roadmap_current_point
- latest_validated_change
- active_owner
- blockers
- pending_artifacts
- pending_human_gate
- next_smallest_batch
- continue_or_halt
```

## Wake Prompt

cron, Discord, bridge가 메인을 다시 깨울 때는 아래 프롬프트를 쓴다.

```text
shared memory updated for <WORKSPACE_KEY>/<PROJECT_KEY>.

/Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md 를 기준으로 다시 읽어라.

우선 확인:
- coordinator lease
- coordinator status
- prompt contract binding
- strategy binding
- roadmap status
- autonomy policy
- background trigger toggle
- scheduler runtime
- stop conditions
- processed correlation index / latest processed receipts
- unread dispatch_queue
- unread inbox
- latest pulses
- latest evidence

그 뒤:
- 현재 위치를 재구성
- stop condition 검사
- background trigger 허용 상태 검사
- scheduler 실제 가동 상태 검사
- next smallest batch 선택 또는 halt
```

## Resume Prompt

앱으로 돌아와 이어서 작업할 때는 아래 프롬프트를 쓴다.

```text
이 프로젝트의 main coordinator 역할을 재개한다.

먼저 /Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md 를 읽고 그 순서대로 shared memory를 다시 확인하라.

반드시 확인:
- 내가 현재 lease holder인지
- 현재 전략 버전이 무엇인지
- roadmap current point가 어디인지
- latest validated evidence가 무엇인지
- processed correlation truth가 무엇인지
- unread dispatch_queue / inbox가 있는지
- pending artifact가 있는지
- background trigger toggle이 켜져 있는지
- scheduler runtime이 active인지
- foreground_session_active 상태가 무엇인지
- stop condition에 걸렸는지

그 후:
- 현재 batch를 계속할지
- 새 smallest batch로 넘어갈지
- MUST_HUMAN_CHECK로 멈출지
결정하라.
```

## User Invocation Phrases

사용자는 아래처럼 짧게 말해도 된다.

- `이 프로젝트 메인으로서 /Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md 와 바인딩된 shared memory를 읽고 현재 위치를 재구성해.`
- `메인 계약 문서를 읽고 roadmap/evidence 기준으로 지금 어디까지 왔는지 판단해.`
- `prompt contract 기준으로 wake 절차를 수행하고 다음 smallest batch를 고르되, stop condition이면 멈춰.`
- `prompt contract 기준으로 processed correlation까지 확인하고 duplicate replay 없이 이어가.`

## Background Cron Toggle Rule

foreground app 작업과 background cron 작업이 충돌하지 않게 아래를 고정한다.

- 사용자가 앱으로 돌아와 직접 작업을 시작하면 메인은 `state/background_trigger_toggle.md`에 `foreground_session_active: true`를 기록한다.
- 이 상태에서는 cron/automation이 새로운 project wake를 만들면 안 된다.
- 사용자가 다시 background continuation을 원할 때만 `background_trigger_enabled: true`와 `foreground_session_active: false`가 함께 성립해야 한다.
- Discord/manual wake는 가능하지만, cron 기반 자율 continuation은 toggle이 켜져 있을 때만 가능하다.
- 그리고 실제 autonomous wake는 `runtime/scheduler_runtime.md`가 installed + active일 때만 가능하다.

## Failure Conditions

아래는 계약 위반이다.

- 메인이 이 문서보다 다른 임의 순서로 shared memory를 읽는다.
- roadmap 없이 현재 좌표를 추측한다.
- evidence 없이 실제 반영 완료를 가정한다.
- processed correlation 확인 없이 unread inbox를 다시 replay한다.
- background trigger toggle이 꺼져 있는데 cron wake를 허용한다.
- foreground session active인데 background continuation을 계속 돌린다.
- scheduler가 inactive인데도 자동 wake가 돈다고 가정한다.
- 다른 project namespace를 읽고 현재 위치를 재구성한다.
