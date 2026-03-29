# Windows Portability Checklist

이 문서는 현재 Remodex 구현이 Windows에서 어디까지 운영 가능한지, 무엇이 아직 macOS 전용인지, 어떤 순서로 포팅해야 하는지를 정리한 점검표다.

기준일:

- `2026-03-27`

기준 문서:

- [STRATEGY.md](./STRATEGY.md)
- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- [EXECUTION_PLAN.md](./EXECUTION_PLAN.md)
- [WBS.md](./WBS.md)

공식 근거:

- [Codex app for Windows](https://developers.openai.com/codex/app/windows/)
- [Codex app features](https://developers.openai.com/codex/app/features/)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Codex config reference](https://developers.openai.com/codex/config-reference/#configtoml)

## Current Verdict

- `Codex platform on Windows`: 가능
- `current remodex repo as-is on Windows`: 불가
- `required before Windows pilot`: Windows 실행 증거, foreground/background 검증, Windows 검증 suite

즉, 코어 모델인 `app-server + shared memory + bridge + scheduler truth`는 Windows로 가져갈 수 있다.  
하지만 현재 저장소는 `launchd + zsh + Homebrew Node path + macOS path layout` 전제로 묶여 있어서 그대로는 운영할 수 없다.

## What Is Portable

- Node 기반 control plane
  - [scripts/remodex_bridge_daemon.mjs](./scripts/remodex_bridge_daemon.mjs)
  - [scripts/remodex_scheduler_tick.mjs](./scripts/remodex_scheduler_tick.mjs)
  - [scripts/remodex_dashboard_server.mjs](./scripts/remodex_dashboard_server.mjs)
  - [scripts/lib](./scripts/lib)
- shared memory layout과 processed dedupe 계약
- Discord ingress/egress 모델
- app-server thread / turn / approval / status mirror 모델
- read-only dashboard 모델

## What Is Not Portable As-Is

| Area | Current state | Windows requirement | Status |
| --- | --- | --- | --- |
| Scheduler install | `launchd/LaunchAgent` 전용 | Task Scheduler 또는 Windows service 래퍼 | `completed (asset)` |
| Wrapper shell | `zsh` 스크립트 | PowerShell 스크립트 | `completed (asset)` |
| Node path | `/opt/homebrew/bin/node` 기본값 | `where.exe node` 또는 env 기반 해석 | `completed (env/default)` |
| Workspace path | `/Users/mymac/...` 기본값 | `%USERPROFILE%` / project-relative / env 기반 해석 | `completed (env/default)` |
| Bootstrap artifact | `.plist` 생성 | `schtasks` XML 또는 PowerShell 등록 스크립트 | `completed (asset)` |
| Runtime inspection | `launchctl` 기반 | `Get-ScheduledTask`, `schtasks`, Windows Event/Process 확인 | `pending` |
| Probe suite | 다수 `launchd` 전제 | Windows-native probe 세트 | `pending` |
| Docs | macOS 운영 절차 중심 | Windows 운영 절차 별도 문서 | `completed (pilot prep)` |

## Current macOS-Specific Anchors In Repo

아래는 현재 Windows 포팅을 막는 대표 파일들이다.

- [ops/install_launchd_services.sh](./ops/install_launchd_services.sh)
- [ops/uninstall_launchd_services.sh](./ops/uninstall_launchd_services.sh)
- [ops/run_bridge_daemon.sh](./ops/run_bridge_daemon.sh)
- [ops/run_scheduler_tick.sh](./ops/run_scheduler_tick.sh)
- [ops/render_launchd_plists.mjs](./ops/render_launchd_plists.mjs)
- [ops/remodex.env.example](./ops/remodex.env.example)
- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)

반대로 아래 런타임은 이제 project-relative/env 기본값으로 정규화돼 있다.

- [scripts/remodex_bridge_daemon.mjs](./scripts/remodex_bridge_daemon.mjs)
- [scripts/remodex_scheduler_tick.mjs](./scripts/remodex_scheduler_tick.mjs)
- [scripts/remodex_dashboard_server.mjs](./scripts/remodex_dashboard_server.mjs)
- [ops/lib/scheduler_adapter.mjs](./ops/lib/scheduler_adapter.mjs)

## Porting Principles

1. portable core와 OS adapter를 분리한다.
2. shared memory truth를 바꾸지 않는다.
3. `launchd`, `zsh`, `/opt/homebrew/bin/node`, `/Users/...`는 canonical contract가 아니다.
4. Windows 지원은 문서 선언이 아니라 `Windows probe evidence`가 있어야 인정한다.
5. macOS bootstrap을 깨지 않고 Windows bootstrap을 병행 추가한다.

## Required Work Packages

### 1. Path And Env Normalization

- 모든 런타임 entrypoint에서 절대 macOS 기본 경로를 제거
- 기본값은 env 또는 `process.cwd()`/config로 재해석
- Node binary와 workspace path를 OS별 resolver로 분리

완료 기준:

- macOS 경로가 코드 기본값에 남지 않음
- Windows 경로를 env만으로 주입 가능

### 2. Scheduler Adapter Abstraction

- scheduler interface를 `launchd`와 분리
- Windows에서는 Task Scheduler 등록/삭제/상태 확인 경로 제공
- blocked/wake/duplicate rules는 그대로 유지

완료 기준:

- macOS와 Windows가 같은 scheduler truth를 읽음
- OS별 등록 수단만 다르고 decision payload는 동일

### 3. PowerShell Wrapper Set

- `run_bridge_daemon`
- `run_scheduler_tick`
- install/uninstall helper
- env bootstrap

완료 기준:

- PowerShell만으로 bootstrap 가능
- execution policy 관련 주의사항 문서화

### 4. Windows Probe Suite

최소 검증:

- app-server thread start/resume
- signed Discord ingress -> inbox
- scheduler blocked/wake 분기
- foreground takeover
- human gate fail-closed
- processed dedupe

완료 기준:

- macOS 핵심 probe와 동등한 Windows evidence 확보

### 5. Windows Operations Manual

문서 필요:

- 설치 전제
- 방화벽/loopback 포트
- Task Scheduler 등록/해제
- foreground/background 전환
- 장애 복구

## Go / No-Go For Windows Pilot

### Go

- path/env normalization 완료
- Windows scheduler adapter 구현 완료
- PowerShell wrapper 배치 완료
- 핵심 Windows probe 통과
- dashboard/bridge/scheduler가 loopback 바인딩만 사용

### No-Go

- `launchd` 전제를 유지한 채 포팅했다고 주장
- PowerShell wrapper 없이 수동 명령 조합만 제공
- Windows evidence 없이 “운영 가능”으로 문서화
- foreground/background arbitration이 Windows에서 재검증되지 않음

## Recommended Next Smallest Batch

1. `runtime path normalization`
2. `scheduler adapter interface`
3. `PowerShell bootstrap wrappers`
4. `Windows probe 1: app-server + scheduler blocked/wake`

## Status

- assessment 문서화: `completed`
- scheduler adapter abstraction: `completed`
- Windows bootstrap asset layer: `completed`
- actual Windows probe evidence: `pending`
