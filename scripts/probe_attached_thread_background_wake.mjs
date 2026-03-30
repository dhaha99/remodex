import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcWsClient } from "./lib/app_server_jsonrpc.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";

const execFileAsync = promisify(execFile);
const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "attached_thread_background_wake_probe");
const summaryPath = path.join(verificationDir, "attached_thread_background_wake_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

function extractTurnId(result) {
  return result?.turn?.id ?? result?.turnId ?? result?.id ?? null;
}

function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

async function readThreadStatus(client, threadId, attempts = 10) {
  for (let index = 0; index < attempts; index += 1) {
    const threadRead = await client.request("thread/read", {
      threadId,
      includeTurns: false,
    }).catch(() => null);
    const actualStatus = threadRead?.thread?.status?.type ?? threadRead?.thread?.status ?? null;
    if (actualStatus) return threadRead?.thread ?? null;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

const summary = {
  startedAt: new Date().toISOString(),
};

let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const probeWorkspace = path.join(probeRoot, "thread-workspace");
  await fs.mkdir(probeWorkspace, { recursive: true });

  client = new JsonRpcWsClient(wsUrl, null);
  await client.connect();
  await client.initialize("attached_thread_background_wake_probe");

  const threadStart = await client.request("thread/start", {
    cwd: probeWorkspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "attached_thread_background_wake_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread/start did not return thread id");
  summary.threadId = threadId;

  const seedTurn = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          "This is a background wake probe thread. Do not modify any files. " +
          "Briefly acknowledge that this thread may later be resumed for coordinator wake validation.",
      },
    ],
  });
  const seedTurnId = extractTurnId(seedTurn);
  await client.waitForNotification("turn/completed", completedTurnPredicate(seedTurnId), 240_000);
  summary.seedTurnId = seedTurnId;

  client.close();
  client = null;

  client = new JsonRpcWsClient(wsUrl, null);
  await client.connect();
  await client.initialize("attached_thread_background_wake_probe_verify");

  const storedThread = await readThreadStatus(client, threadId);
  summary.threadStatusBeforeAttach = storedThread?.status?.type ?? storedThread?.status ?? null;

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const projectKey = "project-attached-wake";
  const paths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey,
  });
  await ensureProjectDirs(paths);

  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    display_name: "Attached Wake Probe",
    aliases: ["attached-wake-probe"],
    source_kind: "codex_thread_attach",
    attached_thread_id: threadId,
    cwd: probeWorkspace,
    created_at: new Date().toISOString(),
    created_by: "probe",
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "active",
    observed_at: new Date().toISOString(),
    threadId,
    activeFlags: [],
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
    mode: "background",
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(
    path.join(paths.stateDir, "current_goal.md"),
    "current_goal: attached existing thread wake validation\n",
  );
  await writeAtomicText(
    path.join(paths.stateDir, "current_focus.md"),
    "current_focus: scheduler wake for notLoaded attached thread\n",
  );
  await writeAtomicText(
    path.join(paths.stateDir, "progress_axes.md"),
    "next_smallest_batch: main coordinator state refresh\n",
  );

  const { stdout, stderr } = await execFileAsync("node", [path.join(workspace, "scripts/remodex_scheduler_tick.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      REMODEX_PROJECT_KEY: projectKey,
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
  });

  summary.schedulerStdout = stdout;
  summary.schedulerStderr = stderr;
  summary.schedulerRuntime = await readJsonIfExists(path.join(paths.runtimeDir, "scheduler_runtime.json"));
  summary.coordinatorStatusAfterTick = await readJsonIfExists(path.join(paths.stateDir, "coordinator_status.json"));

  const wakeSucceeded =
    (
      summary.schedulerRuntime?.decision === "attached_thread_wake" &&
      summary.schedulerRuntime?.result?.delivery_decision === "attached_thread_resumed" &&
      Boolean(summary.schedulerRuntime?.result?.thread_id) &&
      Boolean(summary.schedulerRuntime?.result?.resumed_status) &&
      summary.coordinatorStatusAfterTick?.type === summary.schedulerRuntime?.result?.resumed_status
    ) ||
    (
      summary.schedulerRuntime?.decision === "noop" &&
      Array.isArray(summary.schedulerRuntime?.reasons) &&
      summary.schedulerRuntime.reasons.includes("no_pending_work") &&
      summary.coordinatorStatusAfterTick?.type === summary.threadStatusBeforeAttach &&
      summary.threadStatusBeforeAttach !== "active"
    );

  summary.finishedAt = new Date().toISOString();
  summary.status = wakeSucceeded ? "PASS" : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  client?.close();
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "attached thread background wake probe failed");
}
