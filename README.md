# Remodex

Remodex는 Codex app-server, shared memory, Discord operator ingress, scheduler tick을 조합해 `프로젝트별 메인 thread`를 안전하게 이어서 운영하는 제어면이다.

중요:

- 현재 저장소의 `bridge daemon` HTTP ingress는 loopback 내부/probe용이다.
- 정식 Discord 운영 경계의 canonical path는 **Discord Gateway adapter**다.
- public webhook relay는 차선책일 뿐이며, raw bridge를 그대로 공개 edge로 두는 구조는 채택하지 않는다.

핵심 목표:

- 모바일/Discord에서 프로젝트 메인에게 상태 조회와 작업 지시를 보낼 수 있게 한다.
- foreground 앱 작업과 background 자동 진행이 충돌하지 않게 한다.
- `processed receipt`, `inflight truth`, `human gate`를 기준으로 중복 실행과 위험한 자동 진행을 막는다.
- 여러 프로젝트가 동시에 있어도 namespace, binding, approval lane이 섞이지 않게 한다.

## Core Model

- `Codex app-server`
  - 실제 same-thread turn 실행 경계
- `shared memory`
  - project별 운영 truth
- `bridge daemon`
  - internal bridge runtime, status 응답, human gate candidate 기록
- `Discord Gateway adapter`
  - canonical production Discord ingress
- `scheduler tick`
  - background mode에서만 wake / dispatch 수행
- `foreground main`
  - 최종 판단, approval closure, repo mutation 담당

즉, 이 저장소는 `메인 thread 직접 주입`이 아니라 `shared memory를 읽는 단일 foreground brain` 모델을 구현한다.

## Main Documents

