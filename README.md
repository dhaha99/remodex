# Remodex

Remodex는 Codex app-server, shared memory, Discord operator ingress, scheduler tick을 조합해 `프로젝트별 메인 thread`를 안전하게 이어서 운영하는 실험/운영용 제어면이다.

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
  - Discord/operator ingress, status 응답, human gate candidate 기록
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
- 평시 운영: [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
- 장애/복구: [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)
- 실운영 bootstrap: [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- 검증 로그: [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)

## What Is Implemented

- project-scoped namespace / coordinator binding / status mirror
- `status`, `intent`, `reply`, `approve-candidate` operator ingress
- dispatch queue arbitration
- foreground/background toggle
- human gate candidate / foreground-only closure
- processed receipt / processed correlation dedupe
- inflight recovery / overload backoff
- long-run scheduler churn 검증
- long-run operator ingress churn 검증
- launchd bootstrap assets

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
├── ops/
│   ├── remodex.env.example
│   ├── run_bridge_daemon.sh
│   ├── run_scheduler_tick.sh
│   ├── render_launchd_plists.mjs
│   ├── install_launchd_services.sh
│   └── uninstall_launchd_services.sh
├── scripts/
│   ├── remodex_bridge_daemon.mjs
│   ├── remodex_scheduler_tick.mjs
│   ├── lib/
│   └── probe_*.mjs
├── runtime/
└── verification/
```

## Quick Start

### 1. Local validation

app-server가 이미 `ws://127.0.0.1:4517`에서 떠 있다는 전제라면, probe로 핵심 경로를 다시 확인할 수 있다.

```bash
node scripts/probe_discord_operator_ingress_churn.mjs
```

핵심 검증 결과는 [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)에 누적돼 있다.

### 2. Production bootstrap

1. [ops/remodex.env.example](./ops/remodex.env.example)를 `ops/remodex.env`로 복사
2. Discord public key, app-server WS URL, shared base 설정
3. launchd plist 생성

```bash
node ops/render_launchd_plists.mjs
```

생성 결과:

- `ops/launchd/generated/com.remodex.bridge-daemon.plist`
- `ops/launchd/generated/com.remodex.scheduler-tick.plist`

자세한 순서는 [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)를 따른다.

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

남은 일은 새 전략 변경, 실운영 launchd 등록, 실제 Discord/operator 환경 연결 같은 운영 반영 배치다.
