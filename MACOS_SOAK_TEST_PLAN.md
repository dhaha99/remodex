# macOS 24h Soak Test Plan

이 문서는 Remodex를 macOS에서 장시간 운영할 때 메모리, CPU, 포트, 로그, 중복 실행, orphan process 문제가 없는지 확인하기 위한 soak 계획이다.

기준일:

- `2026-03-27`

연결 문서:

- [STRATEGY.md](./STRATEGY.md)
- [PRODUCTION_BOOTSTRAP.md](./PRODUCTION_BOOTSTRAP.md)
- [NORMAL_OPS_MANUAL.md](./NORMAL_OPS_MANUAL.md)
- [INCIDENT_RECOVERY_RUNBOOK.md](./INCIDENT_RECOVERY_RUNBOOK.md)
- [verification/VERIFICATION_LOG.md](./verification/VERIFICATION_LOG.md)

## Goal

아래 두 질문에 답하기 위한 계획이다.

1. Remodex 제어면이 장시간 떠 있어도 메모리/CPU/디스크 사용이 비정상적으로 증가하지 않는가
2. foreground/background/human gate/recovery 경계가 장시간 churn에서도 깨지지 않는가

## Scope

대상 프로세스:

- Codex app
- `codex app-server`
- `remodex_bridge_daemon`
- `remodex_scheduler_tick`
- `remodex_dashboard_server`

대상 truth:

- `runtime/external-shared-memory/**`
- `runtime/launchd/**`
- `processed/*`
- `dispatch_queue/*`
- `human_gate_candidates/*`
- `router/outbox/*`

## Non-Goals

- Windows soak
- public internet exposure 성능 테스트
- 대규모 다중 사용자 부하 테스트
- app-server 내부 메모리 최적화 자체 수정

## Test Phases

### Phase S1: 30min Smoke

목적:

- launchd 등록, bridge, scheduler, dashboard가 동시에 떠도 즉시 문제 없는지 확인

시나리오:

- idle project 1개
- dashboard polling
- lightweight Discord/status ingress
- scheduler periodic tick

### Phase S2: 6h Churn

목적:

- foreground/background 전환, operator ingress, human gate가 반복돼도 누수/중복이 없는지 확인

시나리오:

- project 2개
- Discord ingress churn
- foreground takeover
- pending approval
- recovery replay

### Phase S3: 24h Overnight

목적:

- 실제 야간 운영과 유사한 안정성 확인

시나리오:

- project 2~3개
- background trigger on/off 전환 포함
- at least 1 human gate stop
- dashboard read-only polling 유지
- app-server reconnect 1회 이상 허용

## Metrics To Capture

### Process Metrics

- RSS
- `%CPU`
- elapsed time
- process count
- orphan child count

macOS 수집 예시:

```bash
ps -axo pid,ppid,rss,%cpu,etime,command | rg 'Codex|codex app-server|remodex_'
```

### Port And Handle Metrics

- bridge HTTP listen
- dashboard HTTP listen
- app-server WS listen
- 비의도 포트 listen 여부

수집 예시:

```bash
lsof -nP -iTCP -sTCP:LISTEN | rg '8787|8790|4517|Codex|node'
```

### Disk And Log Metrics

- `runtime/` 크기
- `runtime/launchd/*.log` 증가량
- processed receipt 수
- inflight claim 잔존 여부

수집 예시:

```bash
du -sh runtime
find runtime -type f | wc -l
```

### Functional Integrity Metrics

- duplicate replay 수
- `skipped_duplicate` 기록 수
- human gate candidate backlog
- dispatch queue backlog
- blocked reason 분포

## Acceptance Thresholds

아래는 1차 운영 기준이다.

