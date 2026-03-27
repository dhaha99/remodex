# Verification Log

## 2026-03-25 - Probe 1: app-server thread start + sequential turns + workspace file writes

### Goal
- Verify that `codex app-server` can accept thread/turn requests over WebSocket.
- Verify that a single thread can receive multiple turns in sequence.
- Verify that Codex can write files into the workspace as a result of those turns.

### Setup
- App-server listen address: `ws://127.0.0.1:4517`
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_app_server.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_app_server.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/app_server_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/app_server_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/app_server_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/app_server_probe_events.jsonl)

### Result
- Status: PASS
- Thread created successfully.
- Two turns completed successfully on the same thread.
- Workspace files were created and updated by Codex as instructed.

### Evidence
- `threadId`: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- `turn1.id`: `019d2283-c99a-7f80-89da-db0a8c3d0b00`
- `turn2.id`: `019d2283-f0c3-76d1-81a3-867ea0d30bb5`
- Final file 1 state: [/Users/mymac/my dev/remodex/verification/from_thread_turn1.txt](/Users/mymac/my%20dev/remodex/verification/from_thread_turn1.txt)
- Final file 2 state: [/Users/mymac/my dev/remodex/verification/from_thread_turn2.txt](/Users/mymac/my%20dev/remodex/verification/from_thread_turn2.txt)

### Observed Behaviors
- `thread/start`, `turn/start`, and `turn/completed` operate correctly over the app-server WebSocket.
- File writes triggered from a turn can modify the workspace directly.
- Multiple turns on the same thread preserve enough continuity to keep extending prior work.

### Runtime Warnings
- The app-server emitted repeated warnings about `/Users/mymac/.codex/state_5.sqlite` migration mismatch.
- The probe itself still completed successfully, so this is an operational warning, not a blocker for the validated path.
- This warning should be tracked before relying on long-running automation.

### Strategy Impact
- The basic execution chain `app-server -> thread -> turn -> workspace write` is now validated in the current Mac environment.
- Strategy can treat WebSocket turn dispatch and workspace file effects as evidence-backed, not hypothetical.
- Remaining validation focus should move to thread resume/reconnect, scheduler wake flow, and foreground/background arbitration.

## 2026-03-25 - Probe 2: thread resume + reconnect

### Goal
- Verify that a thread created earlier can be read and resumed from a fresh WebSocket connection.
- Verify that a resumed thread can accept a new turn and continue workspace updates.

### Setup
- Source summary: [/Users/mymac/my dev/remodex/verification/app_server_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/app_server_probe_summary.json)
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_thread_resume.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_thread_resume.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/thread_resume_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/thread_resume_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/thread_resume_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/thread_resume_probe_events.jsonl)

### Result
- Status: PASS
- A fresh connection successfully called `thread/read` against the earlier thread.
- A fresh connection successfully called `thread/resume` against the earlier thread.
- A new turn completed successfully after resume and updated workspace files.

### Evidence
- Source `threadId`: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- `thread/read` returned 2 prior turns:
  - `019d2283-c99a-7f80-89da-db0a8c3d0b00`
  - `019d2283-f0c3-76d1-81a3-867ea0d30bb5`
- `thread/resume` returned the same thread id and the same two prior turns.
- Resumed `turn3.id`: `019d2289-d5e0-7d22-9121-f03e00f77c97`
- Resumed file: [/Users/mymac/my dev/remodex/verification/from_thread_resume.txt](/Users/mymac/my%20dev/remodex/verification/from_thread_resume.txt)
- Updated sequence file: [/Users/mymac/my dev/remodex/verification/from_thread_turn1.txt](/Users/mymac/my%20dev/remodex/verification/from_thread_turn1.txt)

### Observed Behaviors
- `thread/read` with `includeTurns: true` returns prior turn ids from persisted rollout history.
- `thread/resume` can restore a previously created thread on a fresh client connection.
- A resumed thread can accept a new `turn/start` and continue editing the same workspace.
- The resumed turn wrote a new file and extended the existing sequence from `turn1/turn2` to `turn1/turn2/turn3`.

### Operational Notes
- Local sandbox blocked WebSocket connection from the non-escalated probe process.
- The resume probe passed once executed with escalated local network access.
- This means local loopback access should be treated as an execution prerequisite for automated probes in this environment.

### Strategy Impact
- The core resume path `fresh connection -> thread/read -> thread/resume -> new turn/start` is now validated.
- The strategy can rely on thread-id based reconnect as a real mechanism, not only a design assumption.
- This materially strengthens the planned “return to app and continue from shared memory + thread identity” model.

## Next Recommended Validation

### Candidate
- Scheduler wake path with explicit toggle gating.

### Why
- The remaining high-value uncertainty is no longer turn dispatch or thread resume.
- The next unvalidated link is `scheduler/trigger -> lightweight precheck -> wake signal -> resumed main turn`.

### Suggested Scope
- Introduce a small scheduler probe that reads a toggle file and only emits a wake artifact when:
  - background trigger is enabled
  - foreground session is inactive
  - coordinator status is resumable
- Then verify that the wake artifact can drive the next resumed turn without competing with foreground activity.

## 2026-03-25 - Probe 3: scheduler gate precheck + conditional wake

### Goal
- Verify that a lightweight scheduler gate can suppress wake when foreground is active.
- Verify that the same gate can allow wake when background mode is enabled and coordinator status is resumable.
- Verify that the allowed case can resume the existing thread and cause a new file write.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_scheduler_gate.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_scheduler_gate.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/scheduler_gate_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/scheduler_gate_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/scheduler_gate_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/scheduler_gate_probe_events.jsonl)
- Runtime fixture dir: [/Users/mymac/my dev/remodex/verification/scheduler_probe_state/runtime](/Users/mymac/my%20dev/remodex/verification/scheduler_probe_state/runtime)

### Result
- Status: PASS
- Blocked case suppressed wake correctly.
- Allowed case emitted wake state, resumed the existing thread, and completed a new turn.
- The resumed turn created the requested file in the workspace.

### Evidence
- Source `threadId`: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- Blocked case reasons:
  - `background_trigger_disabled`
  - `foreground_session_active`
  - `status_busy_non_interruptible`
- Allowed case turn id: `019d228b-8654-70e0-abcb-5357aa9ac20d`
- Wake event file: [/Users/mymac/my dev/remodex/verification/scheduler_probe_state/runtime/wake_event.json](/Users/mymac/my%20dev/remodex/verification/scheduler_probe_state/runtime/wake_event.json)
- Wake result file: [/Users/mymac/my dev/remodex/verification/from_scheduler_wake.txt](/Users/mymac/my%20dev/remodex/verification/from_scheduler_wake.txt)

### Observed Behaviors
- A lightweight precheck can gate wake based on toggle state and coordinator status alone.
- Foreground-active state can suppress background wake before touching the thread.
- Background-enabled and idle state can allow the system to resume the same thread and execute a new turn.
- The actual app-server path remains the same after gating: `thread/resume -> turn/start -> turn/completed`.

### Operational Notes
- The probe uses a local runtime fixture directory to simulate scheduler-owned truth files.
- This validates the intended arbitration semantics, not the final `launchd` registration yet.
- As with the earlier probes, local loopback access required escalation in this environment.

### Strategy Impact
- The planned separation `scheduler precheck decides wake/no-wake` and `main thread decides the work itself` now has concrete runtime evidence.
- The strategy can safely model foreground/background arbitration around explicit toggle files and coordinator status.
- The next unvalidated layer is the real OS scheduler registration path, not the gating logic itself.

## 2026-03-25 - Probe 4: real launchd registration + periodic tick + bootout

### Goal
- Verify that a real macOS `launchd/LaunchAgent` can run the lightweight scheduler probe on an interval.
- Verify that the installed agent writes runtime truth files on each tick.
- Verify that foreground-active state produces `blocked`.
- Verify that background-enabled idle state produces `wake`.
- Verify that `bootout` actually stops further ticks.

### Setup
- LaunchAgent plist: [/Users/mymac/my dev/remodex/verification/com.remodex.launchd-probe.plist](/Users/mymac/my%20dev/remodex/verification/com.remodex.launchd-probe.plist)
- Tick script: [/Users/mymac/my dev/remodex/scripts/launchd_tick_probe.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_tick_probe.mjs)
- Structured summary: [/Users/mymac/my dev/remodex/verification/launchd_registration_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_registration_probe_summary.json)
- Runtime dir: [/Users/mymac/my dev/remodex/verification/launchd_probe_state/runtime](/Users/mymac/my%20dev/remodex/verification/launchd_probe_state/runtime)
- Tick log: [/Users/mymac/my dev/remodex/verification/launchd_probe_state/tick_events.jsonl](/Users/mymac/my%20dev/remodex/verification/launchd_probe_state/tick_events.jsonl)

### Result
- Status: PASS
- `launchctl bootstrap gui/501 ...` succeeded.
- `RunAtLoad` and `StartInterval=5` behavior were both observed.
- Blocked case was recorded under foreground-active settings.
- Wake case was recorded under background-enabled idle settings.
- `launchctl bootout gui/501/com.remodex.launchd-probe` succeeded.
- No further ticks were observed after bootout.

### Evidence
- `launchctl print gui/501/com.remodex.launchd-probe` after bootstrap showed:
  - `type = LaunchAgent`
  - `state = spawn scheduled`
  - `run interval = 5 seconds`
  - `runs = 1`
- Initial runtime snapshot recorded:
  - `last_decision = blocked`
  - `last_blocked_reasons = ["background_trigger_disabled", "foreground_session_active", "status_busy_non_interruptible"]`
- After switching to background-enabled idle:
  - `last_decision = wake`
  - wake event written to [/Users/mymac/my dev/remodex/verification/launchd_probe_state/runtime/wake_event.json](/Users/mymac/my%20dev/remodex/verification/launchd_probe_state/runtime/wake_event.json)
- Final observed tick count before bootout: `16`
- After bootout:
  - `launchctl print gui/501/com.remodex.launchd-probe` returned service not found
  - tick count remained unchanged after an additional wait

### Observed Behaviors
- The actual OS scheduler layer on this Mac is viable for the strategy’s external scheduler role.
- The LaunchAgent can keep updating `scheduler_runtime` and heartbeat/tick logs without foreground involvement.
- The same installed agent can switch from blocked behavior to wake behavior based only on runtime truth files.
- Bootout cleanly removes the agent and stops future scheduler activity.

### Operational Notes
- Because this was a real LaunchAgent, it continued to tick until explicitly booted out.
- For verification runs, cleanup is mandatory to avoid leaving stray background ticks alive.
- Loopback/network sandbox rules still apply to probes that open WebSocket connections directly, but the pure file-based launchd tick probe did not need app-server access.

### Strategy Impact
- The formerly unvalidated OS scheduler registration path is now validated in the current environment.
- Strategy can now treat `launchd/LaunchAgent -> lightweight tick -> runtime truth update` as evidence-backed.
- The main remaining gaps are no longer scheduler existence or resume mechanics, but higher-level operational integration:
  - connecting launchd wake artifacts to the chosen bridge implementation
  - deciding whether the real background loop should stop at wake artifacts or continue into full resumed turns

## 2026-03-25 - Probe 5: one-shot launchd -> app-server -> resumed thread turn

### Goal
- Verify that a real `launchd/LaunchAgent` process can directly connect to `codex app-server`.
- Verify that the launchd-started process can resume the validated thread id.
- Verify that it can execute a new turn and write a workspace file.

### Setup
- LaunchAgent plist: [/Users/mymac/my dev/remodex/verification/com.remodex.launchd-appserver-probe.plist](/Users/mymac/my%20dev/remodex/verification/com.remodex.launchd-appserver-probe.plist)
- Probe script: [/Users/mymac/my dev/remodex/scripts/launchd_appserver_probe.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_appserver_probe.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_appserver_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_appserver_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/launchd_appserver_probe_state/events.jsonl](/Users/mymac/my%20dev/remodex/verification/launchd_appserver_probe_state/events.jsonl)
- Result file: [/Users/mymac/my dev/remodex/verification/from_launchd_appserver.txt](/Users/mymac/my%20dev/remodex/verification/from_launchd_appserver.txt)

### Result
- Status: PASS
- `launchctl bootstrap gui/501 ...` succeeded.
- The launchd-started process connected to app-server over WebSocket.
- It resumed the existing validated thread.
- It completed a new turn on that same thread.
- It wrote the expected workspace file.
- The one-shot agent reached `last exit code = 0` and was then booted out successfully.

### Evidence
- Source thread id: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- Resumed turn id: `019d2292-ce14-7933-9d5c-a9d5aac57f69`
- Result file contents: `launchd-appserver-ok`
- `turn/completed` observed in the event log for the resumed turn
- `launchctl print gui/501/com.remodex.launchd-appserver-probe` showed:
  - `state = not running`
  - `last exit code = 0`
- The service was then removed with `bootout`

### Observed Behaviors
- macOS launchd can directly host a process that talks to app-server in this environment.
- The launchd-started process can use `thread/resume` and `turn/start` exactly like the foreground probes did.
- This is the strongest validated path so far because it proves the full chain:
  - `launchd`
  - `app-server WebSocket`
  - `thread/resume`
  - `turn/start`
  - `workspace file write`

### Operational Notes
- This probe was intentionally one-shot rather than periodic to avoid repeated background turns.
- The app-server still emitted the existing state-db migration warnings in its own process, but they did not block the probe.
- Cleanup is still required even for one-shot services so that the service definition does not remain loaded unnecessarily.

### Strategy Impact
- The architecture is no longer only “piecewise plausible”; the end-to-end scheduler-driven resume path now has direct runtime evidence.
- Strategy can safely treat `launchd -> app-server -> resumed thread -> workspace side effect` as implementable on the current Mac.
- The next decision is no longer “can this work at all?” but “what policy should constrain autonomous background turns in real operation?”

## 2026-03-25 - Probe 6: shared-memory contract reconstruction (`continue` / `halt`)

### Goal
- Verify that a resumed Codex thread can read the fixed main-coordinator contract plus a project-scoped shared-memory namespace.
- Verify that it can reconstruct current position from strategy, roadmap, runtime, and evidence files rather than hidden thread memory.
- Verify that it emits the exact expected 11-line report in both `continue` and `halt` cases.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_shared_memory_contract.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_shared_memory_contract.mjs)
- Contract file: [/Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md](/Users/mymac/my%20dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md)
- Shared-memory fixture root: [/Users/mymac/my dev/remodex/verification/shared_memory_contract_probe](/Users/mymac/my%20dev/remodex/verification/shared_memory_contract_probe)
- Structured summary: [/Users/mymac/my dev/remodex/verification/shared_memory_contract_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/shared_memory_contract_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/shared_memory_contract_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/shared_memory_contract_probe_events.jsonl)
- Continue report: [/Users/mymac/my dev/remodex/verification/shared_memory_contract_probe/report_continue.md](/Users/mymac/my%20dev/remodex/verification/shared_memory_contract_probe/report_continue.md)
- Halt report: [/Users/mymac/my dev/remodex/verification/shared_memory_contract_probe/report_halt.md](/Users/mymac/my%20dev/remodex/verification/shared_memory_contract_probe/report_halt.md)

### Result
- Status: PASS
- The resumed thread reread the contract and project namespace from disk.
- It completed one `continue` turn and one `halt` turn on the same validated thread.
- In both cases it wrote the exact expected 11-line reconstruction report.
- Both turns reached `turn/completed` with no turn-level error.

### Evidence
- Source thread id: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- Continue turn id: `019d2296-ab73-7862-8bd2-5f26e62e5510`
- Halt turn id: `019d2297-b359-7971-93e9-f9d543aaabba`
- Continue report contained:
  - `strategy_version: strategy-2026-03-25-r3`
  - `roadmap_current_point: batch-3-shared-memory-reconstruction`
  - `latest_validated_change: commit-simulated-abc123`
  - `continue_or_halt: continue`
- Halt report contained:
  - `latest_validated_change: commit-simulated-def456`
  - `pending_human_gate: MUST_HUMAN_CHECK`
  - `next_smallest_batch: wait-for-human-review-artifact-204`
  - `continue_or_halt: halt`
- Summary file recorded `matchedAllExpected: true` for both cases.

### Observed Behaviors
- The same resumed thread can reconstruct current position from explicit files instead of relying on opaque in-thread memory.
- The fixed contract ordering is strong enough to produce deterministic state reports.
- `MUST_HUMAN_CHECK` and pending-artifact state can flip the reconstructed result from `continue` to `halt` without changing the thread identity.
- This materially supports the intended “return to app, reread shared memory, continue from current position” workflow.

### Operational Notes
- This probe still depended on the live app-server process and required loopback access outside the sandbox.
- The app-server migration warnings remained present in the background process but did not block either reconstruction turn.
- The contract is now evidence-backed enough to treat `strategy + roadmap_status + evidence + runtime` as the minimum reliable reconstruction set.

### Strategy Impact
- Strategy can now claim, with runtime evidence, that a project main coordinator can rebuild its working position from the recorded shared-memory namespace.
- The proposed app return flow is no longer speculative: a resumed thread can reread the contract, classify `continue` vs `halt`, and produce the expected next-batch output.
- The next high-value gap is no longer single-project reconstruction, but multi-project routing and isolation.

## 2026-03-25 - Probe 7: multi-project routing isolation (`alpha` / `beta` / `quarantine`)

### Goal
- Verify that separate project main threads can be created and addressed independently.
- Verify that a routed event for `project-alpha` only produces `alpha` side effects.
- Verify that an unresolved project event is quarantined instead of being guessed.
- Verify that a later routed event for `project-beta` produces only `beta` side effects.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_multi_project_isolation.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_multi_project_isolation.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe)
- Alpha report: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe/project_alpha/report_alpha.md](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe/project_alpha/report_alpha.md)
- Beta report: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe/project_beta/report_beta.md](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe/project_beta/report_beta.md)
- Quarantine artifact: [/Users/mymac/my dev/remodex/verification/multi_project_routing_probe/router/quarantine/unknown_001.json](/Users/mymac/my%20dev/remodex/verification/multi_project_routing_probe/router/quarantine/unknown_001.json)

