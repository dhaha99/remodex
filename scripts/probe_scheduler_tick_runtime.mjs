import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcWsClient } from "./lib/app_server_jsonrpc.mjs";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "scheduler_tick_runtime_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const projectRoot = path.join(sharedBase, "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const runtimeDir = path.join(projectRoot, "runtime");
const blockedTargetPath = path.join(verificationDir, "scheduler_tick_blocked.txt");
const deliveredTargetPath = path.join(verificationDir, "scheduler_tick_delivered.txt");
const summaryPath = path.join(verificationDir, "scheduler_tick_runtime_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "scheduler_tick_runtime_probe_events.jsonl");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeInboxEvent(fileName, request) {
  await writeJson(path.join(inboxDir, fileName), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    source_ref: fileName,
    correlation_key: fileName,
    command_class: "intent",
    request,
    received_at: "2026-03-26T22:40:00+09:00",
  });
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  blockedRun: null,
  deliveredRun: null,
};

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(blockedTargetPath, { force: true });
  await fs.rm(deliveredTargetPath, { force: true });

  await client.connect();
  await client.initialize("scheduler_tick_runtime_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "scheduler_tick_runtime_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });

  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: true,
    foreground_lock_enabled: true,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "busy_non_interruptible",
  });
  await writeInboxEvent(
    "blocked-intent.json",
    `Create only ${blockedTargetPath} with exact contents blocked-should-not-run\\n.`,
  );

  const blockedExec = await execFileAsync("node", [path.join(workspace, "scripts", "remodex_scheduler_tick.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
  });
  summary.blockedRun = {
    stdout: blockedExec.stdout,
    runtime: JSON.parse(await fs.readFile(path.join(runtimeDir, "scheduler_runtime.json"), "utf8")),
    blockedTarget: await readTextIfExists(blockedTargetPath),
  };

  await fs.rm(path.join(inboxDir, "blocked-intent.json"), { force: true });
  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "checkpoint_open",
  });
  await writeInboxEvent(
    "delivered-intent.json",
    `Create only ${deliveredTargetPath} with exact contents scheduler-tick-ok\\n.`,
  );

  const deliveredExec = await execFileAsync("node", [path.join(workspace, "scripts", "remodex_scheduler_tick.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
  });
  summary.deliveredRun = {
    stdout: deliveredExec.stdout,
    runtime: JSON.parse(await fs.readFile(path.join(runtimeDir, "scheduler_runtime.json"), "utf8")),
    deliveredTarget: await readTextIfExists(deliveredTargetPath),
  };

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.blockedRun?.runtime?.decision === "blocked" &&
    summary.blockedRun?.blockedTarget === null &&
    summary.deliveredRun?.runtime?.decision === "inbox" &&
    summary.deliveredRun?.runtime?.result?.delivery_decision === "delivered" &&
    summary.deliveredRun?.deliveredTarget === "scheduler-tick-ok\n"
      ? "PASS"
      : "FAIL";
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client?.clearAllWaiters();
  client?.close();
}
