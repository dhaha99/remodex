import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcWsClient, readTurnCount } from "./lib/app_server_jsonrpc.mjs";
import { readJsonIfExists } from "./lib/shared_memory_runtime.mjs";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "scheduler_churn_long_run_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const projectRoot = path.join(sharedBase, "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const runtimeDir = path.join(projectRoot, "runtime");
const processedDir = path.join(projectRoot, "processed");
const summaryPath = path.join(verificationDir, "scheduler_churn_long_run_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "scheduler_churn_long_run_probe_events.jsonl");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

const targets = {
  cycle1: path.join(verificationDir, "scheduler_churn_cycle1.txt"),
  cycle2: path.join(verificationDir, "scheduler_churn_cycle2.txt"),
  cycle3: path.join(verificationDir, "scheduler_churn_cycle3.txt"),
};

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeInboxEvent(fileName, request) {
  await writeJson(path.join(inboxDir, fileName), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    source_ref: fileName,
    correlation_key: fileName,
    command_class: "intent",
    request,
    received_at: "2026-03-27T08:30:00+09:00",
  });
}

async function runTick() {
  const execution = await execFileAsync("node", [path.join(workspace, "scripts", "remodex_scheduler_tick.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
  });
  return {
    stdout: execution.stdout,
    runtime: JSON.parse(await fs.readFile(path.join(runtimeDir, "scheduler_runtime.json"), "utf8")),
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  cycles: [],
  turnCountBefore: null,
  turnCountAfter: null,
  processedReceipts: [],
  inboxRemaining: [],
  inflightAfter: null,
  targets: {},
};

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await Promise.all(Object.values(targets).map((filePath) => fs.rm(filePath, { force: true })));

  await client.connect();
  await client.initialize("scheduler_churn_long_run_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "scheduler_churn_long_run_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });
  await fs.writeFile(
    path.join(stateDir, "operator_acl.md"),
    "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n",
  );

  summary.turnCountBefore = { count: 0 };

  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), { type: "checkpoint_open" });
  await writeInboxEvent(
    "cycle1-intent.json",
    `Create only ${targets.cycle1} with exact contents scheduler-churn-cycle-1\\n.`,
  );
  summary.cycles.push({ name: "cycle1_allowed", ...(await runTick()) });

  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: true,
    foreground_lock_enabled: true,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), { type: "busy_non_interruptible" });
  await writeInboxEvent(
    "cycle2-intent.json",
    `Create only ${targets.cycle2} with exact contents scheduler-churn-cycle-2\\n.`,
  );
  summary.cycles.push({ name: "cycle2_blocked", ...(await runTick()) });

  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), { type: "checkpoint_open" });
  summary.cycles.push({ name: "cycle3_drain_blocked_work", ...(await runTick()) });
  summary.cycles.push({ name: "cycle4_noop", ...(await runTick()) });

  await writeInboxEvent(
    "cycle5-intent.json",
    `Create only ${targets.cycle3} with exact contents scheduler-churn-cycle-3\\n.`,
  );
  summary.cycles.push({ name: "cycle5_allowed", ...(await runTick()) });

  summary.turnCountAfter = await readTurnCount(client, threadId);
  summary.processedReceipts = (await fs.readdir(processedDir)).sort();
  summary.inboxRemaining = (await fs.readdir(inboxDir).catch(() => [])).sort();
  summary.inflightAfter = await readJsonIfExists(path.join(runtimeDir, "inflight_delivery.json"));
  summary.targets = {
    cycle1: await readTextIfExists(targets.cycle1),
    cycle2: await readTextIfExists(targets.cycle2),
    cycle3: await readTextIfExists(targets.cycle3),
  };

  const decisions = summary.cycles.map((cycle) => cycle.runtime?.decision ?? null);
  const deliveries = summary.cycles.map((cycle) => cycle.runtime?.result?.delivery_decision ?? null);

  summary.finishedAt = new Date().toISOString();
  summary.status =
    decisions.join(",") === "inbox,blocked,inbox,noop,inbox" &&
    deliveries[0] === "delivered" &&
    deliveries[2] === "delivered" &&
    deliveries[4] === "delivered" &&
    summary.targets.cycle1 === "scheduler-churn-cycle-1\n" &&
    summary.targets.cycle2 === "scheduler-churn-cycle-2\n" &&
    summary.targets.cycle3 === "scheduler-churn-cycle-3\n" &&
    summary.turnCountBefore?.count === 0 &&
    summary.turnCountAfter?.count === 3 &&
    summary.processedReceipts.length === 3 &&
    summary.inboxRemaining.length === 0 &&
    summary.inflightAfter === null
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