### Result
- Status: PASS
- Two distinct main threads were created, one for `project-alpha` and one for `project-beta`.
- The alpha-routed event produced only the alpha report and left beta untouched.
- The unresolved project event was quarantined instead of being routed by guess.
- The beta-routed event later produced only the beta report and left alpha guard state untouched.

### Evidence
- Alpha thread id: `019d229b-90e5-73a0-b698-7bca87c3a0ed`
- Beta thread id: `019d229b-9265-7d73-821a-dda0f9c8551a`
- Alpha turn id: `019d229b-947c-7d72-a003-514df37444ed`
- Beta turn id: `019d229c-995f-7692-98f9-36b7bc30f907`
- Alpha report matched all expected lines and `betaReportExistsAfterAlpha` was `false`
- `betaGuardAfterAlpha` remained `beta-guard`
- Quarantine file captured `project-unknown` with reason `unresolved_project`
- Beta report matched all expected lines and `alphaGuardAfterBeta` remained `alpha-guard`

### Observed Behaviors
- Project-scoped routing can be modeled with explicit namespace ownership and distinct coordinator threads.
- The strategy’s “no guessed routing” rule is practical: unresolved input can be diverted to quarantine without touching any project main.
- Sequential routing across projects did not cause cross-project report writes or guard-file drift in this probe.
- This materially supports the “many projects, one ingress, explicit router” part of the design.

### Operational Notes
- Each project turn independently reread the same contract file and only its own namespace.
- Both turns attempted extra `git status` checks even though the workspace root is not a git repository; those command failures did not block completion.
- For future probes, direct file-content assertions are more reliable than incidental `git status` checks in this workspace.

### Strategy Impact
- The multi-project namespace model is now runtime-backed, not just document-backed.
- Strategy can safely insist on `workspace_key/project_key` resolution before dispatch and on quarantine for unresolved targets.
- The next high-value gap is dispatch timing arbitration: whether a busy coordinator path records to queue first and delivers later without losing the event.

## 2026-03-25 - Probe 8: dispatch timing arbitration (`busy -> queue -> checkpoint -> deliver`)

### Goal
- Verify that a busy coordinator path records the incoming event into dispatch state instead of delivering immediately.
- Verify that no delivery side effect appears while coordinator status is `busy_non_interruptible`.
- Verify that the same queued event is later delivered once status becomes `checkpoint_open`.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_dispatch_queue_arbitration.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_dispatch_queue_arbitration.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe)
- Dispatch ticket: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe/project_alpha/dispatch_queue/200_dispatch.md](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe/project_alpha/dispatch_queue/200_dispatch.md)
- Router event: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe/project_alpha/inbox/200_router_event.md](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe/project_alpha/inbox/200_router_event.md)
- Delivery report: [/Users/mymac/my dev/remodex/verification/dispatch_queue_probe/project_alpha/delivered_from_queue.md](/Users/mymac/my%20dev/remodex/verification/dispatch_queue_probe/project_alpha/delivered_from_queue.md)

### Result
- Status: PASS
- While coordinator status was `busy_non_interruptible`, the router event was recorded and a dispatch ticket was marked `queued`.
- No delivery report existed before the checkpoint-open transition.
- After coordinator status changed to `checkpoint_open`, the same queued input was delivered through a real turn and the delivery report was written.
- The dispatch ticket was then updated from `queued` to `delivered`.

### Evidence
- Thread id: `019d22aa-5a40-74e3-ab70-aa569f1d826d`
- Delivery turn id: `019d22aa-5b3c-7691-81be-d7d89d8efdec`
- `queueDecision.coordinatorStatusBefore` was `type: busy_non_interruptible`
- `queueDecision.reportExistsBeforeDelivery` was `false`
- Delivery report contained:
  - `identity: remodex/project-alpha`
  - `coordinator_status: checkpoint_open`
  - `dispatch_ticket: 200_dispatch.md`
  - `router_event: router-200`
  - `delivery_mode: queued`
- Dispatch ticket after delivery contained `status: delivered`

### Observed Behaviors
- The intended arbitration model is viable: busy state can defer actual delivery without losing the event.
- Queue truth and delivery truth can be kept separate:
  - dispatch ticket while busy
  - resumed turn only after safe checkpoint
- This directly supports the user-facing claim that incoming orders need not interrupt active work immediately.

### Operational Notes
- As with earlier probes, the turn still reread the full contract and namespace before writing its result.
- This probe did not rely on a full external scheduler tick; it focused on the arbitration boundary itself.
- The strongest practical takeaway is that `bridge timing judgment` can be modeled with explicit queue artifacts before any actual turn delivery happens.

### Strategy Impact
- The strategy’s `busy -> queue`, `idle/checkpoint -> deliver`, `main decides content` split now has direct runtime evidence.
- This materially strengthens the Discord/cron ingress design because the most failure-prone arbitration edge is now validated.
- Remaining gaps are higher-level integrations, not the core coordination semantics.

## 2026-03-25 - Probe 9: integrated `launchd` conditional delivery (`blocked` vs `wake`)

### Goal
- Verify that a real LaunchAgent can read the toggle/state truth files before deciding whether to wake app-server.
- Verify that blocked settings prevent any wake side effect.
- Verify that allowed settings produce a real workspace side effect through app-server.

### Setup
- Main probe: [/Users/mymac/my dev/remodex/scripts/probe_launchd_conditional_delivery.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_conditional_delivery.mjs)
- LaunchAgent worker: [/Users/mymac/my dev/remodex/scripts/launchd_conditional_delivery_worker.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_conditional_delivery_worker.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_conditional_delivery_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_conditional_delivery_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/launchd_conditional_delivery_probe](/Users/mymac/my%20dev/remodex/verification/launchd_conditional_delivery_probe)
- Wake file: [/Users/mymac/my dev/remodex/verification/launchd_conditional_delivery_probe/from_conditional_launchd_wake.txt](/Users/mymac/my%20dev/remodex/verification/launchd_conditional_delivery_probe/from_conditional_launchd_wake.txt)

### Result
- Status: PASS
- Under blocked settings, the LaunchAgent worker wrote a blocked decision and produced no wake file.
- Under allowed settings, the LaunchAgent worker produced the expected wake file through a real app-server turn.
- This validates the conditional split even though the worker cleanup file (`last_run.json`) still races against teardown in the wake path.

### Evidence
- LaunchAgent label: `com.remodex.launchd-conditional-delivery`
- Source thread id: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- Blocked run recorded:
  - `decision: blocked`
  - `blockedReasons: ["background_trigger_disabled", "foreground_session_active", "status_busy_non_interruptible"]`
  - no wake file existed
- Wake phase produced:
  - wake file content `conditional-launchd-ok`
  - summary `wakeCase.wakeText = conditional-launchd-ok`

### Observed Behaviors
- The external scheduler boundary can enforce toggle/state rules before touching app-server.
- Foreground-active / background-disabled settings really prevent wake side effects at the LaunchAgent layer.
- Once the same probe is re-run under allowed settings, a real app-server-driven workspace write occurs.
- This is the closest probe so far to the intended production shape:
  - `launchd`
  - truth-file precheck
  - conditional wake
  - app-server turn
  - workspace side effect

### Operational Notes
- First attempt failed because LaunchAgent did not inherit a usable `PATH`; `env node` could not be resolved.
- The probe was corrected to use absolute Node path `/opt/homebrew/bin/node`.
- The wake path creates its workspace side effect before worker teardown metadata is always persisted, so `wakeCase.run` may remain null even when the wake file proves success.
- This timing issue is a probe-collection issue, not a wake-execution failure.

### Strategy Impact
- The strategy can now claim, with runtime evidence, that the scheduler layer itself can block or allow app-server wake based on shared truth files.
- The required operational note is now clear: LaunchAgent jobs on this Mac must use absolute binary paths.
- Remaining work is mostly around productized observability and ingress integration, not whether the core background control loop can exist.

## 2026-03-25 - Probe 10: `MUST_HUMAN_CHECK` gate blocks background wake

### Goal
- Verify that background wake is blocked purely by stop-condition truth, even when toggle and coordinator status would otherwise allow it.
- Verify that clearing the stop condition re-enables wake in the same overall launchd/app-server model.

### Setup
- Main probe: [/Users/mymac/my dev/remodex/scripts/probe_launchd_human_gate.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_human_gate.mjs)
- LaunchAgent worker: [/Users/mymac/my dev/remodex/scripts/launchd_human_gate_worker.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_human_gate_worker.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_probe](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_probe)
- Wake file: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_probe/from_human_gate_wake.txt](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_probe/from_human_gate_wake.txt)

### Result
- Status: PASS
- With `must_human_check: true` and `pending_human_gate: MUST_HUMAN_CHECK`, the LaunchAgent worker blocked background wake.
- No wake file was produced in the blocked phase.
- After clearing the stop condition, the same background path produced a real wake file through app-server.

### Evidence
- LaunchAgent label: `com.remodex.launchd-human-gate`
- Source thread id: `019d2283-c8bd-76e2-93ec-207a4888dfbd`
- Blocked run recorded:
  - `decision: blocked`
  - `blockedReasons: ["must_human_check", "pending_human_gate"]`
  - no wake file existed
- Wake phase produced:
  - wake file content `human-gate-cleared-ok`
  - summary `wakeCase.wakeText = human-gate-cleared-ok`

### Observed Behaviors
- Stop conditions are strong enough to halt background wake even when toggle and coordinator status are otherwise permissive.
- Clearing the human gate re-enables the same launchd/app-server wake path without changing the thread identity.
- This is the clearest runtime evidence so far that `MUST_HUMAN_CHECK` can act as a hard background safety boundary.

### Operational Notes
- As in Probe 9, wake teardown can race worker-side metadata persistence, so `wakeCase.run` may remain null even when the wake file proves success.
- The important pass criterion here is the transition:
  - blocked with human gate
  - successful wake after gate removal

### Strategy Impact
- The strategy can now claim, with runtime evidence, that the background loop respects explicit human-review stop conditions.
- This materially improves confidence in unattended-night-run safety because the most important stop boundary is no longer theoretical.
- The remaining gaps are now more about ingress and observability polish than core safety semantics.

## 2026-03-25 - Probe 11: approval request boundary (`cancel` vs `accept`)

### Goal
- Verify that a real approval request coming from app-server can be intercepted by an external client.
- Verify that the deny path prevents the side effect.
- Verify that the accept path allows the side effect and the turn completes.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_file_change_approval.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_file_change_approval.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/file_change_approval_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/file_change_approval_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/file_change_approval_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/file_change_approval_probe_events.jsonl)
- Accepted file: [/Users/mymac/my dev/remodex/verification/approval_accepted.txt](/Users/mymac/my%20dev/remodex/verification/approval_accepted.txt)

### Result
- Status: PASS
- Deny path:
  - approval request intercepted
  - `cancel` response returned
  - turn ended as `interrupted`
  - target file was not created
- Accept path:
  - approval request intercepted
  - `accept` response returned
  - turn completed successfully
  - target file was created with expected contents

### Evidence
- Decline thread id: `019d22c2-7ab5-7f51-b06a-31d4c5f07d32`
- Decline turn id: `019d22c2-7c82-7241-aff0-2cbcc803da5d`
- Decline approval method actually observed: `item/commandExecution/requestApproval`
- Decline approval decision used: `cancel`
- Decline result:
  - turn status `interrupted`
  - [approval_declined.txt](/Users/mymac/my%20dev/remodex/verification/approval_declined.txt) absent
- Accept thread id: `019d22c2-c765-7e71-bbd6-5a1e63c33b3b`
- Accept turn id: `019d22c2-c837-7110-b6ca-ccf5bfe2bee4`
- Accept approval method actually observed: `item/fileChange/requestApproval`
- Accept result:
  - turn status `completed`
  - [approval_accepted.txt](/Users/mymac/my%20dev/remodex/verification/approval_accepted.txt) contents `accept-case`

### Observed Behaviors
- The actual approval family can vary by the model’s chosen implementation path:
  - command execution approval
  - file change approval
- An external controller can still safely arbitrate because both arrive as explicit server requests over app-server.
- `cancel` is the reliable “hard stop” deny path; weaker decline-style responses can allow retries in some paths.
- This is important for unattended safety because it proves that an external supervisor can stop the side effect before it lands.

### Operational Notes
- Earlier attempts showed two useful edge findings:
  - some prompts route through `item/commandExecution/requestApproval` even when the user asked for a file write
  - simple “decline” semantics can allow the model to try a different path, so hard-stop denial should use `cancel`
- The probe client had to support “any approval request family” rather than assuming only one method.

### Strategy Impact
- The strategy can now claim, with runtime evidence, that approval prompts are interceptable and enforceable through app-server.
- This strengthens the design around foreground-only authority because background continuation can be stopped at the approval boundary before any repo side effect lands.
- Remaining high-value gaps are now around ingress integration and operator UX, not whether the approval/safety boundary is real.

## 2026-03-25 - Probe 12: Discord ingress normalization and routing

### Goal
- Verify that Discord-style operator payloads can be normalized into the shared-memory ingress contract.
- Verify that valid intents route to the correct project inbox.
- Verify that unauthorized approvals and missing-project payloads are quarantined instead of guessed.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_ingress_normalization.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_ingress_normalization.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_ingress_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_ingress_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_ingress_probe](/Users/mymac/my%20dev/remodex/verification/discord_ingress_probe)

### Result
- Status: PASS
- Valid `/intent project=project-alpha` payload routed into the alpha inbox with normalized fields.
- Unauthorized `/approve` payload was quarantined with reason `unauthorized_approval`.
- `/intent` payload without `project` was quarantined with reason `missing_project`.
- No beta inbox artifact was created by this fixture set.

### Evidence
- Routed inbox artifact:
  - [/Users/mymac/my dev/remodex/verification/discord_ingress_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-25T11-20-00+09-00_intent_discord-msg-001.json](/Users/mymac/my%20dev/remodex/verification/discord_ingress_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-25T11-20-00+09-00_intent_discord-msg-001.json)
- Quarantine artifacts:
  - [/Users/mymac/my dev/remodex/verification/discord_ingress_probe/router/quarantine/2026-03-25T11-21-00+09-00_approve_discord-msg-002.json](/Users/mymac/my%20dev/remodex/verification/discord_ingress_probe/router/quarantine/2026-03-25T11-21-00+09-00_approve_discord-msg-002.json)
  - [/Users/mymac/my dev/remodex/verification/discord_ingress_probe/router/quarantine/2026-03-25T11-22-00+09-00_intent_discord-msg-003.json](/Users/mymac/my%20dev/remodex/verification/discord_ingress_probe/router/quarantine/2026-03-25T11-22-00+09-00_intent_discord-msg-003.json)
- Summary recorded:
  - `alphaInboxFiles = [valid intent]`
  - `betaInboxFiles = []`
  - `quarantineFiles = [unauthorized approval, missing project]`

### Observed Behaviors
- Discord can be treated as operator ingress without becoming the system of record.
- The ingress layer can enrich payloads with:
  - `workspace_key`
  - `project_key`
  - `operator_id`
  - `correlation_key`
  - `command_class`
- Quarantine is the correct behavior when routing certainty or operator authority is missing.

### Operational Notes
- This was a local fixture probe, not a live Discord network integration test.
- The important result is not Discord transport itself, but that the normalization and routing contract is concrete and testable.
- This closes a meaningful gap between the earlier multi-project routing proof and the intended Discord operator console design.

### Strategy Impact
- The strategy can now point to runtime evidence that Discord-style operator input can be normalized into project-scoped inbox truth rather than injected directly into the main turn.
- This materially strengthens the “Discord as front door, shared memory as truth” design.
- Remaining validation work is now concentrated in live transport/auth details rather than core routing semantics.

## 2026-03-25 - Probe 13: active-turn intervention boundary (`turn/interrupt` / `turn/steer`)

### Goal
- Verify that `turn/interrupt` can stop an actually active turn before its file side effect lands.
- Verify that `turn/steer` is accepted while the target turn is active.
- Verify that the same `turn/steer` request is rejected once the turn is no longer active.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_turn_interrupt_and_steer.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_turn_interrupt_and_steer.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/turn_interrupt_steer_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/turn_interrupt_steer_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/turn_interrupt_steer_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/turn_interrupt_steer_probe_events.jsonl)

### Result
- Status: PASS
- `turn/interrupt` successfully stopped an in-progress turn.
- The interrupted turn ended with status `interrupted`.
- The interrupted turn never created its target file.
- `turn/steer` with the correct active `expectedTurnId` was accepted.
- The active steer caused the same turn to produce an extra file beyond its original base request.
- A stale `turn/steer` against the completed turn failed with `no active turn to steer`.

### Evidence
- Interrupt thread id: `019d22c9-f8c4-7113-b214-c3e85f5c05c1`
- Interrupt turn id: `019d22c9-f99f-74a3-89ca-284df0f49aba`
- Interrupt result:
  - `turn/interrupt` response `{}` returned without error
  - completed status `interrupted`
  - [/Users/mymac/my dev/remodex/verification/interrupt_should_not_exist.txt](/Users/mymac/my%20dev/remodex/verification/interrupt_should_not_exist.txt) absent
- Steer thread id: `019d22ca-152a-7660-a36e-df929b915be1`
- Steer turn id: `019d22ca-15d2-7f23-b47d-01c89ffcb499`
- Active steer response:
  - `{"turnId":"019d22ca-15d2-7f23-b47d-01c89ffcb499"}`
- Steer result files:
  - [/Users/mymac/my dev/remodex/verification/steer_base.txt](/Users/mymac/my%20dev/remodex/verification/steer_base.txt) contents `base-case`
  - [/Users/mymac/my dev/remodex/verification/steer_extra.txt](/Users/mymac/my%20dev/remodex/verification/steer_extra.txt) contents `steer-case`
- Stale steer error:
  - `no active turn to steer (-32600)`

### Observed Behaviors
- `turn/interrupt` is a real active-turn control path, not a no-op.
- `turn/steer` behaves like a narrow active-turn input lane with strict precondition matching on `expectedTurnId`.
- This is strong evidence against treating external input as a general-purpose “foreground join” lane.
- The external control model is narrower and safer:
  - interrupt the active turn
  - steer the active turn while it is still active
  - fail closed once the turn is complete