- bridge daemon RSS가 초기 기준 대비 지속적으로 단조 증가하지 않을 것
- dashboard RSS가 steady state 이후 크게 누적 증가하지 않을 것
- scheduler tick은 상주하지 않고 주기 실행 후 종료될 것
- orphan process가 남지 않을 것
- listen 포트가 loopback 이외 주소로 열리지 않을 것
- `processed` 없이 같은 `correlation_key` 재실행이 발생하지 않을 것
- `human_gate_candidates`를 background가 소비하지 않을 것
- foreground active 동안 scheduler decision이 `blocked`를 유지할 것

## Hard Failure Conditions

아래 중 하나면 soak 실패다.

- bridge/dashboard RSS가 계속 우상향하고 회복되지 않음
- scheduler tick 프로세스가 누적 잔존함
- loopback 외 주소 bind 발생
- 같은 `correlation_key`가 실제로 두 번 실행됨
- background가 human gate candidate를 소비함
- foreground active인데 background delivery가 발생함
- inflight claim이 종료 후에도 계속 남아 recovery를 방해함

## Test Matrix

| Scenario | Required | Evidence |
| --- | --- | --- |
| Idle + dashboard polling | yes | RSS/CPU baseline |
| Discord status churn | yes | outbox / ingress logs |
| Intent delivery churn | yes | processed receipts |
| Foreground takeover | yes | scheduler `blocked` evidence |
| Human gate stop | yes | candidate backlog + no background consume |
| Recovery replay | yes | `skipped_duplicate` evidence |
| Dashboard concurrent reads | yes | server healthy + no state mutation |

## Data Collection Artifacts

남겨야 하는 산출물:

- `runtime/metrics/ps-snapshots/*.txt`
- `runtime/metrics/ports/*.txt`
- `runtime/metrics/disk/*.txt`
- `runtime/metrics/summary.json`
- `runtime/metrics/failures.json`

최종 요약에는 아래가 있어야 한다.

- baseline RSS/CPU
- peak RSS/CPU
- process count timeline
- blocked reason summary
- human gate count
- duplicate prevention summary
- final verdict

## Safety Controls During Soak

- dashboard는 read-only로만 사용
- bridge/dashboard는 loopback bind만 허용
- foreground 작업 중에는 background trigger를 끈다
- destructive workflow는 soak 대상에서 제외
- 필요하면 app setting의 `Prevent sleep while running`을 켠다

## Exit Decision

### Pass

- 24시간 동안 hard failure 없음
- steady-state 자원 사용이 허용 범위 안
- duplicate replay 없음
- foreground/background 경계 유지

### Conditional Pass

- 기능 경계는 유지됐지만 로그 증가나 RSS 증가가 임계치 근처
- 운영 진입 전 log rotation, restart cadence, metrics 보강 필요

### Fail

- duplicate replay
- background human gate consume
- foreground arbitration 파손
- 장시간 자원 증가가 지속

## Current Status

- 계획 문서화: `completed`
- metrics collector / smoke runner / stack harness bootstrap: `completed`
- 1s host stack probe: `completed`
- 30min smoke 실행: `completed`
- short churn harness + host probe: `completed`
- 6h churn 실행: `completed`
- graceful shutdown/drain prep: `completed`
- 24h overnight 실행: `completed`
- 24h runtime checkpoint: `completed`
- 24h overnight final verdict collection: `completed`

### Active Runtime Paths

- stack dir: `/tmp/remodex-churn-24h-runtime`
- metrics dir: `/tmp/remodex-churn-24h-metrics`
- shared base: `/tmp/remodex-churn-24h-fixture`
- bridge port: `8801`
- dashboard port: `8802`

### Final Cleanliness Rule

- churn run의 마지막 청결성은 `latest portfolio snapshot`만으로 판정하지 않는다.
- 종료 직후 생성되는 `shutdown_drain_summary.json`이 있으면 그 값을 우선 truth로 사용한다.
- `shutdown_drain_summary.final.inbox_count = 0`, `dispatch_queue_count = 0`, `has_inflight = false`가 최종 pass 조건이다.

## Recommended Next Smallest Batch

1. `EP-950 live credential preflight`
2. `EP-950 end-to-end Discord live ingress proof`
