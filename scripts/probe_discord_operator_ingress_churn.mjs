import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonRpcWsClient, readTurnCount } from "./lib/app_server_jsonrpc.mjs";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_operator_ingress_churn_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const outboxDir = path.join(sharedBase, "remodex", "router", "outbox");
const quarantineDir = path.join(sharedBase, "remodex", "router", "quarantine");
const projectRoot = path.join(sharedBase, "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const dispatchQueueDir = path.join(projectRoot, "dispatch_queue");
const processedDir = path.join(projectRoot, "processed");
const publicKeyPath = path.join(probeRoot, "discord_public.pem");
const summaryPath = path.join(verificationDir, "discord_operator_ingress_churn_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "discord_operator_ingress_churn_probe_events.jsonl");
const target1Path = path.join(verificationDir, "discord_ingress_churn_target1.txt");
const target2Path = path.join(verificationDir, "discord_ingress_churn_target2.txt");
const wrongPath = path.join(verificationDir, "discord_ingress_churn_wrong.txt");
const daemonPort = 8794;
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function signInteraction(privateKey, timestamp, body) {
  return crypto.sign(null, Buffer.from(`${timestamp}${body}`, "utf8"), privateKey).toString("hex");
}

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  return JSON.parse(text);
}

async function runSchedulerTickDrain() {
  const schedulerRun = await execFileAsync("node", [path.join(workspace, "scripts", "remodex_scheduler_tick.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
  });
  return {
    stdout: schedulerRun.stdout,
    runtime: await readJsonIfExists(path.join(projectRoot, "runtime", "scheduler_runtime.json")),
  };
}

async function waitForThreadIdle(client, threadId, minimumTurnCount) {
  return await waitFor(async () => {
    const turnCount = await readTurnCount(client, threadId);
    const threadStatus = turnCount?.threadRead?.thread?.status?.type ?? null;
    const turns = turnCount?.threadRead?.thread?.turns ?? [];
    const lastTurn = turns.at(-1) ?? null;
    if (
      turnCount?.count >= minimumTurnCount &&
      threadStatus === "idle" &&
      lastTurn?.status === "completed"
    ) {
      return turnCount;
    }
    return null;
  }, 90_000, 500);
}

async function httpGet(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    json: await response.json(),
  };
}

async function httpPost(url, body = null, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body,
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

function payload({
  id,
  commandName,
  channelId,
  timestamp,
  roles,
  options,
}) {
  return {
    id,
    type: 2,
    guild_id: "guild-1",
    channel_id: channelId,
    timestamp,
    member: {
      user: { id: "ops-user-1" },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

async function signedInteraction(privateKey, interaction) {
  const body = JSON.stringify(interaction);
  const timestamp = String(nowEpochSeconds());
  const signature = signInteraction(privateKey, timestamp, body);
  return await httpPost(
    `http://127.0.0.1:${daemonPort}/discord/interactions`,
    body,
    {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    },
  );
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  calls: {},
  statusOutbox: [],
  quarantineFiles: [],
  processedReceipts: [],
  dispatchQueueFiles: [],
  inboxFiles: [],
  targets: {},
  turnCount: null,
};

let daemon = null;
let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await Promise.all([target1Path, target2Path, wrongPath].map((filePath) => fs.rm(filePath, { force: true })));

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("discord_operator_ingress_churn_probe_owner");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "discord_operator_ingress_churn_probe_owner",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await fs.writeFile(
    path.join(stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ workspace_key: "remodex", project_key: "project-alpha", threadId }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "background_trigger_toggle.json"),
    `${JSON.stringify({
      background_trigger_enabled: true,
      foreground_session_active: false,
      foreground_lock_enabled: false,
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "coordinator_status.json"),
    `${JSON.stringify({ type: "checkpoint_open" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "operator_acl.md"),
    "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n",
  );

  daemon = spawn("node", [path.join(workspace, "scripts", "remodex_bridge_daemon.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      REMODEX_OPERATOR_HTTP_PORT: String(daemonPort),
      REMODEX_DISCORD_PUBLIC_KEY_PATH: publicKeyPath,
      REMODEX_AUTO_CONSUME_HUMAN_GATE: "false",
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  const health = await waitFor(async () => {
    try {
      const response = await httpGet(`http://127.0.0.1:${daemonPort}/health`);
      return response.status === 200 ? response : null;
    } catch {
      return null;
    }
  }, 20_000);
  if (!health) throw new Error("bridge daemon did not become healthy");

  const status1Payload = payload({
    id: "discord-churn-status-001",
    commandName: "status",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:00:00+09:00",
    roles: ["operator"],
    options: [{ name: "project", value: "project-alpha" }],
  });
  summary.calls.status1 = await signedInteraction(privateKey, status1Payload);

  const intent1Payload = payload({
    id: "discord-churn-intent-001",
    commandName: "intent",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:01:00+09:00",
    roles: ["operator"],
    options: [
      { name: "project", value: "project-alpha" },
      {
        name: "request",
        value: `Create only ${target1Path} with exact contents ingress-churn-1\\n. Do not create ${wrongPath}.`,
      },
    ],
  });
  summary.calls.intent1 = await signedInteraction(privateKey, intent1Payload);
  summary.targets.target1 = await waitFor(async () => await readTextIfExists(target1Path), 90_000);
  summary.calls.turn1Settled = await waitForThreadIdle(client, threadId, 1);

  const status2Payload = payload({
    id: "discord-churn-status-002",
    commandName: "status",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:02:00+09:00",
    roles: ["operator"],
    options: [{ name: "project", value: "project-alpha" }],
  });
  summary.calls.status2 = await signedInteraction(privateKey, status2Payload);

  await fs.writeFile(
    path.join(stateDir, "background_trigger_toggle.json"),
    `${JSON.stringify({
      background_trigger_enabled: false,
      foreground_session_active: true,
      foreground_lock_enabled: true,
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "coordinator_status.json"),
    `${JSON.stringify({ type: "busy_non_interruptible" }, null, 2)}\n`,
  );

  const intent2Payload = payload({
    id: "discord-churn-intent-002",
    commandName: "intent",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:03:00+09:00",
    roles: ["operator"],
    options: [
      { name: "project", value: "project-alpha" },
      {
        name: "request",
        value: `Create only ${target2Path} with exact contents ingress-churn-2\\n. Do not create ${wrongPath}.`,
      },
    ],
  });
  const replayBody = JSON.stringify(intent2Payload);
  const replayTimestamp = String(nowEpochSeconds());
  const replaySignature = signInteraction(privateKey, replayTimestamp, replayBody);
  summary.calls.intent2 = await httpPost(
    `http://127.0.0.1:${daemonPort}/discord/interactions`,
    replayBody,
    {
      "x-signature-timestamp": replayTimestamp,
      "x-signature-ed25519": replaySignature,
    },
  );
  summary.calls.intent2Replay = await httpPost(
    `http://127.0.0.1:${daemonPort}/discord/interactions`,
    replayBody,
    {
      "x-signature-timestamp": replayTimestamp,
      "x-signature-ed25519": replaySignature,
    },
  );

  const unauthorizedApprovePayload = payload({
    id: "discord-churn-approve-001",
    commandName: "approve",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:04:00+09:00",
    roles: ["viewer"],
    options: [
      { name: "project", value: "project-alpha" },
      { name: "source_ref", value: "not-live-approval" },
    ],
  });
  summary.calls.unauthorizedApprove = await signedInteraction(privateKey, unauthorizedApprovePayload);

  const missingProjectPayload = payload({
    id: "discord-churn-intent-003",
    commandName: "intent",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:05:00+09:00",
    roles: ["operator"],
    options: [{ name: "request", value: "missing project should quarantine" }],
  });
  summary.calls.missingProject = await signedInteraction(privateKey, missingProjectPayload);

  const status3Payload = payload({
    id: "discord-churn-status-003",
    commandName: "status",
    channelId: "ops-alpha",
    timestamp: "2026-03-27T09:06:00+09:00",
    roles: ["operator"],
    options: [{ name: "project", value: "project-alpha" }],
  });
  summary.calls.status3 = await signedInteraction(privateKey, status3Payload);

  await fs.writeFile(
    path.join(stateDir, "background_trigger_toggle.json"),
    `${JSON.stringify({
      background_trigger_enabled: true,
      foreground_session_active: false,
      foreground_lock_enabled: false,
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "coordinator_status.json"),
    `${JSON.stringify({ type: "checkpoint_open" }, null, 2)}\n`,
  );
  summary.calls.schedulerDrainAttempts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const drainAttempt = await runSchedulerTickDrain();
    summary.calls.schedulerDrainAttempts.push(drainAttempt);
    if (
      drainAttempt?.runtime?.decision === "dispatch_queue" &&
      drainAttempt?.runtime?.result?.delivery_decision === "delivered"
    ) {
      break;
    }
    await sleep(1000);
  }
  summary.targets.target2 = await waitFor(async () => await readTextIfExists(target2Path), 90_000);
  summary.calls.turn2Settled = await waitForThreadIdle(client, threadId, 2);

  summary.statusOutbox = await Promise.all(
    ((await fs.readdir(outboxDir).catch(() => [])).sort())
      .filter((name) => name.includes("status_response"))
      .map(async (name) => ({
        filePath: path.join(outboxDir, name),
        record: await readJsonIfExists(path.join(outboxDir, name)),
      })),
  );
  summary.quarantineFiles = (await fs.readdir(quarantineDir).catch(() => [])).sort();
  summary.processedReceipts = (await fs.readdir(processedDir).catch(() => [])).sort();
  summary.dispatchQueueFiles = (await fs.readdir(dispatchQueueDir).catch(() => [])).sort();
  summary.inboxFiles = (await fs.readdir(inboxDir).catch(() => [])).sort();
  summary.targets.wrong = await readTextIfExists(wrongPath);
  summary.turnCount = await readTurnCount(client, threadId);

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.calls.status1?.status === 200 &&
    summary.calls.intent1?.status === 202 &&
    summary.calls.intent1?.json?.result?.delivery_decision === "scheduled_delivery" &&
    summary.targets.target1 === "ingress-churn-1\n" &&
    summary.calls.turn1Settled?.count === 1 &&
    summary.calls.intent2?.status === 202 &&
    summary.calls.intent2?.json?.result?.delivery_decision === "deferred" &&
    summary.calls.intent2Replay?.status === 409 &&
    summary.calls.unauthorizedApprove?.status === 202 &&
    summary.calls.unauthorizedApprove?.json?.result?.route === "quarantine" &&
    summary.calls.missingProject?.status === 202 &&
    summary.calls.missingProject?.json?.result?.route === "quarantine" &&
    summary.calls.status3?.status === 200 &&
    summary.calls.schedulerDrainAttempts?.some(
      (attempt) =>
        attempt?.runtime?.decision === "dispatch_queue" &&
        attempt?.runtime?.result?.delivery_decision === "delivered",
    ) &&
    summary.targets.target2 === "ingress-churn-2\n" &&
    summary.calls.turn2Settled?.count === 2 &&
    summary.targets.wrong === null &&
    summary.statusOutbox.length === 3 &&
    summary.quarantineFiles.length === 2 &&
    summary.processedReceipts.length === 2 &&
    summary.dispatchQueueFiles.length === 0 &&
    summary.inboxFiles.length === 0 &&
    summary.turnCount?.count === 2
      ? "PASS"
      : "FAIL";

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "PASS") {
    process.exitCode = 1;
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  daemon?.kill("SIGTERM");
  client?.clearAllWaiters();
  client?.close();
}