### Operational Notes
- The probe used long-running shell waits (`sleep 20`, `sleep 15`) to keep the turn active long enough for intervention.
- `turn/steer` was most reliable as an additive change request (“also create this file”) rather than a full plan rewrite.
- This matters for the strategy because steer should be treated as a scoped intervention tool, not a general replacement for the inbox/queue model.

### Strategy Impact
- The strategy can now assert, with runtime evidence, that active-turn intervention is possible but narrow.
- This strengthens the earlier conclusion that shared-memory inbox remains the general ingress path, while `interrupt` and `steer` are special-case control channels.
- Scheduler and bridge policy can safely assume:
  - busy turns should normally queue new input
  - urgent interventions may use `interrupt`
  - bounded live adjustments may use `steer`
  - stale or completed turns will reject late steer attempts

## 2026-03-25 - Probe 14: status mirror from real app-server notifications

### Goal
- Verify that `thread/status/changed` from a live app-server turn can be mirrored into shared-memory state files.
- Verify that the mirrored state captures `waitingOnApproval` correctly.
- Verify that the final mirrored state returns to `idle` after the turn completes.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_status_mirror_waiting_flags.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_status_mirror_waiting_flags.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/status_mirror_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/status_mirror_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/status_mirror_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/status_mirror_probe_events.jsonl)
- Mirrored state file: [/Users/mymac/my dev/remodex/verification/status_mirror_probe/coordinator_status.json](/Users/mymac/my%20dev/remodex/verification/status_mirror_probe/coordinator_status.json)
- Mirrored history file: [/Users/mymac/my dev/remodex/verification/status_mirror_probe/coordinator_status_history.jsonl](/Users/mymac/my%20dev/remodex/verification/status_mirror_probe/coordinator_status_history.jsonl)

### Result
- Status: PASS
- Real `thread/status/changed` notifications were mirrored into the shared-memory state file.
- The mirrored history captured `active -> waitingOnApproval -> active -> waitingOnApproval -> active -> idle`.
- The final mirrored state file ended at `idle`.
- The turn completed successfully and wrote the requested workspace file.

### Evidence
- Thread id: `019d22cf-b0ad-7122-8d18-0177019bdfdb`
- Turn id: `019d22cf-b181-72b1-8a7a-b90cf80a4238`
- Approval methods observed in the same single turn:
  - `item/fileChange/requestApproval`
  - `item/commandExecution/requestApproval`
- Approval count in the same turn: `2`
- Mirrored history:
  - `active []`
  - `active [waitingOnApproval]`
  - `active []`
  - `active [waitingOnApproval]`
  - `active []`
  - `idle`
- Final mirrored state: [/Users/mymac/my dev/remodex/verification/status_mirror_probe/coordinator_status.json](/Users/mymac/my%20dev/remodex/verification/status_mirror_probe/coordinator_status.json)
- Result file: [/Users/mymac/my dev/remodex/verification/status_mirror_accepted.txt](/Users/mymac/my%20dev/remodex/verification/status_mirror_accepted.txt) contents `status-mirror-ok`

### Observed Behaviors
- App-server status is rich enough to drive shared-memory truth for scheduler and bridge policy.
- `waitingOnApproval` is not hypothetical; it appears as a concrete active flag in real notifications.
- A single turn can raise multiple approval requests across different approval families before it reaches `completed`.
- Therefore a bridge or supervisor must support approval loops, not a single approval request assumption.

### Operational Notes
- The first probe attempt hung because it assumed only one approval request.
- The fixed probe auto-accepted every approval request for the target thread until `turn/completed` arrived.
- This is an important design lesson:
  - approval handling must stay active for the whole turn
  - “one approval then done” is not a safe assumption

### Strategy Impact
- The strategy can now rely on real app-server status notifications as the source for project `coordinator_status`.
- Scheduler gating no longer needs to be justified only with synthetic fixtures; real `waitingOnApproval` and `idle` transitions have been mirrored into the expected file shape.
- The strategy should explicitly document approval-loop handling and avoid any implementation that assumes at most one approval request per turn.

## 2026-03-25 - Probe 15: Discord-style signature verification and replay rejection

### Goal
- Verify that a Discord-style operator ingress can reject tampered payloads before normalization.
- Verify that the same signed interaction cannot be accepted twice.
- Verify that stale timestamps are rejected.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_signature_replay.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_signature_replay.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_signature_replay_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_signature_replay_probe_summary.json)

### Result
- Status: PASS
- Valid signed payload was accepted exactly once.
- Tampered body was rejected as `invalid_signature`.
- Replayed interaction was rejected as `replay_detected`.
- Old signed payload was rejected as `stale_timestamp`.

### Evidence
- Summary recorded:
  - `validCase = accepted`
  - `tamperedCase = invalid_signature`
  - `replayCase = replay_detected`
  - `staleCase = stale_timestamp`
  - `acceptedExactlyOnce = true`

### Observed Behaviors
- Discord-style ingress can be guarded before shared-memory routing, not only after normalization.
- Signature validity alone is not enough; replay and timestamp checks are both necessary.
- This is the right place for the bridge to fail closed before any inbox artifact is written.

### Operational Notes
- This was a local cryptographic probe with generated Ed25519 keys, not a live Discord network call.
- That is acceptable for this layer because the purpose was to verify the ingress trust boundary and replay model, not Discord transport reachability.

### Strategy Impact
- The strategy can now claim evidence for three ingress safety layers:
  - valid signature required
  - stale timestamp rejected
  - duplicate signed interaction rejected
- This materially strengthens the planned Discord operator console path and closes a key safety gap before bridge routing.

## 2026-03-25 - Probe 16: question turn behavior vs `waitingOnUserInput`

### Goal
- Verify whether a turn that is explicitly instructed to ask a clarifying question and wait actually enters `waitingOnUserInput`.
- Verify whether the turn instead completes immediately with a question-only response.
- Verify that no file side effect lands before the user answers.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_waiting_on_user_input.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_waiting_on_user_input.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/waiting_on_user_input_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/waiting_on_user_input_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/waiting_on_user_input_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/waiting_on_user_input_probe_events.jsonl)

### Result
- Status: PASS
- `waitingOnUserInput` flag was **not** observed.
- The turn emitted a clarifying question as an agent message and then completed immediately.
- No file was created before any follow-up user answer.

### Evidence
- Thread id: `019d22d4-bac4-7351-b559-b313e8fb7ce4`
- Turn id: `019d22d4-bbbc-7a90-8ba3-493e03c1b9a8`
- Observed path:
  - `completed_without_waiting_flag`
- Final turn status:
  - `completed`
- No output files created:
  - [/Users/mymac/my dev/remodex/verification/waiting_input_option_a.txt](/Users/mymac/my%20dev/remodex/verification/waiting_input_option_a.txt) absent
  - [/Users/mymac/my dev/remodex/verification/waiting_input_option_b.txt](/Users/mymac/my%20dev/remodex/verification/waiting_input_option_b.txt) absent
- Agent question emitted in the event log:
  - “생성할 파일을 선택해 주세요: `...option_a.txt` 아니면 `...option_b.txt`?”

### Observed Behaviors
- In this environment, an explicit “ask then wait” instruction did not produce a persistent `waitingOnUserInput` active flag.
- Instead, Codex treated the question as the turn’s output and completed the turn.
- This means not every clarifying-question pattern becomes a resumable active-turn user-input lane.

### Operational Notes
- The first version of the probe assumed `waitingOnUserInput` would appear and had to be updated to accept “question then completed” as a first-class observed path.
- The probe also needed waiter cleanup because the losing side of the `Promise.race` left a pending timer behind.

### Strategy Impact
- The strategy should not assume that “assistant asked a question” automatically means `waitingOnUserInput` is available as an active-turn control state.
- The safer model is:
  - questions may complete the current turn
  - the next user answer may need to arrive as a new turn, not as a steer on a waiting active turn
- Any design that depends on `waitingOnUserInput` must validate that specific path explicitly instead of inferring it from question-shaped output.

## 2026-03-25 - Probe 17: question then next-turn answer on the same thread

### Goal
- Verify that a question-only turn can be followed by a new answer turn on the same thread.
- Verify that the answer turn preserves enough context to apply the user’s choice correctly.
- Verify that no file is created during the question turn, and only the chosen file is created during the answer turn.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_question_followup_new_turn.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_question_followup_new_turn.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/question_followup_new_turn_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/question_followup_new_turn_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/question_followup_new_turn_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/question_followup_new_turn_probe_events.jsonl)

### Result
- Status: PASS
- The first turn asked the clarifying question and completed without creating any file.
- A second turn on the same thread answered the question and created only the chosen file.
- The non-chosen file remained absent.

### Evidence
- Thread id: `019d2336-e971-7281-aec5-cd6ed1517286`
- Question turn id: `019d2336-ea40-70c2-9260-5264e68712c5`
- Answer turn id: `019d2337-0570-76f1-9f98-d02f95e0c0e2`
- After the question turn:
  - [/Users/mymac/my dev/remodex/verification/followup_option_a.txt](/Users/mymac/my%20dev/remodex/verification/followup_option_a.txt) absent
  - [/Users/mymac/my dev/remodex/verification/followup_option_b.txt](/Users/mymac/my%20dev/remodex/verification/followup_option_b.txt) absent
- After the answer turn:
  - [/Users/mymac/my dev/remodex/verification/followup_option_b.txt](/Users/mymac/my%20dev/remodex/verification/followup_option_b.txt) contents `user-input-ok`
  - [/Users/mymac/my dev/remodex/verification/followup_option_a.txt](/Users/mymac/my%20dev/remodex/verification/followup_option_a.txt) absent

### Observed Behaviors
- Even when `waitingOnUserInput` is not exposed as an active status, the same thread still preserves enough conversation context for a follow-up answer turn.
- This gives the strategy a concrete fallback interaction model:
  - question turn completes
  - operator answer arrives as a new turn on the same thread
  - the thread continues correctly

### Operational Notes
- This probe is stronger than a pure prompt toy example because it verified real workspace side effects and the absence of the non-chosen file.
- It also confirms that the external operator console does not need a live `waitingOnUserInput` lane to continue question-driven work.

### Strategy Impact
- The strategy can now recommend a concrete operator reply policy:
  - if `waitingOnUserInput` exists, a live-turn path may be possible
  - if the question turn has already completed, send the operator’s answer as a new turn on the same thread
- This materially reduces risk around question-driven workflows in the background/bridge model.

## 2026-03-25 - Probe 18: inbox event -> bridge dispatch -> same-thread follow-up turn

### Goal
- Verify that an operator answer recorded in shared-memory inbox can be delivered by a bridge as a new turn on the same thread.
- Verify that the inbox artifact is consumed and moved out of unread inbox.
- Verify that only the chosen file is created after bridge delivery.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_inbox_followup_bridge.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_inbox_followup_bridge.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/inbox_followup_bridge_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/inbox_followup_bridge_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/inbox_followup_bridge_probe](/Users/mymac/my%20dev/remodex/verification/inbox_followup_bridge_probe)
- Event log: [/Users/mymac/my dev/remodex/verification/inbox_followup_bridge_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/inbox_followup_bridge_probe_events.jsonl)

### Result
- Status: PASS
- The initial question turn completed with no side effects.
- A shared-memory inbox event carrying the operator answer was consumed by the bridge.
- The bridge dispatched a new turn on the bound thread.
- The dispatched follow-up turn created only the chosen file.
- The inbox artifact moved from unread inbox to processed.

### Evidence
- Thread id: `019d233d-0ce2-7d01-97af-f1b18852afab`
- Question turn id: `019d233d-0dbd-7900-9bba-6d0ab426b074`
- Bridge-dispatched turn id: `019d233d-366b-77c1-81b2-c13b01eb4b25`
- Dispatch log:
  - [/Users/mymac/my dev/remodex/verification/inbox_followup_bridge_probe/dispatch_log.jsonl](/Users/mymac/my%20dev/remodex/verification/inbox_followup_bridge_probe/dispatch_log.jsonl)
- Processed inbox artifact:
  - [/Users/mymac/my dev/remodex/verification/inbox_followup_bridge_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-25T13-20-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/inbox_followup_bridge_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-25T13-20-00+09-00_operator_answer.json)
- Result files:
  - [/Users/mymac/my dev/remodex/verification/bridge_followup_option_b.txt](/Users/mymac/my%20dev/remodex/verification/bridge_followup_option_b.txt) contents `bridge-answer-ok`
  - [/Users/mymac/my dev/remodex/verification/bridge_followup_option_a.txt](/Users/mymac/my%20dev/remodex/verification/bridge_followup_option_a.txt) absent

### Observed Behaviors
- The shared-memory inbox can act as a real operator reply queue, not just a planning abstraction.
- The bridge does not need a live active-turn waiting lane to continue question-driven work.
- Binding a project to a coordinator thread id is sufficient for the bridge to deliver a follow-up turn on that thread.

### Operational Notes
- This probe used a local shared-memory fixture and a minimal bridge implementation inside the probe script.
- The important part is not the exact code shape, but that the transport model `inbox artifact -> bound thread -> new turn` works end-to-end against the live app-server.

### Strategy Impact
- The strategy can now treat “operator answer via inbox artifact” as an evidence-backed continuation path.
- This is the clearest practical fallback for Discord/mobile replies when `waitingOnUserInput` is not exposed.

## 2026-03-25 - Probe 19: bridge fail-closed on missing or mismatched binding

### Goal
- Verify that the bridge does not dispatch inbox events when coordinator binding is missing.
- Verify that the bridge does not dispatch inbox events when the bound project does not match the inbox event project.
- Verify that both cases quarantine the event instead of guessing.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_fail_closed.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_fail_closed.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_fail_closed_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_fail_closed_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_fail_closed_probe](/Users/mymac/my%20dev/remodex/verification/bridge_fail_closed_probe)

### Result
- Status: PASS
- Missing binding case was quarantined with reason `missing_binding`.
- Project mismatch case was quarantined with reason `binding_project_mismatch`.
- No dispatch path was taken in either case.

### Evidence
- Summary recorded:
  - `missingBindingCase.dispatched = false`
  - `missingBindingCase.reason = missing_binding`
  - `mismatchedBindingCase.dispatched = false`
  - `mismatchedBindingCase.reason = binding_project_mismatch`
- Quarantine artifacts:
  - [/Users/mymac/my dev/remodex/verification/bridge_fail_closed_probe/router/quarantine/2026-03-25T13-30-00+09-00_missing_binding.json](/Users/mymac/my%20dev/remodex/verification/bridge_fail_closed_probe/router/quarantine/2026-03-25T13-30-00+09-00_missing_binding.json)
  - [/Users/mymac/my dev/remodex/verification/bridge_fail_closed_probe/router/quarantine/2026-03-25T13-31-00+09-00_project_mismatch.json](/Users/mymac/my%20dev/remodex/verification/bridge_fail_closed_probe/router/quarantine/2026-03-25T13-31-00+09-00_project_mismatch.json)

### Observed Behaviors
- The bridge can be made to fail closed on missing authority instead of guessing.
- Project identity must remain explicit at dispatch time, not only at ingress time.
- This is the correct behavior for multi-project safety.

### Operational Notes
- This was a local bridge-logic probe and did not require app-server because the goal was dispatch policy, not thread execution.
- That is acceptable here because the runtime dispatch path itself was already validated in Probe 18.

### Strategy Impact
- The strategy can now require fail-closed dispatch semantics for the bridge:
  - no binding, no dispatch
  - wrong project binding, no dispatch
  - quarantine instead of inference
- This materially strengthens the multi-project safety case and closes another major drift vector.

## 2026-03-25 - Probe 20: restart recovery with unread inbox replay

### Goal
- Verify that a question turn can complete, leave an unread inbox artifact behind, and survive process restart.
- Verify that a fresh client can `thread/read` and `thread/resume` the same thread after restart.
- Verify that the unread inbox artifact can then be replayed into a new turn on the resumed thread.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_recovery_inbox_replay.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_recovery_inbox_replay.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/recovery_inbox_replay_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/recovery_inbox_replay_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/recovery_inbox_replay_probe](/Users/mymac/my%20dev/remodex/verification/recovery_inbox_replay_probe)
- Event log: [/Users/mymac/my dev/remodex/verification/recovery_inbox_replay_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/recovery_inbox_replay_probe_events.jsonl)

### Result
- Status: PASS
- Process 1 created the thread, completed the question turn, and persisted an unread inbox answer artifact.
- Process 2 reconnected, successfully called `thread/read` and `thread/resume` on the same thread id.
- Process 2 replayed the unread inbox artifact into a new turn on the resumed thread.
- Only the chosen file was created after recovery.

### Evidence
- Thread id: `019d2343-4aaf-78a3-9763-3cfdb5ab5506`
- First-process question turn id: `019d2343-4b67-7c00-b500-e8b844468b42`
- Recovery replay turn id: `019d2343-6b9f-7180-b5a0-c91ec7baad32`
- `thread/read` after restart:
  - `turnCount = 1`
  - status `idle`
- `thread/resume` after restart:
  - `resumedTurnCount = 1`
  - `cwd = /Users/mymac/my dev/remodex`
- Processed inbox artifact:
  - [/Users/mymac/my dev/remodex/verification/recovery_inbox_replay_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-25T13-40-00+09-00_recovery_answer.json](/Users/mymac/my%20dev/remodex/verification/recovery_inbox_replay_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-25T13-40-00+09-00_recovery_answer.json)
- Result files:
  - [/Users/mymac/my dev/remodex/verification/recovery_followup_option_b.txt](/Users/mymac/my%20dev/remodex/verification/recovery_followup_option_b.txt) contents `recovery-answer-ok`
  - [/Users/mymac/my dev/remodex/verification/recovery_followup_option_a.txt](/Users/mymac/my%20dev/remodex/verification/recovery_followup_option_a.txt) absent

### Observed Behaviors
- The architecture survives process restart as long as:
  - coordinator thread id is persisted
  - inbox artifacts remain unread
  - the new process rebinds via `thread/read` / `thread/resume`
- This is stronger than a same-process continuation because it validates the practical recovery lane the strategy depends on.