- 전략 원문: [STRATEGY.md](./STRATEGY.md)
- 메인 읽기 계약: [MAIN_COORDINATOR_PROMPT_CONTRACT.md](./MAIN_COORDINATOR_PROMPT_CONTRACT.md)
- 실행 계획: [EXECUTION_PLAN.md](./EXECUTION_PLAN.md)
- WBS: [WBS.md](./WBS.md)
- 대시보드 명세: [DASHBOARD_MVP.md](./DASHBOARD_MVP.md)
- Windows 포팅 점검표: [WINDOWS_PORTABILITY_CHECKLIST.md](./WINDOWS_PORTABILITY_CHECKLIST.md)
- Windows bootstrap: [WINDOWS_BOOTSTRAP.md](./WINDOWS_BOOTSTRAP.md)
- macOS soak 계획: [MACOS_SOAK_TEST_PLAN.md](./MACOS_SOAK_TEST_PLAN.md)
- 평시 운영: [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
- 장애/복구: [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)
- 실운영 bootstrap: [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- Discord live proof: [DISCORD_LIVE_PROOF_RUNBOOK.md](./DISCORD_LIVE_PROOF_RUNBOOK.md)
- 검증 로그 요약: [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)

## What Is Implemented

- project-scoped namespace / coordinator binding / status mirror
- `status`, `intent`, `reply`, `approve-candidate` operator ingress
- `projects`, project 자동완성, `/use-project` 채널 기본 프로젝트 바인딩
- `background-on`, `foreground-on` Discord mode 전환
- channel binding 또는 single-project default 기반 `project` 생략 UX
- `/projects` 선택 카드, 상태/고정/작업지시 버튼, 작업지시 modal
- project 카드의 `백그라운드 시작` / `앱 복귀` 버튼
- bound Discord 채널 plain text bridge-thread conversation surface
- `지금 어디까지 했어?` 같은 상태 질문이 실제 bridge thread turn으로 응답
- bound 채널 plain text 작업 요청 -> bridge thread handoff -> main inbox/dispatch 적재
- human gate / processed receipt 기반 자동 채널 알림을 bridge thread가 사람 말로 다시 요약
- bridge thread 응답은 runtime validation을 통과해야 하고, 연결 식별자 누락/내부 용어 누출/잘못된 action은 reject 후 재작성
- bridge validation이 반복 실패할 때만 마지막 수단 safe fallback을 허용하고, 기본 경로는 실제 bridge thread 자연어 응답 유지
- bridge 지시문/동작 가이드북은 [DISCORD_BRIDGE_THREAD_GUIDEBOOK.md](/Users/mymac/my%20dev/remodex/DISCORD_BRIDGE_THREAD_GUIDEBOOK.md) 를 source of truth로 유지
- Message Content intent 미설정 시 `mention/slash-only` degraded mode fallback
- dispatch queue arbitration
- foreground/background toggle
- human gate candidate / foreground-only closure
- processed receipt / processed correlation dedupe
- inflight recovery / overload backoff
- long-run scheduler churn 검증
- long-run operator ingress churn 검증
- launchd bootstrap assets
- macOS-first bootstrap / Windows portability assessment
- Windows PowerShell bootstrap assets
- 운영 저장소와 로컬 생성물을 분리하는 ignore 정책
- 대시보드 MVP 명세
- read-only dashboard API / HTML root

## Repository Layout

```text
.
├── STRATEGY.md
├── MAIN_COORDINATOR_PROMPT_CONTRACT.md
├── EXECUTION_PLAN.md
├── WBS.md
├── NORMAL_OPS_MANUAL.md
├── INCIDENT_RECOVERY_RUNBOOK.md
├── PRODUCTION_BOOTSTRAP.md
├── WINDOWS_BOOTSTRAP.md
├── WINDOWS_PORTABILITY_CHECKLIST.md
├── MACOS_SOAK_TEST_PLAN.md
├── ops/
│   ├── remodex.env.example
│   ├── collect_macos_runtime_metrics.sh
│   ├── install_windows_scheduled_tasks.ps1
│   ├── bootstrap_macos_smoke_fixture.mjs
│   ├── render_scheduler_artifacts.mjs
│   ├── run_bridge_daemon.sh
│   ├── run_bridge_daemon.ps1
│   ├── run_dashboard_server.sh
│   ├── run_macos_smoke.sh
│   ├── run_macos_smoke_stack.sh
│   ├── summarize_macos_smoke_stack.mjs
│   ├── run_scheduler_tick.sh
│   ├── run_scheduler_tick.ps1
│   ├── render_launchd_plists.mjs
│   ├── install_launchd_services.sh
│   ├── uninstall_launchd_services.sh
│   └── uninstall_windows_scheduled_tasks.ps1
├── scripts/
│   ├── remodex_bridge_daemon.mjs
│   ├── remodex_dashboard_server.mjs
│   ├── remodex_scheduler_tick.mjs
│   └── lib/
├── verification/
│   └── VERIFICATION_LOG.md
├── runtime/
└── .gitignore
```

## Quick Start

### 1. Validation baseline

핵심 검증 근거와 운영 제약은 [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)에 정리돼 있다. 원시 probe 산출물과 생성된 launchd plist, runtime 로그는 저장소 기본 배치에서 제외하고 로컬 생성물로 취급한다.

### 2. Production bootstrap

1. [ops/remodex.env.example](./ops/remodex.env.example)를 `ops/remodex.env`로 복사
2. Discord application id, bot token path, guild id, app-server WS URL, shared base를 설정한다.
   - canonical Gateway 운영만 쓸 때 `Discord public key`는 비워둔다.
3. scheduler artifact 생성

```bash
node ops/render_scheduler_artifacts.mjs
```

생성 결과:

- `ops/launchd/generated/com.remodex.bridge-daemon.plist`
- `ops/launchd/generated/com.remodex.scheduler-tick.plist`

자세한 순서는 [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)를 따른다.

### 2.1 Discord operator quick start

1. 처음엔 `/projects`로 현재 shared memory에 등록된 프로젝트와, **아직 attach되지 않은 기존 Codex thread 후보**를 같이 본다.
2. 기존 Codex 메인 thread가 이미 있으면 `/projects` 카드에서 먼저 붙인다.
   - 기본은 `추천 보기`
   - 필요하면 `다른 저장소 포함 전체 보기`
   - thread id를 이미 알면 `직접 연결` 또는 `/attach-thread thread_id:<...>`
   - `/attach-thread`는 자동완성을 지원하고, 알림 채널에 보이는 short id 8자리 prefix도 unique하면 그대로 붙일 수 있다
   - `전체 보기`는 raw loaded thread dump가 아니라, 저장소 이름과 최근 힌트가 붙은 **식별 가능한 기존 Codex thread**만 보여준다
   - 다른 저장소에 있는 기존 Codex 메인 thread도 attach할 수 있다
3. attach가 끝나면 같은 카드에서 `상태 보기`, `이 채널에 고정`, `작업 지시` 버튼을 바로 쓸 수 있다.
4. 자주 쓰는 채널에서는 `/use-project project:<project-key-or-alias>` 또는 `이 채널에 고정` 버튼으로 기본 프로젝트를 지정한다.
5. 기본 프로젝트가 잡힌 채널에서는 `/status`, `/intent`, `/reply`에서 `project`를 생략할 수 있다.
6. 같은 카드에서 `백그라운드 시작`, `앱 복귀` 버튼으로 foreground/background 모드를 바꿀 수 있다.
   - slash command로는 `/background-on`, `/foreground-on`을 쓴다.
   - background로 바꿔도 `approval 대기`, `must_human_check`, `pending_human_gate`가 있으면 scheduler는 계속 차단된다.
7. 기존 Codex thread도 없고 shared memory 등록 프로젝트도 없을 때만 `/create-project` 또는 `새 프로젝트 등록` 버튼으로 bootstrap한다.
8. `작업 지시` 버튼은 modal을 열고, 입력한 문장은 intent inbox로 기록된다.
9. 채널이 이미 프로젝트에 바인딩되어 있으면 plain text는 먼저 실제 `bridge thread`의 새 turn으로 들어간다.
   - `지금 어디까지 했어?`, `현재 상태 알려줘` 같은 질문은 bridge thread가 shared memory와 최근 note를 읽고 자연어로 답한다.
   - 작업 요청은 bridge thread가 자연어로 확인 응답을 만든 뒤, structured inbox event로 메인에 handoff한다.
   - 즉 표면은 채팅이지만, 내부 실행은 여전히 `Discord -> bridge thread -> shared memory -> main` 규약을 따른다.
   - unbound 채널에서는 bot mention이 있을 때만 도움말을 돌려준다.
10. background/foreground, human gate, processed completion 같은 주요 변화는 Discord 채널에 자동 알림으로 다시 올라온다.
   - 자동 알림도 템플릿 dump가 아니라 bridge thread가 최근 note를 읽고 사람 말로 다시 요약한다.
11. Discord 앱에 Message Content intent가 안 켜져 있으면 adapter는 죽지 않고 `mention/slash-only` degraded mode로 다시 붙는다.
   - 이 경우 slash command, 버튼, mention 메시지는 계속 동작한다.
   - adapter 상태 파일의 `conversation_mode = mention_only`는 고장이 아니라 fallback 상태다.
   - 이 경우 응답 카드에도 `대화 모드: mention_only` 안내가 같이 붙는다.
   - 바인딩된 채널 plain text 대화는 Message Content intent를 켜야 완전하게 동작한다.
   - intent가 꺼진 동안은 `@Remodex Pilot 지금 어디까지 했어?`, `@Remodex Pilot 로그인 테스트부터 진행해`처럼 멘션을 포함해야 한다.

### 3. Dashboard

shared memory를 읽는 관측판은 아래 명령으로 띄울 수 있다.

```bash
node scripts/remodex_dashboard_server.mjs
```

기본 endpoint:

- `/`
- `/health`
- `/api/portfolio`
- `/api/projects/:projectKey`
- `/api/projects/:projectKey/timeline`
- `/api/human-gates`
- `/api/incidents`

## What Gets Committed

- 운영 문서: 전략, 계약, 실행 계획, runbook, bootstrap
- 실제 런타임: bridge daemon, scheduler tick, 공용 runtime library
- 부트스트랩 자산: env example, wrapper, plist renderer, install/uninstall 스크립트
- 검증 요약: `verification/VERIFICATION_LOG.md`

아래는 기본적으로 로컬 생성물로 취급한다.

- `ops/remodex.env`
- `ops/launchd/generated/*.plist`
- `runtime/*`
- `verification/` 원시 산출물 대부분

## Operating Rules

- foreground가 repo와 approval lane의 유일한 결정자다.
- background는 wake와 관측은 할 수 있지만, human gate를 닫으면 안 된다.
- `processed/*` 없이 queue만 비우면 실패다.
- `inflight_delivery.json`을 새 turn보다 먼저 확인해야 한다.
- 같은 `correlation_key`에 second `consumed` 영수증이 생기면 버그다.

## Current State

현재 문서/WBS 기준으로는 전략, 실행 계획, runbook, bootstrap asset까지 모두 작성되어 있다.

- `EP-610 Hardening, Soak, And Runbooks`: 완료
- `EP-710 Production Bootstrap Assets`: 완료
- `EP-810 Dashboard Observability MVP Spec`: 완료
- `EP-820 Dashboard Read Model And UI`: 완료
- `EP-910 Windows Portability Assessment`: 완료
- `EP-920 macOS Resource Safety And Soak Plan`: 완료
- `EP-930 Windows Runtime Adapter`: 완료
- `EP-940 macOS Soak Execution`: 완료 (`30min smoke, 6h churn, graceful shutdown/drain, 24h overnight final verdict까지 pass`)
- `EP-950 Discord Gateway Ingress`: 완료 (`real Discord guild slash command까지 포함한 live ingress proof pass`)

남은 일은 Windows 실제 실행 증거 수집 같은 운영 반영 배치다.
