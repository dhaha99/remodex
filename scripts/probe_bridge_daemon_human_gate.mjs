import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  JsonRpcWsClient,
  completedTurnPredicate,
} from "./lib/app_server_jsonrpc.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "bridge_daemon_human_gate_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const outboxDir = path.join(sharedBase, "remodex", "router", "outbox");
const projectRoot = path.join(sharedBase, "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const processedDir = path.join(projectRoot, "processed");
const publicKeyPath = path.join(probeRoot, "discord_public.pem");
const summaryPath = path.join(verificationDir, "bridge_daemon_human_gate_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "bridge_daemon_human_gate_probe_events.jsonl");
const approvedPath = path.join(verificationDir, "bridge_daemon_human_gate_ok.txt");
const wrongPath = path.join(verificationDir, "bridge_daemon_human_gate_wrong.txt");
const pendingApprovalsPath = path.join(sharedBase, "remodex", "router", "pending_approvals.json");
const daemonPort = 8792;
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

async function httpGet(url) {
  const response = await fetch(url);
  return {
    status: response.status,
    json: await response.json(),
  };
}

async function httpPost(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  intentResponse: null,
  turnId: null,
  pendingApproval: null,
  daemonPendingApprovals: null,
  humanGateOutbox: null,
  approvalClosure: null,
  approvedContent: null,
  wrongContent: null,
  processedReceipts: null,
};

let daemon = null;
let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(approvedPath, { force: true });
  await fs.rm(wrongPath, { force: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("bridge_daemon_human_gate_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "bridge_daemon_human_gate_probe",
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
      REMODEX_AUTO_CONSUME_HUMAN_GATE: "true",
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

  const intentPayload = {
    id: "bridge-daemon-human-gate-intent-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "ops-alpha",
    timestamp: "2026-03-26T22:49:00+09:00",
    member: {
      user: { id: "operator-1" },
      roles: ["operator"],
    },
    data: {
      name: "intent",
      options: [
        { name: "project", value: "project-alpha" },
        {
          name: "request",
          value:
            `Create only ${approvedPath} with exact contents bridge-daemon-human-gate-ok\\n. ` +
            `Do not create ${wrongPath}.`,
        },
      ],
    },
  };
  const intentBody = JSON.stringify(intentPayload);
  const intentTimestamp = String(nowEpochSeconds());
  const intentSignature = signInteraction(privateKey, intentTimestamp, intentBody);
  summary.intentResponse = await httpPost(
    `http://127.0.0.1:${daemonPort}/discord/interactions`,
    intentBody,
    {
      "x-signature-timestamp": intentTimestamp,
      "x-signature-ed25519": intentSignature,
    },
  );

  const pendingApprovals = await client.waitForServerRequest(
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    (msg) => (msg.params?.threadId ?? null) === threadId,
    60_000,
  );
  summary.pendingApproval = {
    id: pendingApprovals.id,
    method: pendingApprovals.method,
    params: pendingApprovals.params,
  };
  summary.turnId = pendingApprovals.params?.turnId ?? null;
  summary.daemonPendingApprovals = await readJsonIfExists(pendingApprovalsPath);
  summary.humanGateOutbox = await waitFor(async () => {
    const fileNames = await fs.readdir(outboxDir).catch(() => []);
    const match = fileNames.find((name) => name.includes("human_gate_notification"));
    if (!match) return null;
    return {
      filePath: path.join(outboxDir, match),
      record: await readJsonIfExists(path.join(outboxDir, match)),
    };
  }, 30_000);

  const followupApprovals = [];
  await client.respond(pendingApprovals.id, { decision: "accept" });
  let completed = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      completed = await client.waitForNotification(
        "turn/completed",
        completedTurnPredicate(summary.turnId),
        15_000,
      );
      break;
    } catch {
      const extraApproval = await client.waitForServerRequest(
        ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
        (msg) => (msg.params?.threadId ?? null) === threadId,
        60_000,
      );
      followupApprovals.push({
        id: extraApproval.id,
        method: extraApproval.method,
        params: extraApproval.params,
      });
      await client.respond(extraApproval.id, { decision: "accept" });
    }
  }
  if (!completed) {
    completed = await client.waitForNotification(
      "turn/completed",
      completedTurnPredicate(summary.turnId),
      120_000,
    );
  }
  summary.approvalClosure = {
    mode: "foreground_client_accept",
    completed: completed.params ?? completed,
    followupApprovals,
  };

  summary.approvedContent = await waitFor(async () => await readTextIfExists(approvedPath), 60_000);
  summary.wrongContent = await readTextIfExists(wrongPath);
  summary.processedReceipts = await fs.readdir(processedDir).catch(() => []);
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.intentResponse?.status === 202 &&
    summary.intentResponse?.json?.result?.delivery_decision === "scheduled_delivery" &&
    summary.pendingApproval?.method &&
    summary.daemonPendingApprovals === null &&
    summary.humanGateOutbox?.filePath?.startsWith(outboxDir) &&
    summary.approvalClosure?.mode === "foreground_client_accept" &&
    summary.approvedContent === "bridge-daemon-human-gate-ok\n" &&
    summary.wrongContent === null &&
    Array.isArray(summary.processedReceipts) &&
    summary.processedReceipts.length === 0
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
  daemon?.kill("SIGTERM");
  client?.clearAllWaiters();
  client?.close();
}