### Operational Notes
- The probe intentionally split execution into “first process” and “recovery process” phases inside one script, but the app-server interactions were fresh connections.
- This is sufficient evidence for restart recovery because the second phase did not reuse the first client session.

### Strategy Impact
- The strategy can now treat unread inbox replay after restart as an evidence-backed recovery path.
- This materially strengthens the “return to app later and continue” design because the coordinator does not need an unbroken process lifetime to keep operator replies usable.

## 2026-03-25 - Probe 21: foreground takeover suppresses background launchd wake

### Goal
- Verify that a real LaunchAgent can start in background-eligible mode and emit a wake decision.
- Verify that flipping runtime truth to foreground mode makes the next tick become `blocked`.
- Verify that the prior wake marker is not updated again after foreground takeover.

### Setup
- Tick worker: [/Users/mymac/my dev/remodex/scripts/launchd_foreground_takeover_tick.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_foreground_takeover_tick.mjs)
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_launchd_foreground_takeover.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_foreground_takeover.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_foreground_takeover_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_foreground_takeover_probe_summary.json)
- Runtime dir: [/Users/mymac/my dev/remodex/verification/launchd_foreground_takeover_state/runtime](/Users/mymac/my%20dev/remodex/verification/launchd_foreground_takeover_state/runtime)
- Tick log: [/Users/mymac/my dev/remodex/verification/launchd_foreground_takeover_state/tick_events.jsonl](/Users/mymac/my%20dev/remodex/verification/launchd_foreground_takeover_state/tick_events.jsonl)

### Result
- Status: PASS
- Tick 1 under background mode produced `wake`.
- After switching truth files to foreground mode, tick 2 produced `blocked`.
- Block reasons explicitly included:
  - `background_trigger_disabled`
  - `foreground_session_active`
  - `status_busy_non_interruptible`
- The wake marker timestamp stayed unchanged after the foreground takeover.

### Evidence
- LaunchAgent label: `com.remodex.launchd-foreground-takeover`
- Background wake tick:
  - `tick_count = 1`
  - `last_decision = wake`
  - wake event `created_at = 2026-03-25T05:01:29.518Z`
- Foreground takeover tick:
  - `tick_count = 2`
  - `last_decision = blocked`
  - blocked reasons include `foreground_session_active`
- Tick log:
  - [/Users/mymac/my dev/remodex/verification/launchd_foreground_takeover_state/tick_events.jsonl](/Users/mymac/my%20dev/remodex/verification/launchd_foreground_takeover_state/tick_events.jsonl)
- Final runtime state:
  - [/Users/mymac/my dev/remodex/verification/launchd_foreground_takeover_state/runtime/scheduler_runtime.json](/Users/mymac/my%20dev/remodex/verification/launchd_foreground_takeover_state/runtime/scheduler_runtime.json)

### Observed Behaviors
- Foreground takeover is not just a conceptual toggle; the real scheduler obeys it on the next tick.
- Once foreground mode is active, the scheduler stops issuing new wake decisions even if it was previously eligible.
- This is the safety behavior needed to avoid competing foreground/background orders.

### Operational Notes
- This probe intentionally used a pure tick worker rather than a full app-server wake worker because the goal was scheduler suppression policy, not turn execution.
- That tradeoff is acceptable because the app-server wake path had already been validated in earlier probes.

### Strategy Impact
- The strategy can now claim evidence-backed foreground takeover semantics:
  - background loop may run when explicitly enabled
  - switching back to foreground suppresses future scheduler wakes on the next tick
- This materially lowers the risk of background activity colliding with live foreground work in the Codex app.

## 2026-03-26 - Probe 22: bridge defers while foreground is active

### Goal
- Verify that a valid binding and inbox event are still not enough to dispatch when foreground mode is active.
- Verify that the bridge leaves the thread untouched and writes a dispatch/defer ticket instead.
- Verify that no operator side effect lands while foreground ownership is active.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_foreground_defer.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_foreground_defer.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_foreground_defer_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_foreground_defer_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_foreground_defer_probe](/Users/mymac/my%20dev/remodex/verification/bridge_foreground_defer_probe)

### Result
- Status: PASS
- The question turn completed normally.
- The operator answer inbox event was not dispatched.
- The bridge wrote a defer ticket into `dispatch_queue`.
- `thread/read` after the bridge decision still showed only the original question turn.
- No output file was created.

### Evidence
- Thread id: `019d2763-ec2a-7100-8aa9-fa0a1007e859`
- Question turn id: `019d2763-ed10-73f0-9c65-a3dee881dc70`
- Defer ticket:
  - [/Users/mymac/my dev/remodex/verification/bridge_foreground_defer_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T09-00-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/bridge_foreground_defer_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T09-00-00+09-00_operator_answer.json)
- Thread state after defer:
  - `turnCount = 1`
  - status `idle`
- Result files:
  - [/Users/mymac/my dev/remodex/verification/foreground_defer_option_a.txt](/Users/mymac/my%20dev/remodex/verification/foreground_defer_option_a.txt) absent
  - [/Users/mymac/my dev/remodex/verification/foreground_defer_option_b.txt](/Users/mymac/my%20dev/remodex/verification/foreground_defer_option_b.txt) absent

### Observed Behaviors
- Foreground mode is a real dispatch boundary, not just a scheduling hint.
- Even with a valid coordinator binding, the bridge can and should refrain from opening a new turn while foreground ownership is active.
- This is the correct behavior to avoid background/foreground competing instructions.

### Operational Notes
- The first attempt failed because the temporary `ws://127.0.0.1:4517` listener was no longer up.
- After restoring an explicit WebSocket listener, the probe passed unchanged.
- This means local verification tooling should not assume the listener is always present unless it is explicitly started.

### Strategy Impact
- The strategy can now require “foreground active => defer, not dispatch” as an evidence-backed invariant.
- This materially strengthens the safety rule that background and bridge systems must not compete with the live foreground operator.

## 2026-03-26 - Probe 23: multi-project recovery router replay

### Goal
- Verify that two separate projects can each persist unread inbox answers across recovery.
- Verify that recovery replay dispatches each inbox answer to the correct project thread only.
- Verify that cross-project wrong files are not created.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_multi_project_recovery_router.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_multi_project_recovery_router.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/multi_project_recovery_router_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/multi_project_recovery_router_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/multi_project_recovery_router_probe](/Users/mymac/my%20dev/remodex/verification/multi_project_recovery_router_probe)
- Event log: [/Users/mymac/my dev/remodex/verification/multi_project_recovery_router_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/multi_project_recovery_router_probe_events.jsonl)

### Result
- Status: PASS
- `project-alpha` unread answer was replayed onto the alpha thread only.
- `project-beta` unread answer was replayed onto the beta thread only.
- Both projects used `thread/read` and `thread/resume` before replay.
- Both expected files were created, and neither wrong file was created.

### Evidence
- Alpha:
  - thread id `019d2765-59af-7c92-8c13-914dcef5e086`
  - replay turn id `019d2765-a8fc-7fa3-b359-7bc06e3c2f79`
  - processed inbox file `2026-03-26T09-10-00+09-00_alpha_answer.json`
- Beta:
  - thread id `019d2765-80a7-7083-ba5b-03dba57754a1`
  - replay turn id `019d2766-0f9c-7cd3-bdd7-614fec53327f`
  - processed inbox file `2026-03-26T09-11-00+09-00_beta_answer.json`
- Result files:
  - [/Users/mymac/my dev/remodex/verification/multi_recovery_alpha.txt](/Users/mymac/my%20dev/remodex/verification/multi_recovery_alpha.txt) contents `alpha-recovery-ok`
  - [/Users/mymac/my dev/remodex/verification/multi_recovery_beta.txt](/Users/mymac/my%20dev/remodex/verification/multi_recovery_beta.txt) contents `beta-recovery-ok`
  - [/Users/mymac/my dev/remodex/verification/multi_recovery_alpha_wrong.txt](/Users/mymac/my%20dev/remodex/verification/multi_recovery_alpha_wrong.txt) absent
  - [/Users/mymac/my dev/remodex/verification/multi_recovery_beta_wrong.txt](/Users/mymac/my%20dev/remodex/verification/multi_recovery_beta_wrong.txt) absent

### Observed Behaviors
- Multi-project recovery routing can stay project-scoped through both read/resume and replay.
- Project identity is preserved strongly enough that the recovery router does not need to guess.
- This materially reduces fear that unread answers from one project could leak into another project’s coordinator thread during restart recovery.

### Operational Notes
- The probe used one recovery client process to replay both projects sequentially.
- That is sufficient to validate project-scoped routing because both project bindings and inbox artifacts remained distinct throughout replay.

### Strategy Impact
- The strategy can now treat multi-project unread-inbox recovery as evidence-backed, not only single-project recovery.
- This closes one of the highest remaining risk areas for a real multi-project operator console.

## 2026-03-26 - Probe 24: multi-project human-gate isolation

### Goal
- Verify that one project blocked on a real approval wait does not stop another project from replaying unread inbox work.
- Verify that the router skips the human-gated project and leaves its inbox unread.
- Verify that another eligible project can still resume and complete its follow-up turn.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_multi_project_human_gate_isolation.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_multi_project_human_gate_isolation.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/multi_project_human_gate_isolation_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/multi_project_human_gate_isolation_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/multi_project_human_gate_isolation_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/multi_project_human_gate_isolation_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/multi_project_human_gate_isolation_probe](/Users/mymac/my%20dev/remodex/verification/multi_project_human_gate_isolation_probe)

### Result
- Status: PASS
- `project-alpha` entered a real `waitingOnApproval` state and was skipped by the router.
- `project-alpha` unread inbox remained unread.
- `project-beta` resumed, replayed its unread operator answer, and completed a new turn successfully.
- `project-alpha` cleanup completed by canceling the pending approval, leaving no alpha side-effect files behind.

### Evidence
- Alpha:
  - thread id `019d2771-cd84-7222-abb2-339a3fdafb93`
  - pending turn id `019d2771-cf7a-7021-ba03-9b99b64de574`
  - approval method `item/fileChange/requestApproval`
  - router decision `skipped_pending_human_gate`
  - unread inbox file remained at:
    - [/Users/mymac/my dev/remodex/verification/multi_project_human_gate_isolation_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T09-20-00+09-00_alpha_followup.json](/Users/mymac/my%20dev/remodex/verification/multi_project_human_gate_isolation_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T09-20-00+09-00_alpha_followup.json)
  - cleanup ended the pending turn as `interrupted`
- Beta:
  - thread id `019d2772-02d7-71b3-9a64-41c4a7f0db72`
  - replay turn id `019d2772-25a2-7bc3-a64f-1c46e47b88ab`
  - router decision `dispatched`
  - processed inbox file:
    - [/Users/mymac/my dev/remodex/verification/multi_project_human_gate_isolation_probe/external-shared-memory/remodex/projects/project-beta/processed/2026-03-26T09-21-00+09-00_beta_followup.json](/Users/mymac/my%20dev/remodex/verification/multi_project_human_gate_isolation_probe/external-shared-memory/remodex/projects/project-beta/processed/2026-03-26T09-21-00+09-00_beta_followup.json)
- Final files:
  - [/Users/mymac/my dev/remodex/verification/human_gate_alpha_pending_target.txt](/Users/mymac/my%20dev/remodex/verification/human_gate_alpha_pending_target.txt) absent
  - [/Users/mymac/my dev/remodex/verification/human_gate_alpha_wrong_dispatch.txt](/Users/mymac/my%20dev/remodex/verification/human_gate_alpha_wrong_dispatch.txt) absent
  - [/Users/mymac/my dev/remodex/verification/human_gate_beta_result.txt](/Users/mymac/my%20dev/remodex/verification/human_gate_beta_result.txt) contents `beta-human-gate-ok`
  - [/Users/mymac/my dev/remodex/verification/human_gate_beta_wrong.txt](/Users/mymac/my%20dev/remodex/verification/human_gate_beta_wrong.txt) absent

### Observed Behaviors
- A real `waitingOnApproval` state can be isolated to one project without freezing replay for unrelated projects.
- The router can safely fail-closed for the blocked project while still making forward progress elsewhere.
- This confirms that human gate semantics can remain project-scoped in a multi-project operator model.

### Operational Notes
- The first implementation of the probe failed because `thread/status/changed(waitingOnApproval)` and the approval request can race.
- The fixed probe now registers both waiters concurrently before consuming either result.
- That concurrency requirement should be treated as a real client-side integration rule, not just a probe quirk.

### Strategy Impact
- The strategy can now claim evidence-backed multi-project isolation for human approval gates.
- This is a core safety property for any overnight or multi-project routing loop.

## 2026-03-26 - Probe 25: foreground coordinator drains deferred dispatch queue

### Goal
- Verify that an operator answer deferred during foreground mode can later be consumed by the foreground coordinator itself.
- Verify that the same bound thread can be resumed and advanced from the deferred ticket.
- Verify that the deferred answer leads to the intended side effect without creating the wrong file.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_foreground_dispatch_queue_drain.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_foreground_dispatch_queue_drain.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/foreground_dispatch_queue_drain_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/foreground_dispatch_queue_drain_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/foreground_dispatch_queue_drain_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/foreground_dispatch_queue_drain_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/foreground_dispatch_queue_drain_probe](/Users/mymac/my%20dev/remodex/verification/foreground_dispatch_queue_drain_probe)

### Result
- Status: PASS
- Foreground-active mode deferred the operator answer into `dispatch_queue`.
- The bound thread still had only the original question turn after defer.
- A foreground drain step then resumed the same thread and delivered the deferred operator answer.
- Only the intended output file was created.

### Evidence
- thread id `019d2774-898c-7843-afc8-6ebc5c217663`
- question turn id `019d2774-8b9b-7552-af7f-2c61f0d8ee16`
- drained turn id `019d2774-ac6f-74f1-bde8-1cca0c5d0b6d`
- defer ticket:
  - [/Users/mymac/my dev/remodex/verification/foreground_dispatch_queue_drain_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T09-30-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/foreground_dispatch_queue_drain_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T09-30-00+09-00_operator_answer.json)
- processed ticket after drain:
  - [/Users/mymac/my dev/remodex/verification/foreground_dispatch_queue_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-30-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/foreground_dispatch_queue_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-30-00+09-00_operator_answer.json)
- Final files:
  - [/Users/mymac/my dev/remodex/verification/foreground_drain_option_a.txt](/Users/mymac/my%20dev/remodex/verification/foreground_drain_option_a.txt) absent
  - [/Users/mymac/my dev/remodex/verification/foreground_drain_option_b.txt](/Users/mymac/my%20dev/remodex/verification/foreground_drain_option_b.txt) contents `foreground-drain-ok`

### Observed Behaviors
- A deferred operator answer does not have to be lost when background dispatch is suppressed by foreground mode.
- The foreground coordinator can safely consume that deferred answer by resuming the same thread and sending a new turn.
- This validates the practical “I return to the app and continue from what was queued” path.

### Operational Notes
- The first run failed only because local loopback WebSocket access was not escalated.
- The elevated run passed without script changes.
- One additional operational risk emerged:
  - the original inbox file remained present even after the queue ticket was drained and moved to `processed`
  - this leaves room for duplicate replay if a later recovery router consumes the original inbox again

### Strategy Impact
- The strategy can now treat foreground queue draining as evidence-backed.
- However, queue drain must be paired with source inbox consumption or dedupe metadata.
- Otherwise the system remains vulnerable to double-dispatch after restart or later recovery.

## 2026-03-26 - Probe 26: duplicate replay after foreground drain

### Goal
- Verify whether leaving the original inbox event in place after foreground drain creates a real duplicate-replay risk.
- Verify that a later recovery router can dispatch the same operator answer a second time from the lingering inbox.
- Verify that the duplicate is observable as both an extra turn and a duplicated file-side effect.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_duplicate_replay_after_foreground_drain.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_duplicate_replay_after_foreground_drain.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/duplicate_replay_after_foreground_drain_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_after_foreground_drain_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/duplicate_replay_after_foreground_drain_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_after_foreground_drain_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/duplicate_replay_after_foreground_drain_probe](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_after_foreground_drain_probe)

### Result
- Status: PASS
- Foreground defer occurred as expected.
- Foreground drain consumed the deferred queue ticket and completed the first follow-up turn.
- The original inbox event remained present.
- A later recovery replay consumed that inbox event again and opened a second follow-up turn.
- The target file ended up with the same evidence line written twice.

### Evidence
- thread id `019d277d-2a4b-7622-8b2f-b255328b2cda`
- question turn id `019d277d-2b27-7c92-8b09-835683936b16`
- first drain turn id `019d277d-51bc-7ac3-9c63-daa0054e7aef`
- replayed duplicate turn id `019d277d-da35-7e41-8aba-fa6113508bc2`
- lingering inbox file:
  - [/Users/mymac/my dev/remodex/verification/duplicate_replay_after_foreground_drain_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T09-40-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_after_foreground_drain_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T09-40-00+09-00_operator_answer.json)
- processed queue ticket:
  - [/Users/mymac/my dev/remodex/verification/duplicate_replay_after_foreground_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-40-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_after_foreground_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-40-00+09-00_operator_answer.json)
- Final target file:
  - [/Users/mymac/my dev/remodex/verification/duplicate_replay_target.txt](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_target.txt)
  - line 1 `duplicate-replay-evidence`
  - line 2 `duplicate-replay-evidence`
- Wrong file:
  - [/Users/mymac/my dev/remodex/verification/duplicate_replay_wrong.txt](/Users/mymac/my%20dev/remodex/verification/duplicate_replay_wrong.txt) absent

### Observed Behaviors
- The duplicate-replay risk is not theoretical. It is reproducible with the current file semantics.
- A foreground drain that only moves the queue ticket to `processed` is insufficient.
- If the original inbox stays unread, a later recovery router can reissue the same operator answer on the same thread.

### Operational Notes
- The probe intentionally asked Codex to append the same evidence line every time the same operator answer was processed.
- That made duplicate replay visible as a two-line file rather than a hidden duplicate turn count only.

### Strategy Impact
- The strategy must treat “defer copies inbox to queue” as unsafe unless it also records source consumption or dedupe state.
- A simple restart or later recovery pass can otherwise double-apply operator instructions.

