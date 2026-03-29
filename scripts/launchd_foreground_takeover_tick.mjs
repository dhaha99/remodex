import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const stateDir = path.join(verificationDir, "launchd_foreground_takeover_state");
const runtimeDir = path.join(stateDir, "runtime");
const tickEventsPath = path.join(stateDir, "tick_events.jsonl");
const heartbeatPath = path.join(stateDir, "heartbeat.txt");
const togglePath = path.join(runtimeDir, "background_trigger_toggle.json");
const statusPath = path.join(runtimeDir, "coordinator_status.json");
const runtimeStatePath = path.join(runtimeDir, "scheduler_runtime.json");
const wakeEventPath = path.join(runtimeDir, "wake_event.json");

await fs.mkdir(runtimeDir, { recursive: true });

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function evaluateGate(toggle, status) {
  const blockedReasons = [];
  if (!toggle.background_trigger_enabled) blockedReasons.push("background_trigger_disabled");
  if (toggle.foreground_session_active) blockedReasons.push("foreground_session_active");
  if (!["idle", "checkpoint_open"].includes(status.type)) blockedReasons.push(`status_${status.type}`);
  return {
    shouldWake: blockedReasons.length === 0,
    blockedReasons,
  };
}

const toggle = await readJsonIfExists(togglePath, {
  background_trigger_enabled: false,
  foreground_session_active: true,
  foreground_lock_enabled: true,
  mode: "foreground",
});
const status = await readJsonIfExists(statusPath, {
  type: "offline_or_no_lease",
});
const previousRuntime = await readJsonIfExists(runtimeStatePath, {});
const tickCount = Number(previousRuntime.tick_count ?? 0) + 1;
const tickAt = new Date().toISOString();
const gate = evaluateGate(toggle, status);

const runtimeState = {
  scheduler_kind: "launchd_launchagent",
  scheduler_installed: true,
  scheduler_active: true,
  tick_count: tickCount,
  last_tick_at: tickAt,
  last_decision: gate.shouldWake ? "wake" : "blocked",
  last_blocked_reasons: gate.blockedReasons,
  last_toggle_snapshot: toggle,
  last_status_snapshot: status,
};

if (gate.shouldWake) {
  await fs.writeFile(
    wakeEventPath,
    `${JSON.stringify(
      {
        type: "scheduled_wake",
        source: "launchd_foreground_takeover_probe",
        tick_count: tickCount,
        created_at: tickAt,
      },
      null,
      2,
    )}\n`,
  );
  runtimeState.last_wake_event_path = wakeEventPath;
  runtimeState.last_wake_event_at = tickAt;
}

await fs.writeFile(runtimeStatePath, `${JSON.stringify(runtimeState, null, 2)}\n`);
await fs.writeFile(heartbeatPath, `${tickCount}\n${tickAt}\n`);
await fs.appendFile(
  tickEventsPath,
  `${JSON.stringify({
    tick_count: tickCount,
    tick_at: tickAt,
    decision: runtimeState.last_decision,
    blocked_reasons: gate.blockedReasons,
  })}\n`,
);
