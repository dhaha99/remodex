import fs from "node:fs/promises";
import path from "node:path";
import { BridgeRuntime } from "../scripts/lib/bridge_runtime.mjs";
import {
  buildProjectPaths,
  writeAtomicJson,
} from "../scripts/lib/shared_memory_runtime.mjs";

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const stackDir = process.env.REMODEX_CHURN_STACK_DIR ?? path.join(workspace, "runtime", "churn");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? process.env.REMODEX_APP_SERVER_WS_URL ?? null;
const maxAttempts = Number.parseInt(process.env.REMODEX_CHURN_SHUTDOWN_DRAIN_ATTEMPTS ?? "8", 10);
const attemptSleepMs = Number.parseInt(process.env.REMODEX_CHURN_SHUTDOWN_DRAIN_SLEEP_MS ?? "1500", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixture = JSON.parse(await fs.readFile(path.join(stackDir, "churn_fixture.json"), "utf8"));
const alphaProjectKey = fixture.projects.alpha.project_key;
const alphaPaths = buildProjectPaths({
  sharedBase,
  workspaceKey,
  projectKey: alphaProjectKey,
});

await writeAtomicJson(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"), {
  background_trigger_enabled: true,
  foreground_lock_enabled: false,
  foreground_session_active: false,
});

const runtime = await BridgeRuntime.forProject({
  sharedBase,
  workspaceKey,
  projectKey: alphaProjectKey,
  wsUrl,
  serviceName: "remodex_churn_shutdown_drain",
  processedBy: "remodex_churn_shutdown_drain",
});

const summary = {
  started_at: new Date().toISOString(),
  project_key: alphaProjectKey,
  attempts: [],
  verdict: "residual_pending",
};

try {
  for (let index = 0; index < maxAttempts; index += 1) {
    const snapshot = await runtime.snapshot();
    const before = {
      coordinator_status:
        snapshot.coordinator_status?.type ??
        snapshot.coordinator_status?.status?.type ??
        snapshot.coordinator_status?.status ??
        "unknown",
      inbox_count: snapshot.counts?.inbox ?? 0,
      dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
      processed_count: snapshot.counts?.processed ?? 0,
      has_inflight: Boolean(snapshot.inflight_delivery),
    };

    if (before.inbox_count === 0 && before.dispatch_queue_count === 0 && !before.has_inflight) {
      summary.verdict = "drained";
      summary.completed_at = new Date().toISOString();
      summary.final = before;
      break;
    }

    let result;
    if (before.dispatch_queue_count > 0) {
      result = await runtime.deliverNextDispatch();
    } else if (before.inbox_count > 0) {
      result = await runtime.deliverNextInbox();
    } else {
      result = { delivery_decision: "wait_for_inflight" };
    }

    summary.attempts.push({
      index,
      before,
      result,
      recorded_at: new Date().toISOString(),
    });
    await sleep(attemptSleepMs);
  }

  if (!summary.completed_at) {
    const snapshot = await runtime.snapshot();
    summary.completed_at = new Date().toISOString();
    summary.final = {
      coordinator_status:
        snapshot.coordinator_status?.type ??
        snapshot.coordinator_status?.status?.type ??
        snapshot.coordinator_status?.status ??
        "unknown",
      inbox_count: snapshot.counts?.inbox ?? 0,
      dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
      processed_count: snapshot.counts?.processed ?? 0,
      has_inflight: Boolean(snapshot.inflight_delivery),
    };
    if (
      summary.final.inbox_count === 0 &&
      summary.final.dispatch_queue_count === 0 &&
      !summary.final.has_inflight
    ) {
      summary.verdict = "drained";
    }
  }
} finally {
  await runtime.close();
}

const outputPath = path.join(stackDir, "shutdown_drain_summary.json");
await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, verdict: summary.verdict }, null, 2));