## 2026-03-26 - Probe 27: processed correlation-key dedupe mitigation

### Goal
- Verify that a minimal dedupe rule can prevent the duplicate replay observed in Probe 26.
- Verify that checking `correlation_key` against already processed queue tickets is enough to skip the stale inbox event.
- Verify that the target file remains single-written under that mitigation.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_processed_correlation_dedupe.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_processed_correlation_dedupe.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/processed_correlation_dedupe_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/processed_correlation_dedupe_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/processed_correlation_dedupe_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/processed_correlation_dedupe_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/processed_correlation_dedupe_probe](/Users/mymac/my%20dev/remodex/verification/processed_correlation_dedupe_probe)

### Result
- Status: PASS
- Foreground defer and first drain both completed successfully.
- The original inbox file still remained in place.
- The safe replay step checked `processed` for the same `correlation_key` and skipped the inbox event.
- The target file remained single-written.

### Evidence
- thread id `019d2780-7bfc-7a20-8da1-b9da3492d9dd`
- question turn id `019d2780-7dd3-7d30-a8ab-9718c144052f`
- first drain turn id `019d2780-ab5c-7f01-a9ed-eb899ab0aea3`
- bridge correlation key `processed-correlation-dedupe-001`
- safe replay decision `skipped_duplicate_correlation`
- processed file used for dedupe:
  - [/Users/mymac/my dev/remodex/verification/processed_correlation_dedupe_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-50-00+09-00_operator_answer.json](/Users/mymac/my%20dev/remodex/verification/processed_correlation_dedupe_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T09-50-00+09-00_operator_answer.json)
- Final target file:
  - [/Users/mymac/my dev/remodex/verification/processed_dedupe_target.txt](/Users/mymac/my%20dev/remodex/verification/processed_dedupe_target.txt)
  - one line only: `processed-correlation-evidence`
- Wrong file:
  - [/Users/mymac/my dev/remodex/verification/processed_dedupe_wrong.txt](/Users/mymac/my%20dev/remodex/verification/processed_dedupe_wrong.txt) absent

### Observed Behaviors
- A very small dedupe rule already blocks the failure class from Probe 26.
- The mitigation does not require interpreting model output or guessing intent.
- It only needs structured carry-through of `correlation_key` into the processed artifact.

### Operational Notes
- The inbox file still physically remained present in this mitigation probe too.
- That means the skip depended entirely on structured dedupe, not on inbox deletion.
- This is useful because it proves the contract-level mitigation independently of any future file cleanup policy.

### Strategy Impact
- The strategy now has evidence for both the failure and the mitigation:
  - failure: replay occurs if inbox lingers and no dedupe exists
  - mitigation: replay is blocked if processed correlation keys are consulted
- This should be promoted from an operational suggestion to a required contract invariant.

## 2026-03-26 - Probe 28: multi-project processed correlation dedupe isolation

### Goal
- Verify that `processed.correlation_key` dedupe works when multiple projects carry the same `correlation_key`.
- Verify that dedupe scope is project-local, not global.
- Verify that one project can skip replay while another project with the same key still dispatches normally.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_multi_project_processed_correlation_dedupe.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_multi_project_processed_correlation_dedupe.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/multi_project_processed_correlation_dedupe_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_correlation_dedupe_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/multi_project_processed_correlation_dedupe_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_correlation_dedupe_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/multi_project_processed_correlation_dedupe_probe](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_correlation_dedupe_probe)

### Result
- Status: PASS
- `project-alpha` had a processed receipt with the shared `correlation_key`, so replay was skipped.
- `project-beta` used the same `correlation_key` but had no processed receipt in its own namespace, so replay dispatched normally.
- No cross-project contamination occurred.

### Evidence
- shared correlation key `cross-project-correlation-001`
- alpha thread id `019d278a-7487-7260-8122-475dd27d06f8`
- beta thread id `019d278a-b21b-7a51-a88e-82eaa391c47f`
- beta dispatched turn id `019d278a-c8bb-7dd0-9734-08d917c57624`
- alpha decision `skipped_duplicate_correlation`
- beta decision `dispatched`
- Final files:
  - [/Users/mymac/my dev/remodex/verification/multi_project_processed_dedupe_alpha.txt](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_dedupe_alpha.txt) absent
  - [/Users/mymac/my dev/remodex/verification/multi_project_processed_dedupe_beta.txt](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_dedupe_beta.txt) contents `beta-dedupe-ok`
  - [/Users/mymac/my dev/remodex/verification/multi_project_processed_dedupe_alpha_wrong.txt](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_dedupe_alpha_wrong.txt) absent
  - [/Users/mymac/my dev/remodex/verification/multi_project_processed_dedupe_beta_wrong.txt](/Users/mymac/my%20dev/remodex/verification/multi_project_processed_dedupe_beta_wrong.txt) absent

### Observed Behaviors
- `correlation_key` alone is not a safe global dedupe key.
- The same key can appear in multiple projects without conflict if dedupe scope remains project-local.
- This matches the project namespace model already used by bindings, inboxes, state, and recovery routing.

### Operational Notes
- The probe intentionally reused one correlation key across both projects to stress the dedupe scope.
- The pass condition depended on `project-alpha` and `project-beta` making different decisions with the same key.

### Strategy Impact
- The strategy should require processed-correlation dedupe to remain project-local.
- Any future router that widens the dedupe scope beyond project namespace would be a regression.

## 2026-03-26 - Probe 29: contract-driven correlation router

### Goal
- Verify that the router can derive the replay-dedupe rule directly from the contract docs instead of hardcoding it in probe logic.
- Verify that the machine-checkable guard lines in [/Users/mymac/my dev/remodex/STRATEGY.md](/Users/mymac/my%20dev/remodex/STRATEGY.md) and [/Users/mymac/my dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md](/Users/mymac/my%20dev/remodex/MAIN_COORDINATOR_PROMPT_CONTRACT.md) are sufficient to drive the same project-local dedupe behavior as Probe 28.
- Verify that the alpha replay is skipped, beta replay dispatches, and the final files remain isolated.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_contract_driven_correlation_router.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_contract_driven_correlation_router.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/contract_driven_correlation_router_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/contract_driven_correlation_router_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/contract_driven_correlation_router_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/contract_driven_correlation_router_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/contract_driven_correlation_router_probe](/Users/mymac/my%20dev/remodex/verification/contract_driven_correlation_router_probe)

### Result
- Status: PASS
- The router parsed the machine-checkable guard lines from the contract docs and applied them successfully.
- `project-alpha` skipped replay because its own processed receipt carried the same `correlation_key`.
- `project-beta` dispatched normally because no processed receipt existed in its namespace.

### Evidence
- strategy guard:
  - `processed_receipt_required: true`
  - `processed_dedupe_scope: project_local`
  - `processed_dedupe_key: correlation_key`
  - `recovery_replay_skip_if_processed: true`
- prompt guard:
  - `replay_guard_source: processed_correlation_index_or_processed_receipt`
  - `replay_guard_scope: project_local`
  - `replay_guard_key: correlation_key`
  - `replay_guard_required_before_unread_replay: true`
- alpha thread id `019d2792-238f-76e2-aa78-1316e8e11a82`
- beta thread id `019d2792-4539-7773-8c05-66a3c096db54`
- beta dispatched turn id `019d2792-6347-7e43-8ebf-447145379d37`
- Final files:
  - [/Users/mymac/my dev/remodex/verification/contract_driven_alpha.txt](/Users/mymac/my%20dev/remodex/verification/contract_driven_alpha.txt) absent
  - [/Users/mymac/my dev/remodex/verification/contract_driven_beta.txt](/Users/mymac/my%20dev/remodex/verification/contract_driven_beta.txt) contents `beta-contract-ok`
  - [/Users/mymac/my dev/remodex/verification/contract_driven_alpha_wrong.txt](/Users/mymac/my%20dev/remodex/verification/contract_driven_alpha_wrong.txt) absent
  - [/Users/mymac/my dev/remodex/verification/contract_driven_beta_wrong.txt](/Users/mymac/my%20dev/remodex/verification/contract_driven_beta_wrong.txt) absent

### Observed Behaviors
- The strategy doc and prompt contract now contain enough structured guard lines to drive router behavior directly.
- This reduces the chance of code and documentation drifting apart on replay semantics.
- The pass also confirms that processed-correlation dedupe can be enforced without guessing from model output or special-casing one project.

### Operational Notes
- The first run exposed a parser defect: markdown backticks around guard lines were being captured as literal value suffixes.
- The probe script was corrected to normalize parsed values before applying the rules.
- After that correction, the same contract-driven router passed without any change to the contract docs themselves.

### Strategy Impact
- The processed-correlation replay guard is now backed by both contract text and a contract-driven live probe.
- This should be treated as a required invariant, not a suggestion.
- Any future router implementation should be considered incomplete if it does not read or mirror this exact replay guard contract.

## 2026-03-26 - Probe 30: Discord transport end-to-end ingress

### Goal
- Verify the full Discord-style ingress path end-to-end rather than checking signature verification and normalization in isolation.
- Verify that a real HTTP transport payload goes through signature verification, replay protection, ACL/project routing, and shared-memory persistence.
- Verify that valid operator intent reaches project inbox, unauthorized approval is quarantined, missing project is quarantined, tampered signature is rejected, and replay is blocked.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_transport_end_to_end.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_transport_end_to_end.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_transport_end_to_end_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe](/Users/mymac/my%20dev/remodex/verification/discord_transport_end_to_end_probe)
- Ingress log: [/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe/router/ingress_log.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_transport_end_to_end_probe/router/ingress_log.jsonl)

### Result
- Status: PASS
- Valid signed `/intent` reached `project-alpha` inbox.
- Replayed transport request was rejected with HTTP `409`.
- Unauthorized `/approve` was accepted only into quarantine, not inbox.
- Missing-project `/intent` was accepted only into quarantine, not inbox.
- Tampered request body with stale signature pair was rejected with HTTP `401`.

### Evidence
- valid intent response:
  - HTTP `202`
  - inbox file `/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T10-30-00+09-00_intent_discord-http-001.json`
- replay response:
  - HTTP `409`
  - reason `replay_detected`
- unauthorized approval quarantine file:
  - [/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe/router/quarantine/2026-03-26T10-31-00+09-00_approve_discord-http-002.json](/Users/mymac/my%20dev/remodex/verification/discord_transport_end_to_end_probe/router/quarantine/2026-03-26T10-31-00+09-00_approve_discord-http-002.json)
- missing project quarantine file:
  - [/Users/mymac/my dev/remodex/verification/discord_transport_end_to_end_probe/router/quarantine/2026-03-26T10-32-00+09-00_intent_discord-http-003.json](/Users/mymac/my%20dev/remodex/verification/discord_transport_end_to_end_probe/router/quarantine/2026-03-26T10-32-00+09-00_intent_discord-http-003.json)
- tampered signature response:
  - HTTP `401`
  - reason `invalid_signature`

### Observed Behaviors
- The transport path can be treated as a real ingress boundary, not just a conceptual one.
- Signature verification, replay blocking, ACL, and project routing can all execute before shared-memory persistence.
- Discord message truth should still remain outside the system. Only normalized inbox or quarantine records become internal truth.

### Operational Notes
- The local HTTP listener needed elevated permissions in this environment because sandboxed loopback listen returned `EPERM`.
- Once elevated, the probe passed without any behavioral change to the script logic.

### Strategy Impact
- The strategy can now promote Discord ingress from “plausible integration” to “live-verified ingress boundary”.
- Signature verification and replay protection should be treated as required ingress gates, not optional hardening.

## 2026-03-26 - Probe 31: processed receipt and processed_correlation_index consistency

### Goal
- Verify that `processed/*` receipts and `state/processed_correlation_index.md` remain consistent across all key handling paths.
- Verify the exact paths:
  - `foreground_drain`
  - `direct_delivery`
  - `recovery_replay`
  - `recovery_replay + skipped_duplicate`
- Verify that the index mirrors the same `correlation_key`, `source_ref`, `origin`, `disposition`, and receipt reference as the processed receipt.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_processed_receipt_index_consistency.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_processed_receipt_index_consistency.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe)

### Result
- Status: PASS
- `project-alpha` foreground drain wrote a `consumed` receipt and matching index entry.
- `project-beta` direct delivery wrote a `consumed` receipt and matching index entry.
- `project-gamma` recovery replay wrote a `consumed` receipt and matching index entry.
- `project-delta` duplicate-skip wrote a `skipped_duplicate` receipt and matching index entry without opening a new turn.

### Evidence
- alpha foreground target:
  - [/Users/mymac/my dev/remodex/verification/index_consistency_alpha.txt](/Users/mymac/my%20dev/remodex/verification/index_consistency_alpha.txt) contents `alpha-foreground-ok`
- beta direct-delivery target:
  - [/Users/mymac/my dev/remodex/verification/index_consistency_beta.txt](/Users/mymac/my%20dev/remodex/verification/index_consistency_beta.txt) contents `beta-direct-ok`
- gamma recovery target:
  - [/Users/mymac/my dev/remodex/verification/index_consistency_gamma.txt](/Users/mymac/my%20dev/remodex/verification/index_consistency_gamma.txt) contents `gamma-recovery-ok`
- delta duplicate-skip target:
  - [/Users/mymac/my dev/remodex/verification/index_consistency_delta.txt](/Users/mymac/my%20dev/remodex/verification/index_consistency_delta.txt) absent
- index files:
  - [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-alpha/state/processed_correlation_index.md](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-alpha/state/processed_correlation_index.md)
  - [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-beta/state/processed_correlation_index.md](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-beta/state/processed_correlation_index.md)
  - [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-gamma/state/processed_correlation_index.md](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-gamma/state/processed_correlation_index.md)
  - [/Users/mymac/my dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-delta/state/processed_correlation_index.md](/Users/mymac/my%20dev/remodex/verification/processed_receipt_index_consistency_probe/external-shared-memory/remodex/projects/project-delta/state/processed_correlation_index.md)

### Observed Behaviors
- `processed/*` and `processed_correlation_index.md` can be kept in lockstep across all main handling origins.
- Duplicate-skip can be recorded as a first-class processed outcome without opening a new turn.
- The replay guard becomes much stronger when both receipt truth and index truth are updated in the same handling step.

### Operational Notes
- The probe encoded the index as markdown with a JSON fenced block so the file stayed `.md` while remaining machine-checkable.
- This is probe-local encoding, but it demonstrates that a machine-readable `.md` state file is practical.
- The duplicate-skip path relied on both prior receipt truth and prior index truth, then appended a new `skipped_duplicate` receipt and index entry without changing turn count.

### Strategy Impact
- The strategy should treat `processed/*` and `state/processed_correlation_index.md` as a coupled write obligation.
- Any implementation that updates one without the other should be treated as incomplete.
- Duplicate-skip should not be a silent branch. It needs the same evidence discipline as consumed delivery.

## 2026-03-26 - Probe 32: Discord operator roundtrip

### Goal
- Verify the full operator roundtrip from signed Discord transport to same-thread Codex follow-up execution.
- Verify the path:
  - signed Discord ingress
  - inbox persistence
  - bridge dispatch on the bound thread
  - actual workspace file side effect
- Verify that the same thread that asked the clarifying question consumes the operator reply and completes the requested write.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_operator_roundtrip.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_operator_roundtrip.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_operator_roundtrip_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_operator_roundtrip_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_operator_roundtrip_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_operator_roundtrip_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_operator_roundtrip_probe](/Users/mymac/my%20dev/remodex/verification/discord_operator_roundtrip_probe)

### Result
- Status: PASS
- Signed Discord operator intent reached inbox successfully.
- Bridge dispatched the normalized operator answer onto the same thread that asked the clarifying question.
- The target file was created exactly once and the wrong file stayed absent.

### Evidence
- thread id `019d28bd-fd0a-75b1-8b12-16b70769d88b`
- question turn id `019d28be-0283-7700-9343-d6e4604b088e`
- bridge follow-up turn id `019d28be-4f07-70d3-bc59-d0e81df58127`
- transport response:
  - HTTP `202`
  - inbox file `/Users/mymac/my dev/remodex/verification/discord_operator_roundtrip_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T11-00-00+09-00_intent_discord-roundtrip-001.json`
- Final files:
  - [/Users/mymac/my dev/remodex/verification/discord_roundtrip_target.txt](/Users/mymac/my%20dev/remodex/verification/discord_roundtrip_target.txt) contents `discord-roundtrip-ok`
  - [/Users/mymac/my dev/remodex/verification/discord_roundtrip_wrong.txt](/Users/mymac/my%20dev/remodex/verification/discord_roundtrip_wrong.txt) absent

### Observed Behaviors
- The “mobile operator reply -> same main thread follow-up” path is not just theoretical. It is live-verified.
- The operator reply does not need a special hidden lane. A signed ingress plus normalized inbox record is sufficient.
- The bound thread identity remained stable across the question turn and the follow-up execution turn.

### Operational Notes
- This probe used both loopback HTTP binding and live app-server WebSocket access, so it required elevated execution in this environment.
- The processed receipt written by the bridge marked the event as `consumed` with origin `direct_delivery`.

### Strategy Impact
- The strategy can now treat Discord operator replies as a real roundtrip path into the project main thread.
- Prompt contract, shared memory, and bridge routing are sufficient to resume the same thread after an external reply.

## 2026-03-26 - Probe 33: Discord ingress + foreground takeover + dedupe race

### Goal
- Verify that a signed Discord operator request does not double-dispatch when it collides with foreground takeover and later recovery replay.
- Verify the combined path:
  - signed ingress creates inbox
  - foreground returns
  - bridge defers to `dispatch_queue`
  - foreground drain dispatches once
  - later recovery sees the lingering correlation and skips duplicate replay
- Verify that the target file is written exactly once and turn count does not increase during the duplicate-skip pass.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_foreground_race_dedupe.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_foreground_race_dedupe.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_foreground_race_dedupe_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_foreground_race_dedupe_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_foreground_race_dedupe_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_foreground_race_dedupe_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_foreground_race_dedupe_probe](/Users/mymac/my%20dev/remodex/verification/discord_foreground_race_dedupe_probe)

