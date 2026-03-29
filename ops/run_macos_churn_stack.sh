#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

: "${REMODEX_WORKSPACE:=$WORKSPACE_DIR}"
: "${REMODEX_SHARED_BASE:=/tmp/remodex-churn-shared}"
: "${REMODEX_WORKSPACE_KEY:=remodex}"
: "${REMODEX_NODE_BIN:=node}"
: "${REMODEX_METRICS_DIR:=/tmp/remodex-churn-metrics}"
: "${REMODEX_CHURN_STACK_DIR:=/tmp/remodex-churn-runtime}"
: "${REMODEX_CHURN_DURATION_SECONDS:=600}"
: "${REMODEX_CHURN_INTERVAL_SECONDS:=60}"
: "${REMODEX_OPERATOR_HTTP_HOST:=127.0.0.1}"
: "${REMODEX_OPERATOR_HTTP_PORT:=8788}"
: "${REMODEX_DASHBOARD_HTTP_HOST:=127.0.0.1}"
: "${REMODEX_DASHBOARD_HTTP_PORT:=8791}"

mkdir -p "$REMODEX_CHURN_STACK_DIR" "$REMODEX_METRICS_DIR"

export REMODEX_WORKSPACE
export REMODEX_SHARED_BASE
export REMODEX_WORKSPACE_KEY
export REMODEX_METRICS_DIR
export REMODEX_NODE_BIN
export REMODEX_OPERATOR_HTTP_HOST
export REMODEX_OPERATOR_HTTP_PORT
export REMODEX_DASHBOARD_HTTP_HOST
export REMODEX_DASHBOARD_HTTP_PORT
export REMODEX_CHURN_STACK_DIR

"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/bootstrap_macos_churn_fixture.mjs" \
  > "$REMODEX_CHURN_STACK_DIR/fixture-bootstrap.json"

export REMODEX_DISCORD_PUBLIC_KEY_PATH="$REMODEX_CHURN_STACK_DIR/discord-public.pem"

zsh "$SCRIPT_DIR/run_bridge_daemon.sh" \
  > "$REMODEX_CHURN_STACK_DIR/bridge.stdout.log" \
  2> "$REMODEX_CHURN_STACK_DIR/bridge.stderr.log" &
BRIDGE_PID=$!

zsh "$SCRIPT_DIR/run_dashboard_server.sh" \
  > "$REMODEX_CHURN_STACK_DIR/dashboard.stdout.log" \
  2> "$REMODEX_CHURN_STACK_DIR/dashboard.stderr.log" &
DASHBOARD_PID=$!

cleanup() {
  kill "$BRIDGE_PID" "$DASHBOARD_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

sleep 2

START_ISO=$(date -Iseconds)
end_epoch=$(( $(date +%s) + REMODEX_CHURN_DURATION_SECONDS ))
sample_count=0

while (( $(date +%s) <= end_epoch )); do
  TS=$(date +%Y%m%dT%H%M%S)
  "$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/run_macos_churn_driver.mjs" \
    > "$REMODEX_CHURN_STACK_DIR/driver-$TS.json" \
    2> "$REMODEX_CHURN_STACK_DIR/driver-$TS.stderr.log" || true
  zsh "$SCRIPT_DIR/collect_macos_runtime_metrics.sh" "$TS" >/dev/null
  curl -sS "http://${REMODEX_OPERATOR_HTTP_HOST}:${REMODEX_OPERATOR_HTTP_PORT}/health" \
    > "$REMODEX_CHURN_STACK_DIR/bridge-health-$TS.json" || true
  curl -sS "http://${REMODEX_DASHBOARD_HTTP_HOST}:${REMODEX_DASHBOARD_HTTP_PORT}/health" \
    > "$REMODEX_CHURN_STACK_DIR/dashboard-health-$TS.json" || true
  curl -sS "http://${REMODEX_DASHBOARD_HTTP_HOST}:${REMODEX_DASHBOARD_HTTP_PORT}/api/portfolio" \
    > "$REMODEX_CHURN_STACK_DIR/portfolio-$TS.json" || true
  zsh "$SCRIPT_DIR/run_scheduler_tick.sh" \
    > "$REMODEX_CHURN_STACK_DIR/scheduler-$TS.json" \
    2> "$REMODEX_CHURN_STACK_DIR/scheduler-$TS.stderr.log" || true
  sample_count=$((sample_count + 1))
  sleep "$REMODEX_CHURN_INTERVAL_SECONDS"
done

END_ISO=$(date -Iseconds)

"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/drain_macos_churn_shutdown.mjs" \
  > "$REMODEX_CHURN_STACK_DIR/shutdown-drain.stdout.json" \
  2> "$REMODEX_CHURN_STACK_DIR/shutdown-drain.stderr.log" || true

cat > "$REMODEX_CHURN_STACK_DIR/summary.json" <<EOF
{
  "mode": "macos_churn_stack",
  "started_at": "$START_ISO",
  "completed_at": "$END_ISO",
  "duration_seconds": $REMODEX_CHURN_DURATION_SECONDS,
  "interval_seconds": $REMODEX_CHURN_INTERVAL_SECONDS,
  "sample_count": $sample_count,
  "stack_dir": "$REMODEX_CHURN_STACK_DIR",
  "metrics_dir": "$REMODEX_METRICS_DIR",
  "status": "completed"
}
EOF

"$REMODEX_NODE_BIN" "$REMODEX_WORKSPACE/ops/summarize_macos_churn_stack.mjs" \
  > "$REMODEX_CHURN_STACK_DIR/verdict.stdout.json"

echo "$REMODEX_CHURN_STACK_DIR/summary.json"
