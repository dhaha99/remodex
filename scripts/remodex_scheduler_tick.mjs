import path from "node:path";
import { BridgeRuntime } from "./lib/bridge_runtime.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  listProjectKeys,
  summarizeSnapshot,
  writeAtomicJson,
} from "./lib/shared_memory_runtime.mjs";

const workspace = process.env.REMODEX_WORKSPACE ?? "/Users/mymac/my dev/remodex";
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? process.env.REMODEX_APP_SERVER_WS_URL ?? null;
const onlyProjectKey = process.env.REMODEX_PROJECT_KEY ?? null;
const eventsLogPath =
  process.env.REMODEX_SCHEDULER_EVENTS_LOG_PATH ??
  path.join(sharedBase, workspaceKey, "router", "scheduler_tick_events.jsonl");

function currentStatus(snapshot) {
  return (
    snapshot.coordinator_status?.type ??
    snapshot.coordinator_status?.status?.type ??
    snapshot.coordinator_status?.status ??
    "offline_or_no_lease"
  );
}

function blockedDecision(projectKey, reasons, snapshot) {
  return {
    project_key: projectKey,
    decision: "blocked",
    reasons,
    summary: summarizeSnapshot(
      buildProjectPaths({ sharedBase, workspaceKey, projectKey }),
      snapshot,
    ),
    recorded_at: new Date().toISOString(),
  };
}

async function processProject(projectKey) {
  const runtime = await BridgeRuntime.forProject({
    sharedBase,
    workspaceKey,
    projectKey,
    wsUrl,
    logPath: eventsLogPath,
    serviceName: "remodex_scheduler_tick",
    processedBy: "remodex_scheduler_tick",
  });

  try {
    const snapshot = await runtime.snapshot();
    const status = currentStatus(snapshot);
    const toggle = snapshot.background_trigger_toggle ?? {};
    const reasons = [];

    if (!snapshot.coordinator_binding?.threadId && !snapshot.coordinator_lease?.current_thread_ref) {
      reasons.push("missing_binding");
    }
    if (snapshot.stop_conditions?.must_human_check) {
      reasons.push("must_human_check");
    }
    if ((snapshot.counts?.human_gate_candidates ?? 0) > 0) {
      reasons.push("pending_human_gate");
    }
    if (toggle.background_trigger_enabled === false) {
      reasons.push("background_trigger_disabled");
    }
    if (toggle.foreground_session_active) {
      reasons.push("foreground_session_active");
    }
    if (!["idle", "checkpoint_open"].includes(status)) {
      reasons.push(`status_${status}`);
    }

    let result;
    if (reasons.length > 0) {
      result = blockedDecision(projectKey, reasons, snapshot);
    } else if ((snapshot.counts?.dispatch_queue ?? 0) > 0) {
      result = {
        project_key: projectKey,
        decision: "dispatch_queue",
        recorded_at: new Date().toISOString(),
        result: await runtime.deliverNextDispatch(),
      };
    } else if ((snapshot.counts?.inbox ?? 0) > 0) {
      result = {
        project_key: projectKey,
        decision: "inbox",
        recorded_at: new Date().toISOString(),
        result: await runtime.deliverNextInbox(),
      };
    } else {
      result = {
        project_key: projectKey,
        decision: "noop",
        reasons: ["no_pending_work"],
        summary: summarizeSnapshot(runtime.paths, snapshot),
        recorded_at: new Date().toISOString(),
      };
    }

    await ensureProjectDirs(runtime.paths);
    const runtimeStatePath = path.join(runtime.paths.runtimeDir, "scheduler_runtime.json");
    await writeAtomicJson(runtimeStatePath, result);
    return result;
  } finally {
    await runtime.close();
  }
}

const projectKeys = onlyProjectKey
  ? [onlyProjectKey]
  : await listProjectKeys(sharedBase, workspaceKey);

const results = [];
for (const projectKey of projectKeys) {
  results.push(await processProject(projectKey));
}

console.log(JSON.stringify({
  workspace_key: workspaceKey,
  project_count: results.length,
  results,
}, null, 2));