### Result
- Status: PASS
- Signed ingress wrote the operator event to inbox.
- Foreground takeover forced bridge defer instead of immediate dispatch.
- Foreground drain dispatched exactly once.
- Recovery replay saw the same correlation in processed truth and skipped duplicate dispatch.
- Thread turn count stayed flat across the duplicate-skip pass.

### Evidence
- thread id `019d28c6-4659-7010-a2f3-3ac124b9d84b`
- question turn id `019d28c6-472e-7390-b105-854937fb8303`
- foreground drain turn id `019d28c6-709c-7d03-9d13-64c1cce9f857`
- defer reasons:
  - `background_trigger_disabled`
  - `foreground_session_active`
  - `status_busy_non_interruptible`
- recovery replay:
  - decision `skipped_duplicate`
  - `beforeTurnCount = 2`
  - `afterTurnCount = 2`
- Final files:
  - [/Users/mymac/my dev/remodex/verification/discord_race_target.txt](/Users/mymac/my%20dev/remodex/verification/discord_race_target.txt) contents `discord-race-ok`
  - [/Users/mymac/my dev/remodex/verification/discord_race_wrong.txt](/Users/mymac/my%20dev/remodex/verification/discord_race_wrong.txt) absent

### Observed Behaviors
- The combined safety model holds under a realistic operator race window:
  - ingress can happen before foreground return
  - foreground can still claim execution authority
  - dedupe can still block the later replay path
- This closes the most practical double-dispatch risk around “I came back to the app just as a mobile reply arrived”.

### Operational Notes
- The lingering inbox event was intentionally left in place after foreground drain so the recovery pass had a real stale source to inspect.
- The duplicate was prevented by processed receipt plus processed-correlation index, not by deleting the inbox early.
- The consumed receipt used the inbox filename as `source_ref`, while the duplicate-skip receipt used the event source ref from the normalized Discord payload. The shared dedupe key remained the correlation key, so replay safety still held.

### Strategy Impact
- Foreground takeover, signed ingress, queue defer, and replay dedupe now have a single live-verified safety story.
- The strategy can treat “dispatch once, then skip by correlation” as evidence-backed behavior across the full operator path.
- Any future implementation that lets the recovery pass increment turn count in this situation should be treated as regression.

## 2026-03-26 - Probe 34: Discord approval pending gate split

### Goal
- Verify how Discord ingress behaves while a live Codex thread is actually `waiting_on_approval`.
- Verify the split:
  - unauthorized approval request -> quarantine
  - allowlisted approval request tied to the active approval source -> human-gate candidate
  - unrelated intent while approval is pending -> dispatch queue
- Verify that none of these external inputs bypass the human gate and directly mutate the workspace.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_approval_human_gate.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_approval_human_gate.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe)

### Result
- Status: PASS
- The live approval request was `item/fileChange/requestApproval`.
- Viewer `/approve` was quarantined.
- Ops-admin `/approve` with matching `source_ref` was promoted to a human-gate candidate.
- Unrelated ops-admin `/intent` while approval was still pending went to dispatch queue rather than inbox or direct execution.
- The original file change remained unapplied because the live approval was canceled.

### Evidence
- thread id `019d2945-6a01-7893-9a9d-fc287f5a5055`
- approval request:
  - method `item/fileChange/requestApproval`
  - source ref `item/fileChange/requestApproval:2`
- quarantine file:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe/router/quarantine/2026-03-26T12-00-00+09-00_approve_discord-approve-001.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe/router/quarantine/2026-03-26T12-00-00+09-00_approve_discord-approve-001.json)
- human gate candidate:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T12-00-01+09-00_approve_discord-approve-002.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T12-00-01+09-00_approve_discord-approve-002.json)
- deferred unrelated intent:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T12-00-02+09-00_intent_discord-intent-003.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_probe/external-shared-memory/remodex/projects/project-alpha/dispatch_queue/2026-03-26T12-00-02+09-00_intent_discord-intent-003.json)
- blocked file change target:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_should_not_exist.txt](/Users/mymac/my%20dev/remodex/verification/discord_approval_should_not_exist.txt) absent

### Observed Behaviors
- The approval boundary is not just ACL. It also depends on matching the active approval source while the thread is in approval wait.
- Approval-class Discord ingress can be separated cleanly from ordinary intent ingress under the same live thread state.
- Unrelated intent during approval wait is preserved, but it does not interrupt or override the current human gate.

### Operational Notes
- The live turn was finished by responding `cancel` to the approval request, which left the turn in `interrupted` state and prevented the file write.
- This probe introduced a dedicated `human_gate_candidates` storage path in the verification harness to make the promotion boundary explicit.

### Strategy Impact
- The strategy now has live evidence for the phrase “approval-class Discord ingress becomes a human approval candidate only after signature, identity, ACL, project resolution, and active approval-source match”.
- Any implementation that lets unrelated intent bypass this gate while `waiting_on_approval` should be treated as regression.

## 2026-03-26 - Probe 35: launchd tick after Discord ingress

### Goal
- Verify that a real launchd tick still respects Discord ingress, foreground priority, and duplicate-skip semantics.
- Verify the phase order:
  - signed Discord ingress writes inbox
  - launchd tick while foreground-active stays blocked
  - launchd tick after background enable causes exactly one wake-side effect
  - later tick skips duplicate instead of dispatching a second turn
- Verify that turn count stays flat during the duplicate-skip phase.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_launchd_discord_race_dedupe.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_discord_race_dedupe.mjs)
- Worker script: [/Users/mymac/my dev/remodex/scripts/launchd_discord_race_worker.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_discord_race_worker.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_discord_race_dedupe_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_discord_race_dedupe_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/launchd_discord_race_probe](/Users/mymac/my%20dev/remodex/verification/launchd_discord_race_probe)

### Result
- Status: PASS
- Signed Discord ingress reached inbox before scheduler evaluation.
- Launchd tick in foreground-active state recorded `blocked`.
- After background enable, launchd caused one wake-side effect and the target file was created exactly once.
- The next launchd tick saw recorded processed truth and returned `skipped_duplicate`.
- Turn count stayed `2 -> 2` across the duplicate-skip phase.

### Evidence
- thread id `019d294d-58e0-7593-b10b-e8de2d8ec5b1`
- blocked reasons:
  - `background_trigger_disabled`
  - `foreground_session_active`
  - `status_busy_non_interruptible`
- duplicate-skip phase:
  - decision `skipped_duplicate`
  - `beforeSkipTurnCount = 2`
  - `afterSkipTurnCount = 2`
- final target:
  - [/Users/mymac/my dev/remodex/verification/launchd_discord_race_target.txt](/Users/mymac/my%20dev/remodex/verification/launchd_discord_race_target.txt) contents `launchd-discord-race-ok`
- wrong target:
  - [/Users/mymac/my dev/remodex/verification/launchd_discord_race_wrong.txt](/Users/mymac/my%20dev/remodex/verification/launchd_discord_race_wrong.txt) absent

### Observed Behaviors
- Scheduler tick priority stayed aligned with the manual bridge/race probes:
  - foreground active first blocks
  - later background tick can wake
  - later duplicate tick can skip
- The duplicate-skip check remained correlation-driven, not heuristic.
- Scheduler behavior and operator ingress can now be reasoned about in the same model.

### Operational Notes
- In this environment, the launchd worker reliably produced the wake-side effect, but its own completion receipt was not always available before phase rollover.
- The verification harness therefore promoted the consumed delivery into processed truth after wake confirmation, then used the next real launchd tick to verify `skipped_duplicate`.
- This still validates scheduler priority ordering, while isolating a separate worker-completion persistence timing issue for future investigation.

### Strategy Impact
- The strategy now has evidence that real scheduler ticks preserve the same priority ordering as the manual bridge path.
- Launchd is no longer just “can wake something”; it can participate in the same blocked/wake/skip safety story around Discord ingress.
- A separate follow-up item remains: worker-side completion receipt persistence under launchd should be hardened so the probe no longer needs observer-assisted processed truth after wake.

## 2026-03-26 - Probe 36: launchd worker completion persistence recovery

### Goal
- Verify that a launchd-started worker can leave an inflight claim before the process is interrupted.
- Verify that the underlying background turn can still complete after the worker is booted out.
- Verify that a restarted worker can recover from the inflight claim and persist `processed receipt` plus `processed_correlation_index` without opening a duplicate turn.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_launchd_worker_persistence_recovery.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_worker_persistence_recovery.mjs)
- Worker script: [/Users/mymac/my dev/remodex/scripts/launchd_discord_race_worker.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_discord_race_worker.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_worker_persistence_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_worker_persistence_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/launchd_worker_persistence_probe](/Users/mymac/my%20dev/remodex/verification/launchd_worker_persistence_probe)

### Result
- Status: PASS
- The launchd worker wrote an inflight claim before interruption.
- After bootout, the background turn still completed and wrote the target file.
- After a fresh bootstrap, the worker read the inflight claim, confirmed the turn was already `completed`, and persisted processed truth without opening another turn.
- Turn count stayed flat across the recovery phase.

### Evidence
- thread id `019d295e-6150-7a41-85ba-d7204df6f245`
- inflight claim turn id `019d295e-808b-7bf2-ae5a-345a98725384`
- recovery decision `completed_inflight`
- turn count `beforeRecoveryTurnCount = 2`, `afterRecoveryTurnCount = 2`
- processed receipt:
  - [/Users/mymac/my dev/remodex/verification/launchd_worker_persistence_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T08-59-35.665Z_guild-1:alpha-ops:discord-persistence-001_consumed.json](/Users/mymac/my%20dev/remodex/verification/launchd_worker_persistence_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T08-59-35.665Z_guild-1:alpha-ops:discord-persistence-001_consumed.json)
- final target:
  - [/Users/mymac/my dev/remodex/verification/launchd_worker_persistence_target.txt](/Users/mymac/my%20dev/remodex/verification/launchd_worker_persistence_target.txt) contents `launchd-persistence-ok`
- wrong target:
  - [/Users/mymac/my dev/remodex/verification/launchd_worker_persistence_wrong.txt](/Users/mymac/my%20dev/remodex/verification/launchd_worker_persistence_wrong.txt) absent

### Observed Behaviors
- The worker must claim delivery state before waiting on `turn/completed`; otherwise recovery has nothing authoritative to inspect.
- Recovery can be idempotent if it reads the inflight claim, verifies the turn is already complete, and only then writes processed truth.
- Worker-scoped runtime paths cannot be hardcoded to one probe root; the runtime directory must be injectable.

### Operational Notes
- The first attempt failed because the worker was still pinned to `verification/launchd_discord_race_probe`.
- The worker was generalized to accept `REMODEX_LAUNCHD_PROBE_DIR`, and the persistence LaunchAgent now injects the probe root explicitly.
- This is an implementation constraint that should be reflected in the strategy and runtime contract docs.

### Strategy Impact
- The strategy now has evidence that launchd wake completion can survive worker interruption if inflight delivery state is persisted early.
- `processed receipt/index` persistence is no longer limited to the happy-path worker exit; it can be recovered after restart without duplicate dispatch.
- Any final design should treat inflight claim persistence as a first-class invariant for background delivery workers.

## 2026-03-26 - Probe 37: Discord human gate closure to live app-server approval

### Goal
- Verify that a signed Discord `/approve` can be promoted into a `human_gate_candidate` for the active live approval source.
- Verify that the foreground main can read that candidate and use it to answer the live app-server approval request.
- Verify that the turn can survive multiple follow-up approval requests and still complete successfully.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_approval_human_gate_closure.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_approval_human_gate_closure.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_closure_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_closure_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_closure_probe](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_closure_probe)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_closure_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_closure_probe_events.jsonl)

### Result
- Status: PASS
- Signed Discord `/approve` was routed to `human_gate_candidate`.
- The candidate matched the active approval source and was read back from shared memory.
- The foreground probe responded `accept` to the live app-server approval request.
- The turn then handled a chain of follow-up approval requests and still finished `completed`.
- The approved file was created and the wrong file was never created.

### Evidence
- thread id `019d296d-0e95-7213-90b3-ab9c433a302e`
- first live approval source ref `item/commandExecution/requestApproval:8`
- human gate candidate:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_human_gate_closure_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T13-10-00+09-00_approve_discord-approve-closure-001.json](/Users/mymac/my%20dev/remodex/verification/discord_approval_human_gate_closure_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T13-10-00+09-00_approve_discord-approve-closure-001.json)
- follow-up approvals accepted after the initial human gate:
  - request ids `9` through `16`
- completed turn id `019d296d-0f8b-77a0-8732-042460236e42`
- final approved file:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_closure_accepted.txt](/Users/mymac/my%20dev/remodex/verification/discord_approval_closure_accepted.txt) contents `discord-approval-closure-ok`
- wrong file:
  - [/Users/mymac/my dev/remodex/verification/discord_approval_closure_wrong.txt](/Users/mymac/my%20dev/remodex/verification/discord_approval_closure_wrong.txt) absent

### Observed Behaviors
- The first approval boundary may be `item/commandExecution/requestApproval`, not `item/fileChange/requestApproval`; the human gate must not assume only one approval family.
- Once the operator is authorized and the candidate matches the active approval source, the foreground main can continue answering later follow-up approvals inside the same turn.
- A long approval chain is possible even in a “single file only” task because the model may perform repeated verification commands before turn completion.

### Operational Notes
- The first implementation failed because it only buffered one approval and then waited for another request instead of prioritizing `turn/completed`.
- The probe was hardened to:
  - queue unmatched approval requests
  - keep waiting for `turn/completed`
  - accept additional approvals only when they actually appear
- The candidate file is intentionally left in `human_gate_candidates` as an audit trail, not as a consumed inbox item.

### Strategy Impact
- The strategy now has end-to-end evidence for the phrase “Discord approval candidate can close the live app-server approval path”.
- Approval logic must be source-ref driven and approval-family agnostic.
- Any runtime that assumes a single approval request per turn, or that discards later follow-up approvals after the first accept, should be treated as incomplete.

## 2026-03-26 - Probe 38: human gate candidate processed receipt + recovery dedupe

### Goal
- Verify that a consumed `human_gate_candidate` can write its own `processed receipt` and `processed_correlation_index` entry.
- Verify that the candidate file can remain in place as an audit trail.
- Verify that recovery logic can later see the same candidate and skip duplicate processing without touching the thread again.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_human_gate_processed_recovery.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_human_gate_processed_recovery.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_probe_summary.json)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_probe](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_probe)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_probe_events.jsonl)

### Result
- Status: PASS
- Signed Discord `/approve` became a `human_gate_candidate`.
- The live turn completed after foreground approval handling.
- Foreground then wrote a processed receipt for the candidate itself.
- Recovery read the still-present candidate file and returned `skipped_duplicate_human_gate`.
- Thread turn count stayed `1 -> 1`, so recovery did not reopen work.

### Evidence
- thread id `019d2996-a992-70f3-b1d2-05b515c399f2`
- first approval source ref `item/commandExecution/requestApproval:18`
- human gate candidate:
  - [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T13-20-00+09-00_approve_discord-hg-processed-001.json](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/human_gate_candidates/2026-03-26T13-20-00+09-00_approve_discord-hg-processed-001.json)
- processed receipt:
  - [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T10-01-39.580Z_guild-1:alpha-ops:discord-hg-processed-001_consumed_human_gate.json](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T10-01-39.580Z_guild-1:alpha-ops:discord-hg-processed-001_consumed_human_gate.json)
- recovery decision:
  - `skipped_duplicate_human_gate`
  - `duplicateInIndex = true`
  - `duplicateInReceipt = true`
  - `beforeTurnCount = 1`
  - `afterTurnCount = 1`
- final approved file:
  - [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_accepted.txt](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_accepted.txt) contents `human-gate-processed-ok`
- wrong file:
  - [/Users/mymac/my dev/remodex/verification/discord_human_gate_processed_recovery_wrong.txt](/Users/mymac/my%20dev/remodex/verification/discord_human_gate_processed_recovery_wrong.txt) absent

### Observed Behaviors
- `human_gate_candidates` can stay append-only for audit as long as processed truth is written separately.
- Recovery should dedupe on `correlation_key`, not on file deletion.
- Human gate candidate consumption needs the same processed-truth discipline that inbox and dispatch paths already use.

### Operational Notes
- The first approval in this run was again `item/commandExecution/requestApproval`, not file change.
- Follow-up approvals still appeared after the initial accept, so the foreground approval loop remained necessary even in the processed-recovery variant.

### Strategy Impact
- The strategy should explicitly require `processed receipt/index` writes for human gate candidate consumption.
- “Delete the candidate file after use” is not required for correctness if processed truth exists.
- Recovery routers can stay fail-closed and still avoid duplicates by checking processed truth before touching app-server.

## 2026-03-26 - Probe 39: multi-project foreground approval takeover

### Goal
- Verify that a project blocked on `waitingOnApproval` can be skipped by background routing while another project continues normally.
- Verify that the foreground can later take over only the blocked approval lane.
- Verify that unrelated inbox work in the blocked project remains unread while the approval lane is being resolved.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_multi_project_foreground_approval_takeover.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_multi_project_foreground_approval_takeover.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/multi_project_foreground_approval_takeover_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/multi_project_foreground_approval_takeover_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/multi_project_foreground_approval_takeover_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/multi_project_foreground_approval_takeover_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/multi_project_foreground_approval_takeover_probe](/Users/mymac/my%20dev/remodex/verification/multi_project_foreground_approval_takeover_probe)

### Result
- Status: PASS
- `project-alpha` was skipped by the background router because it was in `waitingOnApproval`.
- `project-beta` was resumed and completed by the background router.
- The foreground then took over only alpha’s approval chain and completed alpha’s pending turn.
- Alpha’s unrelated inbox item stayed unread before and after foreground approval takeover.
- Both final files were correct and neither wrong file was created.

### Evidence
- alpha thread id `019d29a4-9f7f-7a90-9d4f-8a046531fee5`
- beta thread id `019d29a4-c865-7241-93ef-c8691b1a3b68`
- router decisions:
  - alpha: `skipped_pending_human_gate`
  - beta: `dispatched`
- foreground takeover:
  - first approval method `item/commandExecution/requestApproval`
  - follow-up approvals `22` through `26`
  - completed turn `019d29a4-a067-7900-86c8-00571eda7cae`
