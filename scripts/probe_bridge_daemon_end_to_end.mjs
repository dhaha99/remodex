import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  JsonRpcWsClient,
} from "./lib/app_server_jsonrpc.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "bridge_daemon_end_to_end_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const outboxDir = path.join(sharedBase, "remodex", "router", "outbox");
const projectRoot = path.join(sharedBase, "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const targetPath = path.join(verificationDir, "bridge_daemon_target.txt");
const summaryPath = path.join(verificationDir, "bridge_daemon_end_to_end_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "bridge_daemon_end_to_end_probe_events.jsonl");
const publicKeyPath = path.join(probeRoot, "discord_public.pem");
const daemonLogPath = path.join(probeRoot, "daemon.log");
const daemonPort = 8791;
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

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function waitFor(predicate, timeoutMs = 20_000, intervalMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
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
  statusResponse: null,
  statusOutbox: null,
  intentResponse: null,
  targetContent: null,
};

let daemon = null;
let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(targetPath, { force: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }));

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("bridge_daemon_end_to_end_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "bridge_daemon_end_to_end_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await fs.writeFile(
    path.join(stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ workspace_key: "remodex", project_key: "project-alpha", threadId }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "coordinator_status.json"),
    `${JSON.stringify({ type: "checkpoint_open" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(stateDir, "background_trigger_toggle.json"),
    `${JSON.stringify({
      background_trigger_enabled: true,
      foreground_session_active: false,
      foreground_lock_enabled: false,
    }, null, 2)}\n`,
  );
  await fs.writeFile(path.join(stateDir, "current_goal.md"), "current_goal: daemon intent delivery\n");
  await fs.writeFile(path.join(stateDir, "roadmap_status.md"), "roadmap_current_point: bridge-daemon-e2e\n");
  await fs.writeFile(path.join(stateDir, "progress_axes.md"), "next_smallest_batch: deliver daemon intent\n");
  await fs.writeFile(path.join(stateDir, "operator_acl.md"), "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n");

  daemon = spawn("node", [path.join(workspace, "scripts", "remodex_bridge_daemon.mjs")], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      REMODEX_OPERATOR_HTTP_PORT: String(daemonPort),
      REMODEX_DISCORD_PUBLIC_KEY_PATH: publicKeyPath,
      CODEX_APP_SERVER_WS_URL: wsUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const daemonLog = [];
  daemon.stdout.on("data", (chunk) => daemonLog.push(String(chunk)));
  daemon.stderr.on("data", (chunk) => daemonLog.push(String(chunk)));

  const health = await waitFor(async () => {
    try {
      const response = await httpGet(`http://127.0.0.1:${daemonPort}/health`);
      return response.status === 200 ? response : null;
    } catch {
      return null;
    }
  }, 20_000);
  if (!health) throw new Error("bridge daemon did not become healthy");

  const statusPayload = {
    id: "bridge-daemon-status-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "ops-alpha",
    timestamp: "2026-03-26T22:30:00+09:00",
    member: {
      user: { id: "operator-1" },
      roles: ["operator"],
    },
    data: {
      name: "status",
      options: [{ name: "project", value: "project-alpha" }],
    },
  };
  const statusBody = JSON.stringify(statusPayload);
  const statusTimestamp = String(nowEpochSeconds());
  const statusSignature = signInteraction(privateKey, statusTimestamp, statusBody);
  summary.statusResponse = await httpPost(
    `http://127.0.0.1:${daemonPort}/discord/interactions`,
    statusBody,
    {
      "x-signature-timestamp": statusTimestamp,
      "x-signature-ed25519": statusSignature,
    },
  );
  summary.statusOutbox = summary.statusResponse?.json?.result?.outbox ?? null;

  const intentPayload = {
    id: "bridge-daemon-intent-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "ops-alpha",
    timestamp: "2026-03-26T22:31:00+09:00",
    member: {
      user: { id: "operator-2" },
      roles: ["operator"],
    },
    data: {
      name: "intent",
      options: [
        { name: "project", value: "project-alpha" },
        {
          name: "request",
          value: `Create only ${targetPath} with exact contents bridge-daemon-ok\\n. Do not modify any other file.`,
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

  summary.targetContent = await waitFor(async () => await readTextIfExists(targetPath), 30_000);
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.statusResponse?.status === 200 &&
    summary.statusResponse?.json?.result?.summary?.project_key === "project-alpha" &&
    summary.statusOutbox?.filePath?.startsWith(outboxDir) &&
    summary.intentResponse?.status === 202 &&
    summary.intentResponse?.json?.result?.delivery_decision === "scheduled_delivery" &&
    summary.targetContent === "bridge-daemon-ok\n"
      ? "PASS"
      : "FAIL";
  await fs.writeFile(daemonLogPath, daemonLog.join(""));
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
