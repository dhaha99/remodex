import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeRuntime } from "./lib/bridge_runtime.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  listProjectKeys,
  summarizeSnapshot,
  writeAtomicJson,
} from "./lib/shared_memory_runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const wsUrl =
  process.env.CODEX_APP_SERVER_WS_URL ??
  process.env.REMODEX_APP_SERVER_WS_URL ??
  "ws://127.0.0.1:4517";
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

function attachedExistingThreadNeedsWake(snapshot, status = currentStatus(snapshot)) {
  return (
    snapshot?.project_identity?.source_kind === "codex_thread_attach" &&
    Boolean(snapshot?.project_identity?.attached_thread_id ?? snapshot?.coordinator_binding?.threadId) &&
    status === "notLoaded"
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

function classifySchedulerError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("websocket connect failed")) {
    return {
      reason: "app_server_unreachable",
      error_message: message,
    };
  }
  return {
    reason: "scheduler_runtime_error",
    error_message: message,
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
    let snapshot = await runtime.snapshot();
    const effectiveStatus = await runtime.resolveEffectiveCoordinatorStatus(snapshot);
    snapshot = effectiveStatus.snapshot;
    const status = effectiveStatus.status;
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
    if (!["idle", "checkpoint_open"].includes(status) && !attachedExistingThreadNeedsWake(snapshot, status)) {
      reasons.push(`status_${status}`);
    }

    let result;
    try {
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
      } else if (attachedExistingThreadNeedsWake(snapshot, status)) {
        result = {
          project_key: projectKey,
          decision: "attached_thread_wake",
          recorded_at: new Date().toISOString(),
          result: await runtime.wakeAttachedCoordinator(),
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
    } catch (error) {
      const classified = classifySchedulerError(error);
      const freshSnapshot = await runtime.snapshot().catch(() => snapshot);
      result = {
        project_key: projectKey,
        decision: "blocked",
        reasons: [classified.reason],
        error_message: classified.error_message,
        summary: summarizeSnapshot(runtime.paths, freshSnapshot),
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

async function main() {
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
