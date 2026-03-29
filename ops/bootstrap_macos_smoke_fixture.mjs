import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProjectPaths,
  ensureProjectDirs,
  writeAtomicJson,
  writeProcessedIndexEntries,
} from "../scripts/lib/shared_memory_runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const projectKey = process.env.REMODEX_SMOKE_PROJECT_KEY ?? "project-alpha";

async function resolveThreadId() {
  if (process.env.REMODEX_SMOKE_THREAD_ID) return process.env.REMODEX_SMOKE_THREAD_ID;
  try {
    const summaryPath = path.join(workspace, "verification", "app_server_probe_summary.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    return summary.threadId ?? "smoke-thread-placeholder";
  } catch {
    return "smoke-thread-placeholder";
  }
}

const now = new Date().toISOString();
const threadId = await resolveThreadId();
const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
await ensureProjectDirs(paths);

await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
  workspace_key: workspaceKey,
  project_key: projectKey,
  namespace_ref: paths.root,
  seeded_at: now,
});

await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
  workspace_key: workspaceKey,
  project_key: projectKey,
  threadId,
  bound_at: now,
});

await writeAtomicJson(path.join(paths.stateDir, "coordinator_lease.json"), {
  role: "main_coordinator",
  current_thread_ref: threadId,
  claimed_at: now,
  epoch: 1,
  status: "active",
});

await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
  observed_at: now,
  threadId,
  type: "idle",
  activeFlags: [],
});

await writeAtomicJson(path.join(paths.stateDir, "prompt_contract_binding.json"), {
  contract_path: path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md"),
});

await writeAtomicJson(path.join(paths.stateDir, "strategy_binding.json"), {
  strategy_version: "Shared Working Memory Strategy v2",
  strategy_path: path.join(workspace, "STRATEGY.md"),
});

await writeAtomicJson(path.join(paths.stateDir, "roadmap_status.json"), {
  roadmap_current_point: "10.4.1-smoke",
  updated_at: now,
});

await writeAtomicJson(path.join(paths.stateDir, "autonomy_policy.json"), {
  autonomous_trigger_mode: false,
  mode: "foreground_smoke",
});

await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
  background_trigger_enabled: false,
  foreground_lock_enabled: true,
  foreground_session_active: true,
});

await writeAtomicJson(path.join(paths.stateDir, "stop_conditions.json"), {
  must_human_check: false,
  pending_human_gate: false,
});

await writeAtomicJson(path.join(paths.stateDir, "current_goal.json"), {
  current_goal: "Validate macOS smoke stack health",
});

await writeAtomicJson(path.join(paths.stateDir, "current_plan.json"), {
  current_plan: [
    "bridge health",
    "dashboard health",
    "scheduler blocked or noop",
  ],
});

await writeAtomicJson(path.join(paths.stateDir, "current_focus.json"), {
  current_focus: "smoke-stack-baseline",
});

await writeAtomicJson(path.join(paths.stateDir, "active_owner.json"), {
  active_owner: "foreground-smoke",
});

await writeAtomicJson(path.join(paths.stateDir, "progress_axes.json"), {
  roadmap_current_point: "10.4.1-smoke",
  latest_validated_change: "fixture-seeded",
  next_smallest_batch: "run smoke stack",
  blockers: [],
});

await writeAtomicJson(path.join(paths.stateDir, "deferred_queue.json"), {
  entries: [],
});

await writeAtomicJson(path.join(paths.stateDir, "pending_artifacts.json"), {
  pending_artifacts: [],
});

await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
  status_allow: "operator",
  intent_allow: "operator",
  reply_allow: "operator",
  approval_allow: "ops-admin",
});

await writeProcessedIndexEntries(paths, []);

console.log(JSON.stringify({
  ok: true,
  workspace_key: workspaceKey,
  project_key: projectKey,
  thread_id: threadId,
  root: paths.root,
}, null, 2));