- alpha inbox item remained unread:
  - before takeover: `true`
  - after takeover: `true`
- final alpha file:
  - [/Users/mymac/my dev/remodex/verification/takeover_alpha_approved.txt](/Users/mymac/my%20dev/remodex/verification/takeover_alpha_approved.txt) contents `alpha-foreground-approved`
- final beta file:
  - [/Users/mymac/my dev/remodex/verification/takeover_beta_result.txt](/Users/mymac/my%20dev/remodex/verification/takeover_beta_result.txt) contents `beta-background-ok`
- wrong files:
  - [/Users/mymac/my dev/remodex/verification/takeover_alpha_wrong_dispatch.txt](/Users/mymac/my%20dev/remodex/verification/takeover_alpha_wrong_dispatch.txt) absent
  - [/Users/mymac/my dev/remodex/verification/takeover_beta_wrong.txt](/Users/mymac/my%20dev/remodex/verification/takeover_beta_wrong.txt) absent

### Observed Behaviors
- Approval lanes and ordinary inbox lanes can stay separated even inside the same project namespace.
- Background routing can make progress on one project without forcing resolution of another project’s human gate.
- Foreground approval takeover does not need to drain unrelated project-alpha inbox items to complete the pending approval turn.

### Operational Notes
- Alpha again produced a mixed approval family:
  - command execution approvals
  - file change approval
- The approval loop therefore needs the same buffered, family-agnostic handling as the single-project closure probe.

### Strategy Impact
- The strategy now has live evidence that `project-scoped approval lane` and `project-scoped background lane` can coexist without cross-dispatch.
- Foreground takeover should be modeled as “resume only the blocked approval lane”, not “drain every pending alpha event immediately”.
- This materially strengthens the multi-project operating model the user originally wanted.

## 2026-03-26 - Probe 40: launchd human gate candidate fail-closed

### Goal
- Verify that a real `launchd` worker does not consume a `human_gate_candidate`.
- Verify that `must_human_check` and `pending_human_gate` are enough to block background wake.
- Verify that the candidate remains as-is and no processed receipt is written by the background path.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_launchd_human_gate_candidate_fail_closed.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_launchd_human_gate_candidate_fail_closed.mjs)
- Worker script: [/Users/mymac/my dev/remodex/scripts/launchd_human_gate_worker.mjs](/Users/mymac/my%20dev/remodex/scripts/launchd_human_gate_worker.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe)

### Result
- Status: PASS
- `launchd` worker decided `blocked`.
- blocked reasons were exactly `must_human_check` and `pending_human_gate`.
- No wake file was written.
- The candidate file remained unchanged.
- No processed file was created.
- Thread turn count stayed `0 -> 0`.

### Evidence
- thread id `019d29db-c8fe-7c72-a241-a496b72a8215`
- blocked run:
  - decision `blocked`
  - blocked reasons `must_human_check`, `pending_human_gate`
- candidate remained in place:
  - [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/project_alpha/human_gate_candidates/2026-03-26T20-00-00+09-00_approve_candidate-001.json](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/project_alpha/human_gate_candidates/2026-03-26T20-00-00+09-00_approve_candidate-001.json)
- processed dir stayed empty:
  - [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/project_alpha/processed](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/project_alpha/processed)
- wake file absent:
  - [/Users/mymac/my dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/should_not_exist.txt](/Users/mymac/my%20dev/remodex/verification/launchd_human_gate_candidate_fail_closed_probe/should_not_exist.txt)

### Observed Behaviors
- Background `launchd` worker can stay observation-only even when a human gate candidate exists.
- A `human_gate_candidate` is not equivalent to a dispatchable inbox event.
- `thread/read(includeTurns)` cannot be trusted before the first user turn materializes the thread.

### Operational Notes
- This probe needed a small guard for `thread/read(includeTurns)` on unmaterialized threads.
- The correct fallback is `turnCount = 0`, not a seed turn, because the proof target is “background did not open work”.

### Strategy Impact
- The strategy should state that `launchd/background` must fail closed on `human_gate_candidates`.
- Human gate candidate consumption belongs to foreground only.
- Background evidence collection can still run without turning the candidate into processed truth.

## 2026-03-26 - Probe 41: same-thread unread inbox drain after approval lane

### Goal
- Verify that an unread inbox item can remain untouched while an approval-gated turn completes.
- Verify that the foreground can then drain that unread item on the same thread’s next turn.
- Verify that the drain path does not need a new thread or cross-project routing.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_foreground_post_approval_inbox_drain.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_foreground_post_approval_inbox_drain.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/foreground_post_approval_inbox_drain_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/foreground_post_approval_inbox_drain_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/foreground_post_approval_inbox_drain_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/foreground_post_approval_inbox_drain_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/foreground_post_approval_inbox_drain_probe](/Users/mymac/my%20dev/remodex/verification/foreground_post_approval_inbox_drain_probe)

### Result
- Status: PASS
- The unread inbox item stayed unread before and after approval completion.
- The approval turn completed on thread `019d29e5-1d96-73d1-b4d1-b0ebd877434a`.
- The foreground then opened the same thread’s next turn and drained the unread inbox item.
- Turn count moved `1 -> 2`.
- The inbox item moved to `processed`.
- Both target files were correct and neither wrong file was created.

### Evidence
- thread id `019d29e5-1d96-73d1-b4d1-b0ebd877434a`
- approval turn id `019d29e5-1e76-7993-aeb0-d7c73e9ad34a`
- drain turn id `019d29e5-ac76-7a92-81ed-c6711a6e342e`
- unread stayed in inbox:
  - before approval completion `true`
  - after approval completion `true`
- turn count:
  - before drain `1`
  - after drain `2`
- approval target:
  - [/Users/mymac/my dev/remodex/verification/post_approval_lane_target.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_lane_target.txt) contents `post-approval-lane-ok`
- drain target:
  - [/Users/mymac/my dev/remodex/verification/post_approval_drain_target.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_target.txt) contents `post-approval-drain-ok`
- wrong files absent:
  - [/Users/mymac/my dev/remodex/verification/post_approval_lane_wrong.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_lane_wrong.txt)
  - [/Users/mymac/my dev/remodex/verification/post_approval_drain_wrong.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_wrong.txt)
- processed inbox item:
  - [/Users/mymac/my dev/remodex/verification/foreground_post_approval_inbox_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T23-30-00+09-00_post_approval_answer.json](/Users/mymac/my%20dev/remodex/verification/foreground_post_approval_inbox_drain_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T23-30-00+09-00_post_approval_answer.json)

### Observed Behaviors
- The unread inbox lane can stay dormant while the approval lane finishes.
- Draining the unread item does not require a new thread; the same thread’s next turn is sufficient.
- The ordinary drain turn can itself reopen approval requests.

### Operational Notes
- `thread/resume` with `approvalPolicy: never` did not guarantee a no-approval drain turn in this environment.
- The drain turn still raised:
  - command execution approval
  - file change approval
  - verification command approval
- Foreground drain logic therefore needs the same approval-family loop discipline as the original approval lane.

### Strategy Impact
- The strategy can now explicitly say “approval lane first, then unread inbox drain on the same thread”.
- It must not assume the post-approval drain turn is approval-free.
- Foreground takeover should be modeled as a turn-by-turn continuation on the same thread, not as a one-time approval-only patch.

## 2026-03-26 - Probe 42: same-thread post-approval drain with processed receipt + recovery dedupe

### Goal
- Verify that the same-thread unread inbox drain path can write `processed/*` receipt and `state/processed_correlation_index.md`.
- Verify that recovery can later see the same unread inbox item and skip replay without opening a new turn.
- Verify that duplicate-skip itself also writes processed truth.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_post_approval_drain_processed_recovery.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_post_approval_drain_processed_recovery.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe)

### Result
- Status: PASS
- Approval lane completed on the original thread.
- The unread inbox item was drained on the same thread’s next turn.
- Foreground wrote a `consumed` processed receipt and processed correlation index entry for that drain.
- Recovery then saw the still-retained unread inbox item, returned `skipped_duplicate`, wrote a second processed receipt, and did not open a third turn.
- Turn count stayed `2 -> 2` during recovery.

### Evidence
- thread id `019d29ec-70f2-7731-8bd5-98591b19dc1b`
- approval turn id `019d29ec-72f2-78a2-ae5b-1a5b4546ebca`
- drain turn id `019d29ec-d0c0-7453-b100-fa934915ac23`
- consumed receipt:
  - [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T11-34-56.587Z_post-approval-processed-recovery-001_consumed.json](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T11-34-56.587Z_post-approval-processed-recovery-001_consumed.json)
- duplicate-skip receipt:
  - [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T11-34-56.620Z_post-approval-processed-recovery-001_skipped_duplicate.json](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T11-34-56.620Z_post-approval-processed-recovery-001_skipped_duplicate.json)
- processed correlation index:
  - [/Users/mymac/my dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/state/processed_correlation_index.md](/Users/mymac/my%20dev/remodex/verification/post_approval_drain_processed_recovery_probe/external-shared-memory/remodex/projects/project-alpha/state/processed_correlation_index.md)
- recovery:
  - decision `skipped_duplicate`
  - `duplicateInIndex = true`
  - `duplicateInReceipt = true`
  - `beforeTurnCount = 2`
  - `afterTurnCount = 2`
- final files:
  - [/Users/mymac/my dev/remodex/verification/post_approval_processed_lane_target.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_processed_lane_target.txt) contents `post-approval-processed-lane-ok`
  - [/Users/mymac/my dev/remodex/verification/post_approval_processed_drain_target.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_processed_drain_target.txt) contents `post-approval-processed-drain-ok`
- wrong files absent:
  - [/Users/mymac/my dev/remodex/verification/post_approval_processed_lane_wrong.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_processed_lane_wrong.txt)
  - [/Users/mymac/my dev/remodex/verification/post_approval_processed_drain_wrong.txt](/Users/mymac/my%20dev/remodex/verification/post_approval_processed_drain_wrong.txt)

### Observed Behaviors
- same-thread drain 경로도 `processed/*`와 `state/processed_correlation_index.md`를 같이 써야 recovery가 안전하다.
- unread inbox 원본이 남아 있어도 processed truth가 있으면 recovery는 turn을 다시 열지 않는다.
- duplicate-skip도 별도 processed receipt로 남겨야 나중에 감사 추적이 된다.

### Operational Notes
- drain turn은 이 run에서도 approval-free가 아니었다.
- approval lane과 post-approval drain turn은 서로 다른 approval family를 가질 수 있다.
- recovery skip는 “아무 것도 안 함”이 아니라 `processed truth 추가 기록 + turn 미개시`로 정의하는 편이 운영상 더 견고하다.

### Strategy Impact
- `same_thread_post_approval_drain_must_record_processed_receipt: true`는 실검증으로 뒷받침됐다.
- recovery는 same-thread drain 뒤에도 `processed receipt/index`를 먼저 보고 duplicate-skip해야 한다.
- ordinary unread inbox를 audit 때문에 보관하더라도, processed truth만 있으면 replay는 차단할 수 있다.

## 2026-03-26 - Probe 43: project-local conversation bridge thread

### Goal
- 별도 conversation bridge thread가 메인 thread를 직접 advance하지 않고 operator-facing 상태 조회를 수행할 수 있는지 검증한다.
- 같은 bridge thread가 shared memory snapshot을 읽어 현재 상태를 설명하고, operator intent를 structured inbox event로 적재할 수 있는지 검증한다.
- bridge thread가 메인 대신 판단하지 않고 target main thread를 명시한 queue 확인 응답만 남기는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_conversation_bridge_thread.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_conversation_bridge_thread.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/conversation_bridge_thread_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/conversation_bridge_thread_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/conversation_bridge_thread_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/conversation_bridge_thread_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/conversation_bridge_thread_probe](/Users/mymac/my%20dev/remodex/verification/conversation_bridge_thread_probe)

### Result
- Status: PASS
- main thread는 seed turn 1회만 가진 채 유지됐다.
- bridge thread는 같은 project에서 3개 turn을 연속 수행했다.
- 첫 turn은 shared memory snapshot을 읽고 상태 JSON을 반환했다.
- 둘째 turn은 operator intent를 `inbox/*`에 structured JSON으로 기록했다.
- 셋째 turn은 inbox와 coordinator binding을 읽고 `queued: true`, `route: inbox`, `target_thread: <mainThreadId>`를 반환했다.

### Evidence
- main thread id `019d2a07-2edc-74d3-9b78-7d8a5a02c686`
- bridge thread id `019d2a07-4556-7db1-9091-4a0ee20ac1c0`
- main before:
  - `turnCount = 1`
  - `lastText = main-ready`
- main after:
  - `turnCount = 1`
- bridge turn count:
  - `3`
- bridge status answer:
  - `{"goal":"Fix login bug","roadmap_current_point":"integration-tests","next_smallest_batch":"run integration tests first"}`
- intent inbox record:
  - [/Users/mymac/my dev/remodex/verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T23-50-00+09-00_bridge_intent.json](/Users/mymac/my%20dev/remodex/verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T23-50-00+09-00_bridge_intent.json)
  - `correlation_key = bridge-thread-intent-001`
  - `source = bridge_thread`
  - `target_thread = 019d2a07-2edc-74d3-9b78-7d8a5a02c686`
- bridge confirm answer:
  - `{"queued":true,"route":"inbox","target_thread":"019d2a07-2edc-74d3-9b78-7d8a5a02c686","bridge_mode":"bound"}`

### Observed Behaviors
- bridge thread는 메인 thread와 분리된 실시간 operator surface로 둘 수 있다.
- shared memory snapshot만 읽어도 현재 상태를 충분히 구조화된 응답으로 설명할 수 있다.
- bridge thread는 메인을 직접 건드리지 않고도 operator intent를 main-bound inbox event로 적재할 수 있다.
- 메인 advance 없이 `target_thread` 바인딩만 확인하는 방식이 authority 분리를 유지한다.

### Operational Notes
- conversation bridge thread는 `second coordinator`가 아니라 operator console surface로 정의해야 한다.
- bridge thread가 메인을 대신해 우선순위나 repo 반영을 결정하기 시작하면 구조가 깨진다.
- busy/non-interruptible 상태에서도 bridge thread는 direct injection이 아니라 inbox/dispatch 규약을 따라야 한다.

### Strategy Impact
- project-local conversation bridge thread 패턴은 유효하다.
- 다만 bridge thread의 권한은 `상태 조회`, `질문/응답 중계`, `intent 적재`, `approval candidate 기록`으로 제한해야 한다.
- 메인 thread는 그대로 단일 판단자여야 하며, bridge thread는 operator-facing surface로만 남겨야 한다.

## 2026-03-27 - Probe 44: bridge daemon signed ingress -> async delivery

### Goal
- signed Discord-style ingress가 bridge daemon에서 즉시 `accepted` 응답을 돌리고, 실제 same-thread delivery는 비동기로 이어지는지 검증한다.
- `/status`와 `/intent`가 같은 runtime 경계를 공유하면서도 `ack != delivery completion` 의미론을 유지하는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_daemon_end_to_end.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_daemon_end_to_end.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_daemon_end_to_end_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_end_to_end_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/bridge_daemon_end_to_end_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_end_to_end_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_daemon_end_to_end_probe](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_end_to_end_probe)

### Result
- Status: PASS
- `/status`는 200으로 snapshot summary를 즉시 반환했다.
- `/intent`는 202와 `scheduled_delivery`를 반환했고, 이후 same-thread delivery가 실제 파일 side effect를 만들었다.
- bridge daemon은 HTTP ack를 먼저 돌리고 delivery는 background path에서 마무리했다.

### Evidence
- thread id `019d2c3c-90ca-7700-b50a-ca6219680e6f`
- status response summary:
  - `project_key = project-alpha`
  - `coordinator_status = checkpoint_open`
  - `next_smallest_batch = deliver daemon intent`
- intent response:
  - `delivery_decision = scheduled_delivery`
  - inbox record:
    - [/Users/mymac/my dev/remodex/verification/bridge_daemon_end_to_end_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T22-31-00+09-00_intent_bridge-daemon-intent-001.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_end_to_end_probe/external-shared-memory/remodex/projects/project-alpha/inbox/2026-03-26T22-31-00+09-00_intent_bridge-daemon-intent-001.json)
- status outbox:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_end_to_end_probe/external-shared-memory/remodex/router/outbox/2026-03-26T22-36-04.844Z_status_response_bridge-daemon-status-001.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_end_to_end_probe/external-shared-memory/remodex/router/outbox/2026-03-26T22-36-04.844Z_status_response_bridge-daemon-status-001.json)
- final target:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_target.txt](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_target.txt) contents `bridge-daemon-ok`

### Observed Behaviors
- operator ingress는 동기 RPC처럼 completion까지 붙들고 있지 않아도 된다.
- daemon은 inbox truth를 먼저 남기고 same-thread delivery를 뒤에서 이어갈 수 있다.

### Strategy Impact
- Discord/operator ingress는 `accepted`와 `delivered`를 분리한 비동기 ack 모델로 문서화하는 편이 맞다.
- bridge daemon은 `status`는 즉답, `intent/reply`는 schedule-after-persist가 기본값이어야 한다.

## 2026-03-27 - Probe 45: scheduler runtime blocked vs delivered with completion fallback

### Goal
- scheduler tick이 foreground active일 때는 block되고, background eligible일 때는 same-thread delivery를 끝내는지 검증한다.
- delivery completion이 `turn/completed` 하나에만 의존하지 않고 `thread/read` terminal status fallback으로도 닫히는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_scheduler_tick_runtime.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_scheduler_tick_runtime.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/scheduler_tick_runtime_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/scheduler_tick_runtime_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/scheduler_tick_runtime_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/scheduler_tick_runtime_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/scheduler_tick_runtime_probe](/Users/mymac/my%20dev/remodex/verification/scheduler_tick_runtime_probe)

### Result
- Status: PASS
- blocked phase는 `background_trigger_disabled`, `foreground_session_active`, `status_busy_non_interruptible`로 차단됐다.
- allowed phase는 `decision = inbox`, `delivery_decision = delivered`로 닫혔다.
- 첫 구현은 side effect는 끝났는데 `turn/completed` 대기에서 멈췄고, 이후 `thread/read` terminal status fallback을 넣어 경로를 안정화했다.

