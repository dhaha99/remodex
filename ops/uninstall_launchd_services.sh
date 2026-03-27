#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname "$0")" && pwd)
WORKSPACE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${REMODEX_ENV_FILE:-$WORKSPACE_DIR/ops/remodex.env}"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

LABEL_PREFIX="${REMODEX_LAUNCHD_LABEL_PREFIX:-com.remodex}"

echo "Bootout bridge daemon if loaded:"
echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.bridge-daemon.plist\""
echo "Bootout scheduler tick if loaded:"
echo "launchctl bootout gui/$(id -u) \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.scheduler-tick.plist\""
echo "Remove copied plists:"
echo "rm -f \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.bridge-daemon.plist\" \"$LAUNCH_AGENTS_DIR/${LABEL_PREFIX}.scheduler-tick.plist\""

