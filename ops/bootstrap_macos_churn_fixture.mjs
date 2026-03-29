import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcWsClient } from "../scripts/lib/app_server_jsonrpc.mjs";
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
const alphaProjectKey = process.env.REMODEX_CHURN_ALPHA_PROJECT_KEY ?? "project-alpha";
const betaProjectKey = process.env.REMODEX_CHURN_BETA_PROJECT_KEY ?? "project-beta";
const stackDir = process.env.REMODEX_CHURN_STACK_DIR ?? path.join(workspace, "runtime", "churn");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? process.env.REMODEX_APP_SERVER_WS_URL ?? null;

const now = new Date().toISOString();

async function createLiveThreadId() {
  if (!wsUrl) return null;
  const client = new JsonRpcWsClient(wsUrl, null);
  try {
    await client.connect();
    await client.initialize("remodex_churn_fixture");
    const result = await client.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "remodex_churn_fixture",
    });
    return result?.thread?.id ?? null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

async function resolveAlphaThreadId() {
  if (process.env.REMODEX_CHURN_THREAD_ID_ALPHA) return process.env.REMODEX_CHURN_THREAD_ID_ALPHA;
  const liveThreadId = await createLiveThreadId();
  if (liveThreadId) return liveThreadId;
  try {
    const summaryPath = path.join(workspace, "verification", "app_server_probe_summary.json");
    const summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    return summary.threadId ?? "churn-thread-placeholder-alpha";
  } catch {
    return "churn-thread-placeholder-alpha";
  }
}

async function seedProject(paths, record) {
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: record.projectKey,
    namespace_ref: paths.root,
    seeded_at: now,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: workspaceKey,
    project_key: record.projectKey,
    threadId: record.threadId,
    bound_at: now,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_lease.json"), {
    role: "main_coordinator",
    current_thread_ref: record.threadId,
    claimed_at: now,
    epoch: 1,
    status: "active",
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), record.coordinatorStatus);
  await writeAtomicJson(path.join(paths.stateDir, "prompt_contract_binding.json"), {
    contract_path: path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md"),
  });
  await writeAtomicJson(path.join(paths.stateDir, "strategy_binding.json"), {
    strategy_version: "Shared Working Memory Strategy v2",
    strategy_path: path.join(workspace, "STRATEGY.md"),
  });
  await writeAtomicJson(path.join(paths.stateDir, "roadmap_status.json"), {
    roadmap_current_point: "10.4.2-churn",
    updated_at: now,
  });
  await writeAtomicJson(path.join(paths.stateDir, "autonomy_policy.json"), {
    autonomous_trigger_mode: true,
    mode: "background_churn",
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), record.backgroundToggle);
  await writeAtomicJson(path.join(paths.stateDir, "stop_conditions.json"), record.stopConditions);
  await writeAtomicJson(path.join(paths.stateDir, "current_goal.json"), {
    current_goal: record.goal,
  });
  await writeAtomicJson(path.join(paths.stateDir, "current_plan.json"), {
    current_plan: record.plan,
  });
  await writeAtomicJson(path.join(paths.stateDir, "current_focus.json"), {
    current_focus: record.focus,
  });
  await writeAtomicJson(path.join(paths.stateDir, "active_owner.json"), {
    active_owner: record.activeOwner,
  });
  await writeAtomicJson(path.join(paths.stateDir, "progress_axes.json"), record.progressAxes);
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
}

await fs.mkdir(stackDir, { recursive: true });

const alphaThreadId = await resolveAlphaThreadId();
const betaThreadId = process.env.REMODEX_CHURN_THREAD_ID_BETA ?? "churn-thread-placeholder-beta";
const alphaPaths = buildProjectPaths({ sharedBase, workspaceKey, projectKey: alphaProjectKey });
const betaPaths = buildProjectPaths({ sharedBase, workspaceKey, projectKey: betaProjectKey });

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPath = path.join(stackDir, "discord-public.pem");
const privateKeyPath = path.join(stackDir, "discord-private.pem");
await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));
await fs.writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

const alphaTargetPath = path.join(stackDir, "targets", "alpha-delivery.txt");
await fs.mkdir(path.dirname(alphaTargetPath), { recursive: true });
await fs.rm(alphaTargetPath, { force: true });

await seedProject(alphaPaths, {
  projectKey: alphaProjectKey,
  threadId: alphaThreadId,
  coordinatorStatus: {
    observed_at: now,
    threadId: alphaThreadId,
    type: "idle",
    activeFlags: [],
  },
  backgroundToggle: {
    background_trigger_enabled: true,
    foreground_lock_enabled: false,
    foreground_session_active: false,
  },
  stopConditions: {
    must_human_check: false,
    pending_human_gate: false,
  },
  goal: "Run alpha churn delivery path under repeated mode switching",
  plan: [
    "foreground defer",
    "background delivery",
    "status polling",
  ],
  focus: "alpha-churn-delivery",
  activeOwner: "background-alpha",
  progressAxes: {
    roadmap_current_point: "10.4.2-alpha",
    latest_validated_change: "fixture-seeded",
    next_smallest_batch: "ingress churn",
    blockers: [],
  },
});

const betaApprovalSource = process.env.REMODEX_CHURN_BETA_APPROVAL_SOURCE ?? "beta-approval-source";
await seedProject(betaPaths, {
  projectKey: betaProjectKey,
  threadId: betaThreadId,
  coordinatorStatus: {
    observed_at: now,
    threadId: betaThreadId,
    type: "waiting_on_approval",
    active_approval_source_ref: betaApprovalSource,
    last_approval_method: "item/fileChange/requestApproval",
  },
  backgroundToggle: {
    background_trigger_enabled: true,
    foreground_lock_enabled: false,
    foreground_session_active: false,
  },
  stopConditions: {
    must_human_check: false,
    pending_human_gate: false,
  },
  goal: "Keep beta in approval lane and verify background fail-closed behavior",
  plan: [
    "approval candidate ingress",
    "background blocked",
    "human gate preserved",
  ],
  focus: "beta-human-gate-preserved",
  activeOwner: "approval-lane",
  progressAxes: {
    roadmap_current_point: "10.4.2-beta",
    latest_validated_change: "fixture-seeded",
    next_smallest_batch: "seed human gate candidate",
    blockers: ["pending approval"],
  },
});

const fixturePath = path.join(stackDir, "churn_fixture.json");
await writeAtomicJson(fixturePath, {
  generated_at: now,
  workspace,
  shared_base: sharedBase,
  workspace_key: workspaceKey,
  projects: {
    alpha: {
      project_key: alphaProjectKey,
      thread_id: alphaThreadId,
      target_file: alphaTargetPath,
    },
    beta: {
      project_key: betaProjectKey,
      thread_id: betaThreadId,
      approval_source_ref: betaApprovalSource,
    },
  },
  discord_keys: {
    public_key_path: publicKeyPath,
    private_key_path: privateKeyPath,
  },
});

await writeAtomicJson(path.join(stackDir, "churn_driver_state.json"), {
  next_cycle: 0,
  beta_candidate_seeded: false,
});

console.log(JSON.stringify({
  ok: true,
  fixture_path: fixturePath,
  alpha_project_key: alphaProjectKey,
  beta_project_key: betaProjectKey,
  alpha_thread_id: alphaThreadId,
  beta_thread_id: betaThreadId,
  alpha_target_path: alphaTargetPath,
  public_key_path: publicKeyPath,
  private_key_path: privateKeyPath,
  ws_url: wsUrl,
}, null, 2));