### Evidence
- thread id `019d2c3f-9813-7213-a791-cdbfcb0db0e2`
- blocked runtime:
  - decision `blocked`
  - reasons:
    - `background_trigger_disabled`
    - `foreground_session_active`
    - `status_busy_non_interruptible`
- delivered runtime:
  - decision `inbox`
  - `delivery_decision = delivered`
  - turn id `019d2c3f-99c3-7063-8bfb-c335ade0b5ee`
  - receipt:
    - [/Users/mymac/my dev/remodex/verification/scheduler_tick_runtime_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T22-24-48.980Z_consumed_delivered-intent.json.json](/Users/mymac/my%20dev/remodex/verification/scheduler_tick_runtime_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T22-24-48.980Z_consumed_delivered-intent.json.json)
- final target:
  - [/Users/mymac/my dev/remodex/verification/scheduler_tick_delivered.txt](/Users/mymac/my%20dev/remodex/verification/scheduler_tick_delivered.txt) contents `scheduler-tick-ok`

### Observed Behaviors
- side effect와 terminal turn state가 먼저 materialize되고 `turn/completed` notification이 누락되거나 늦을 수 있다.
- scheduler/daemon delivery 경로는 `thread/read`의 terminal turn status를 completion fallback으로 써야 안정적이다.

### Strategy Impact
- delivery completion은 이벤트 하나가 아니라 `completed notification OR terminal thread/read state`로 정의하는 편이 맞다.
- scheduler runtime은 이 fallback을 가져야 blocked/allowed probe와 실제 운영 모두에서 안정적이다.

## 2026-03-27 - Probe 46: bridge daemon delivery with foreground-owned human gate closure

### Goal
- bridge daemon이 signed intent를 same-thread로 delivery할 수 있는지 검증한다.
- approval이 걸리면 background daemon이 closure를 가져가지 않고 foreground owner client가 human gate를 닫는지 검증한다.
- daemon은 approval 상태를 관측할 수 있어도 live approval server request ownership은 foreground에 남는다는 가설을 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_daemon_human_gate.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_daemon_human_gate.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_probe_summary.json)
- Event log:
  - foreground owner client: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_probe_events.jsonl)
  - daemon client: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_probe/external-shared-memory/remodex/router/bridge_daemon_events.jsonl](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_probe/external-shared-memory/remodex/router/bridge_daemon_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_probe](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_probe)

### Result
- Status: PASS
- daemon은 signed intent를 `scheduled_delivery`로 수락하고 same-thread execution을 시작했다.
- approval request는 daemon pending store에는 안 잡혔고, foreground owner client 쪽에서 first approval와 follow-up approvals를 받았다.
- foreground owner client가 approval loop를 닫은 뒤 turn이 완료됐고, 목표 파일만 생성됐다.

### Evidence
- thread id `019d2c43-4f0c-7810-90fb-0fe03d653a64`
- turn id `019d2c43-5123-74f2-a99c-761c981b619a`
- intent response:
  - `delivery_decision = scheduled_delivery`
- first approval observed by foreground owner:
  - method `item/commandExecution/requestApproval`
  - request id `52`
- follow-up approvals accepted by foreground owner:
  - `item/fileChange/requestApproval` id `53`
  - `item/commandExecution/requestApproval` id `54`
- daemon pending approval store:
  - `null`
- human gate outbox notification:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_probe/external-shared-memory/remodex/router/outbox/2026-03-26T22-36-39.446Z_human_gate_notification_status-019d2c4a-b9fd-7353-b692-5881e775ddac-active-waitingOnApproval.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_probe/external-shared-memory/remodex/router/outbox/2026-03-26T22-36-39.446Z_human_gate_notification_status-019d2c4a-b9fd-7353-b692-5881e775ddac-active-waitingOnApproval.json)
- final target:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_ok.txt](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_ok.txt) contents `bridge-daemon-human-gate-ok`
- wrong target absent:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_wrong.txt](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_wrong.txt)

### Observed Behaviors
- background daemon이 same-thread delivery를 시작하더라도 approval server request ownership은 foreground thread owner client에 남을 수 있다.
- daemon은 approval 대기 상태를 관측할 수는 있지만, live approval closure를 기본 책임으로 가져가면 안 된다.
- foreground owner는 first approval 이후 follow-up approval family도 loop로 닫아야 한다.
- `waitingOnApproval` 재진입이 반복되면 human gate outbox notification도 여러 번 발행될 수 있으므로, notification dedupe는 hardening 항목으로 남는다.

### Strategy Impact
- human gate closure 기본 책임은 foreground thread owner로 둬야 한다.
- background daemon/bridge는 approval이 걸리면 fail-closed로 멈추고, foreground handoff를 전제로 설계하는 편이 맞다.

## 2026-03-27 - Probe 47: app-server `turn/start` overload backoff

### Goal
- `turn/start`가 retryable overload를 반환할 때 helper가 즉시 실패하지 않고 bounded backoff 후 재시도하는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_app_server_overload_backoff.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_app_server_overload_backoff.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/app_server_overload_backoff_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/app_server_overload_backoff_probe_summary.json)

### Result
- Status: PASS
- mock client가 처음 두 번 `queue overloaded (-32001)`를 반환해도 helper는 세 번째 시도에서 turn을 성공시켰다.

### Evidence
- turn start attempts `3`
- final turn id `turn-overload-probe-001`
- final text `backoff-ok`

### Strategy Impact
- `-32001` 계열 overload는 non-retryable 실패와 구분해야 한다.
- bridge/scheduler가 공용 helper의 bounded exponential backoff를 공유하는 편이 맞다.

## 2026-03-27 - Probe 48: bridge runtime inflight recovery

### Goal
- turn이 이미 끝났지만 processed truth를 쓰기 전에 worker가 중단된 상황을 `inflight_delivery`만으로 복구할 수 있는지 검증한다.
- recovery가 새 turn을 다시 열지 않고 same-thread terminal turn을 읽어 `processed/*`를 남기는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_runtime_inflight_recovery.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_runtime_inflight_recovery.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_runtime_inflight_recovery_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_runtime_inflight_recovery_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/bridge_runtime_inflight_recovery_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/bridge_runtime_inflight_recovery_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_runtime_inflight_recovery_probe](/Users/mymac/my%20dev/remodex/verification/bridge_runtime_inflight_recovery_probe)

### Result
- Status: PASS
- seeded turn 완료 후 수동으로 `runtime/inflight_delivery.json`을 남긴 상태에서 runtime recovery를 실행하자, 새 turn 없이 `completed_inflight`로 닫혔다.

### Evidence
- thread id `019d2c69-b628-7fe1-8b2b-8063fd45e130`
- seeded turn id `019d2c69-b73f-7793-8f74-76a08b646967`
- turn count before/after `1 -> 1`
- inflight before:
  - [/Users/mymac/my dev/remodex/verification/bridge_runtime_inflight_recovery_probe/external-shared-memory/remodex/projects/project-alpha/runtime/inflight_delivery.json](/Users/mymac/my%20dev/remodex/verification/bridge_runtime_inflight_recovery_probe/external-shared-memory/remodex/projects/project-alpha/runtime/inflight_delivery.json)
- processed receipt:
  - [/Users/mymac/my dev/remodex/verification/bridge_runtime_inflight_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T23-10-24.257Z_consumed_inflight-recovery-source-001.json](/Users/mymac/my%20dev/remodex/verification/bridge_runtime_inflight_recovery_probe/external-shared-memory/remodex/projects/project-alpha/processed/2026-03-26T23-10-24.257Z_consumed_inflight-recovery-source-001.json)

### Observed Behaviors
- `inflight_delivery`에 turn id와 원본 record가 있으면 recovery는 unread inbox보다 inflight를 먼저 처리할 수 있다.
- terminal turn이 이미 존재하면 same-thread replay 없이 `processed/*`만 기록하고 inflight를 정리하는 편이 맞다.

### Strategy Impact
- `inflight_delivery`는 worker 내부 임시 메모가 아니라 first-class 운영 truth로 문서화해야 한다.
- recovery/router/scheduler는 새 delivery 전에 inflight를 선검사해야 한다.

## 2026-03-27 - Probe 49: bridge daemon human gate notification dedupe

### Goal
- approval loop 중 `waitingOnApproval` 재진입이 여러 번 발생해도 bridge daemon이 operator outbox에 human gate notification을 한 번만 발행하는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_bridge_daemon_human_gate_notification_dedupe.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_bridge_daemon_human_gate_notification_dedupe.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe)

### Result
- Status: PASS
- foreground owner는 approval `3`회를 loop로 닫았고, daemon outbox에는 `human_gate_notification`이 `1`개만 남았다.

### Evidence
- thread id `019d2c6b-8e8b-7373-942f-4c60e0afc4fd`
- approval count `3`
- outbox notification:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe/external-shared-memory/remodex/router/outbox/2026-03-26T23-12-40.158Z_human_gate_notification_status-019d2c6b-8e8b-7373-942f-4c60e0afc4fd-active-waitingOnApproval.json](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_probe/external-shared-memory/remodex/router/outbox/2026-03-26T23-12-40.158Z_human_gate_notification_status-019d2c6b-8e8b-7373-942f-4c60e0afc4fd-active-waitingOnApproval.json)
- final target:
  - [/Users/mymac/my dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_ok.txt](/Users/mymac/my%20dev/remodex/verification/bridge_daemon_human_gate_notification_dedupe_ok.txt) contents `bridge-daemon-human-gate-dedupe-ok`

### Observed Behaviors
- approval family가 여러 번 뜨더라도 operator는 같은 lane에 대해 notification 한 번이면 충분하다.
- dedupe는 `waitingOnApproval` 재진입마다 notification을 새로 쓰는 것보다 operator noise를 훨씬 줄인다.

### Strategy Impact
- human gate notification은 approval lane이 완전히 닫힐 때까지 한 번만 발행하는 dedupe 규약으로 고정하는 편이 맞다.

## 2026-03-27 - Probe 50: scheduler long-run churn

### Goal
- scheduler tick을 반복 실행해도 `allowed -> blocked -> drain -> noop -> allowed` 전환에서 duplicate delivery, inflight 잔존, processed 누락이 없는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_scheduler_churn_long_run.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_scheduler_churn_long_run.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/scheduler_churn_long_run_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_long_run_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/scheduler_churn_long_run_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_long_run_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/scheduler_churn_long_run_probe](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_long_run_probe)

### Result
- Status: PASS
- 다섯 번의 tick에서 decision sequence가 정확히 `inbox -> blocked -> inbox -> noop -> inbox`로 나왔고, turn count는 `0 -> 3`으로만 증가했다.

### Evidence
- thread id `019d2c83-0660-7ac0-849a-44681aeaec09`
- decisions:
  - cycle1 `inbox`
  - cycle2 `blocked`
  - cycle3 `inbox`
  - cycle4 `noop`
  - cycle5 `inbox`
- processed receipts `3`
- inbox remaining `0`
- inflight after `null`
- final targets:
  - [/Users/mymac/my dev/remodex/verification/scheduler_churn_cycle1.txt](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_cycle1.txt) contents `scheduler-churn-cycle-1`
  - [/Users/mymac/my dev/remodex/verification/scheduler_churn_cycle2.txt](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_cycle2.txt) contents `scheduler-churn-cycle-2`
  - [/Users/mymac/my dev/remodex/verification/scheduler_churn_cycle3.txt](/Users/mymac/my%20dev/remodex/verification/scheduler_churn_cycle3.txt) contents `scheduler-churn-cycle-3`

### Observed Behaviors
- blocked된 inbox는 그대로 유지되고, 다음 허용 tick에서 정확히 한 번만 drain된다.
- noop tick은 processed/inflight를 오염시키지 않는다.
- 반복 tick에서도 same-thread delivery와 processed truth가 안정적으로 같이 증가한다.

### Strategy Impact
- scheduler churn은 한 번의 blocked/allowed 분기만으로는 충분하지 않고, 반복 tick에서도 idempotent해야 한다.
- `inbox 유지 -> 다음 허용 tick drain -> processed 기록 -> inflight clear` 수명주기가 장시간 반복에서도 유지돼야 한다.

## 2026-03-27 - Probe 51: operator ingress churn with inflight completion and post-turn receipt dedupe

### Goal
- signed Discord/operator ingress를 반복으로 태워도 `status -> intent -> foreground defer -> replay reject -> quarantine -> scheduler drain` 전 구간에서 same-thread delivery와 processed receipt가 안정적으로 유지되는지 검증한다.

### Setup
- Probe script: [/Users/mymac/my dev/remodex/scripts/probe_discord_operator_ingress_churn.mjs](/Users/mymac/my%20dev/remodex/scripts/probe_discord_operator_ingress_churn.mjs)
- Summary output: [/Users/mymac/my dev/remodex/verification/discord_operator_ingress_churn_probe_summary.json](/Users/mymac/my%20dev/remodex/verification/discord_operator_ingress_churn_probe_summary.json)
- Event log: [/Users/mymac/my dev/remodex/verification/discord_operator_ingress_churn_probe_events.jsonl](/Users/mymac/my%20dev/remodex/verification/discord_operator_ingress_churn_probe_events.jsonl)
- Probe root: [/Users/mymac/my dev/remodex/verification/discord_operator_ingress_churn_probe](/Users/mymac/my%20dev/remodex/verification/discord_operator_ingress_churn_probe)

### Result
- Status: PASS
- 첫 scheduler tick은 `completed_inflight`, 둘째 tick은 `delivered`로 이어졌고, 같은 `correlation_key`에 second `consumed` 영수증은 남지 않았다.

### Evidence
- thread id `019d2c96-ed47-71e2-b25f-8bb74f4cf579`
- turn count `2`
- scheduler attempts:
  - attempt1 `dispatch_queue -> completed_inflight`
  - attempt2 `dispatch_queue -> delivered`
- processed receipts `2`
- quarantine files `2`
- status outbox `3`
- final targets:
  - [/Users/mymac/my dev/remodex/verification/discord_ingress_churn_target1.txt](/Users/mymac/my%20dev/remodex/verification/discord_ingress_churn_target1.txt) contents `ingress-churn-1`
  - [/Users/mymac/my dev/remodex/verification/discord_ingress_churn_target2.txt](/Users/mymac/my%20dev/remodex/verification/discord_ingress_churn_target2.txt) contents `ingress-churn-2`

### Observed Behaviors
- file 생성 시점과 turn completion 시점은 다르므로, second drain 전에는 first turn idle/completed를 따로 기다려야 한다.
- same-thread async delivery와 inflight recovery가 겹칠 수 있으므로, turn 종료 뒤에도 `processed correlation`을 한 번 더 확인해 기존 영수증을 재사용해야 한다.
- foreground defer, replay reject, quarantine, scheduler drain이 한 배치에서 같이 일어나도 processed truth는 1 correlation당 1 consumed를 유지할 수 있다.

### Strategy Impact
- operator ingress churn 성공 조건에는 `turn count`, `processed receipt 수`, `quarantine 수`, `status outbox 수`, `same-thread final targets`가 같이 들어가야 한다.
- inflight recovery 이후 original async delivery가 second `consumed` 영수증을 남기지 않도록 post-turn processed dedupe를 전략 불변식으로 올리는 편이 맞다.

## 2026-03-27 - Probe 52: production bootstrap asset validation

### Goal
- 실운영용 launchd/bootstrap 자산이 실제로 생성 가능하고, wrapper/install 스크립트 문법 오류 없이 production 경로를 렌더링하는지 검증한다.

### Setup
- Assets:
  - [/Users/mymac/my dev/remodex/ops/remodex.env.example](/Users/mymac/my%20dev/remodex/ops/remodex.env.example)
  - [/Users/mymac/my dev/remodex/ops/run_bridge_daemon.sh](/Users/mymac/my%20dev/remodex/ops/run_bridge_daemon.sh)
  - [/Users/mymac/my dev/remodex/ops/run_scheduler_tick.sh](/Users/mymac/my%20dev/remodex/ops/run_scheduler_tick.sh)
  - [/Users/mymac/my dev/remodex/ops/render_launchd_plists.mjs](/Users/mymac/my%20dev/remodex/ops/render_launchd_plists.mjs)
  - [/Users/mymac/my dev/remodex/ops/install_launchd_services.sh](/Users/mymac/my%20dev/remodex/ops/install_launchd_services.sh)
  - [/Users/mymac/my dev/remodex/ops/uninstall_launchd_services.sh](/Users/mymac/my%20dev/remodex/ops/uninstall_launchd_services.sh)
- Generated output:
  - [/Users/mymac/my dev/remodex/ops/launchd/generated/com.remodex.bridge-daemon.plist](/Users/mymac/my%20dev/remodex/ops/launchd/generated/com.remodex.bridge-daemon.plist)
  - [/Users/mymac/my dev/remodex/ops/launchd/generated/com.remodex.scheduler-tick.plist](/Users/mymac/my%20dev/remodex/ops/launchd/generated/com.remodex.scheduler-tick.plist)

### Result
- Status: PASS
- 네 개 shell wrapper/install 스크립트는 `zsh -n`을 통과했고, plist renderer는 bridge daemon + scheduler tick launchd plist를 production 경로 기준으로 생성했다.

### Evidence
- generated bridge label `com.remodex.bridge-daemon`
- generated scheduler label `com.remodex.scheduler-tick`
- generated scheduler interval `60`
- generated log dir `/Users/mymac/my dev/remodex/runtime/launchd`

### Observed Behaviors
- renderer가 `ops/remodex.env`를 직접 읽지 않으면 shell export에 의존하게 되므로, env file 직접 파싱이 필요했다.
- wrapper를 `/bin/zsh`로 감싼 launchd plist가 workspace path에 공백이 있어도 안전하다.

### Strategy Impact
- production bootstrap은 probe용 plist를 재사용하는 대신 env-driven renderer와 wrapper 조합으로 고정하는 편이 맞다.
- launchd asset도 strategy/WBS 바깥 부속물이 아니라 운영 통제면의 일부로 관리해야 한다.
