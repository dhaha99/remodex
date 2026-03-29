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
: "${REMODEX_METRICS_DIR:=$REMODEX_WORKSPACE/runtime/metrics}"
: "${REMODEX_SMOKE_DURATION_SECONDS:=1800}"
: "${REMODEX_SMOKE_INTERVAL_SECONDS:=60}"

export REMODEX_WORKSPACE
export REMODEX_METRICS_DIR

mkdir -p "$REMODEX_METRICS_DIR"

START_TS=$(date +%Y%m%dT%H%M%S)
START_ISO=$(date -Iseconds)
SUMMARY_FILE="$REMODEX_METRICS_DIR/summary.json"

sample_count=0
end_epoch=$(( $(date +%s) + REMODEX_SMOKE_DURATION_SECONDS ))

while (( $(date +%s) <= end_epoch )); do
  zsh "$SCRIPT_DIR/collect_macos_runtime_metrics.sh" >/dev/null
  sample_count=$((sample_count + 1))
  sleep "$REMODEX_SMOKE_INTERVAL_SECONDS"
done

END_ISO=$(date -Iseconds)

cat > "$SUMMARY_FILE" <<EOF
{
  "mode": "macos_smoke",
  "started_at": "$START_ISO",
  "completed_at": "$END_ISO",
  "duration_seconds": $REMODEX_SMOKE_DURATION_SECONDS,
  "interval_seconds": $REMODEX_SMOKE_INTERVAL_SECONDS,
  "sample_count": $sample_count,
  "metrics_dir": "$REMODEX_METRICS_DIR",
  "status": "completed"
}
EOF

echo "$SUMMARY_FILE"
