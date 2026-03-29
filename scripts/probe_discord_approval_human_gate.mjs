import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_approval_human_gate_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const dispatchQueueDir = path.join(projectRoot, "dispatch_queue");
const humanGateDir = path.join(projectRoot, "human_gate_candidates");
const quarantineDir = path.join(probeRoot, "router", "quarantine");
const ingressLogPath = path.join(probeRoot, "router", "ingress_log.jsonl");
const eventsLogPath = path.join(verificationDir, "discord_approval_human_gate_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "discord_approval_human_gate_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const approvalFilePath = path.join(verificationDir, "discord_approval_should_not_exist.txt");

await fs.mkdir(verificationDir, { recursive: true });

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isoSafe(ts) {
  return ts.replaceAll(":", "-");
}

function correlationKey(payload) {
  return `${payload.guild_id}:${payload.channel_id}:${payload.id}`;
}

function signInteraction(privateKey, timestamp, body) {
  return crypto.sign(null, Buffer.from(`${timestamp}${body}`, "utf8"), privateKey).toString("hex");
}

class ReplayCache {
  constructor() {
    this.seen = new Set();
  }

  claim(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

class JsonRpcWsClient {
  constructor(url, logPath) {
    this.url = url;
    this.logPath = logPath;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.serverRequestWaiters = [];
    this.eventCounts = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(`websocket connect failed: ${event.message ?? "unknown error"}`));
      };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });

    this.ws.addEventListener("message", async (event) => {
      const text = String(event.data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      await fs.appendFile(this.logPath, `${JSON.stringify(msg)}\n`);

      if (msg.id !== undefined && msg.method === undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code ?? "no-code"})`));
        else pending.resolve(msg.result);
        return;
      }

      if (msg.id !== undefined && msg.method !== undefined) {
        const waiters = [...this.serverRequestWaiters];
        for (const waiter of waiters) {
          if (!waiter.methods.includes(msg.method)) continue;
          if (!waiter.predicate(msg)) continue;
          waiter.resolve(msg);
          this.serverRequestWaiters = this.serverRequestWaiters.filter((candidate) => candidate !== waiter);
        }
        return;
      }

      const method = msg.method ?? "unknown";
      this.eventCounts.set(method, (this.eventCounts.get(method) ?? 0) + 1);
      const waiters = [...this.notificationWaiters];
      for (const waiter of waiters) {
        if (waiter.method !== method) continue;
        if (!waiter.predicate(msg)) continue;
        waiter.resolve(msg);
        this.notificationWaiters = this.notificationWaiters.filter((candidate) => candidate !== waiter);
      }
    });
  }

  async initialize(name) {
    await this.request("initialize", {
      clientInfo: { name, title: name, version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const payload = { method, id, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  async respond(id, result) {
    this.ws.send(JSON.stringify({ id, result }));
  }

  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ method, params }));
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`timeout waiting for ${method}`));
      }, timeoutMs);
      const entry = {
        method,
        predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer,
      };
      this.notificationWaiters.push(entry);
    });
  }

  waitForAnyServerRequest(methods, predicate = () => true, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.serverRequestWaiters = this.serverRequestWaiters.filter((waiter) => waiter !== entry);
        reject(new Error(`timeout waiting for server request ${methods.join(",")}`));
      }, timeoutMs);
      const entry = {
        methods,
        predicate,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        timer,
      };
      this.serverRequestWaiters.push(entry);
    });
  }

  close() {
    this.ws?.close();
  }
}

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function readDirSafe(dirPath) {
  try {
    return (await fs.readdir(dirPath)).sort();
  } catch {
    return [];
  }
}

function verifyDiscordStyleRequest({
  publicKey,
  signatureHex,
  timestamp,
  rawBody,
  interactionId,
  replayCache,
  maxAgeSeconds = 300,
}) {
  if (!signatureHex || !timestamp || !rawBody || !interactionId) {
    return { ok: false, reason: "missing_required_fields", httpStatus: 400 };
  }
  if (Math.abs(nowEpochSeconds() - Number(timestamp)) > maxAgeSeconds) {
    return { ok: false, reason: "stale_timestamp", httpStatus: 401 };
  }
  const replayKey = `${interactionId}:${timestamp}:${signatureHex}`;
  if (!replayCache.claim(replayKey)) {
    return { ok: false, reason: "replay_detected", httpStatus: 409 };
  }
  const verified = crypto.verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`, "utf8"),
    publicKey,
    Buffer.from(signatureHex, "hex"),
  );
  if (!verified) {
    return { ok: false, reason: "invalid_signature", httpStatus: 401 };
  }
  return { ok: true, reason: "accepted", httpStatus: 202 };
}

function normalizePayload(payload) {
  const options = payload.data?.options ?? [];
  const commandName = payload.data?.name ?? null;
  return {
    source: "discord",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: payload.member?.roles ?? [],
    command_name: commandName,
    auth_class: commandName === "approve" ? "approval" : "intent",
    verified_identity: "signature_verified",
    workspace_key: "remodex",
    project_key: options.find((option) => option.name === "project")?.value ?? null,
    source_ref: options.find((option) => option.name === "source_ref")?.value ?? null,
    request: options.find((option) => option.name === "request")?.value ?? null,
    artifact: options.find((option) => option.name === "artifact")?.value ?? null,
    correlation_key: correlationKey(payload),
    received_at: payload.timestamp,
  };
}

function evaluateAcl(intent) {
  const roles = new Set(intent.operator_roles);
  if (!intent.project_key) {
    return { decision: "quarantine", reason: "missing_project" };
  }
  if (intent.project_key !== "project-alpha") {
    return { decision: "quarantine", reason: "unknown_project" };
  }
  if (intent.auth_class === "approval" && !roles.has("ops-admin")) {
    return { decision: "quarantine", reason: "unauthorized_approval" };
  }
  return { decision: "pass", reason: null };
}

async function routeInteraction(payload, activeApprovalSourceRef) {
  const intent = normalizePayload(payload);
  const acl = evaluateAcl(intent);
  const filename = `${isoSafe(payload.timestamp)}_${intent.command_name}_${payload.id}.json`;

  if (acl.decision === "quarantine") {
    const filePath = path.join(quarantineDir, filename);
    await writeJson(filePath, { ...intent, route_decision: "quarantine", quarantine_reason: acl.reason });
    return { route: "quarantine", filePath };
  }

  const status = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_status.json"), "utf8"));
  if (status.type === "waiting_on_approval" && intent.auth_class === "approval" && intent.source_ref === activeApprovalSourceRef) {
    const filePath = path.join(humanGateDir, filename);
    await writeJson(filePath, {
      ...intent,
      route_decision: "human_gate_candidate",
      approval_source_ref: activeApprovalSourceRef,
    });
    return { route: "human_gate_candidate", filePath };
  }

  if (status.type === "waiting_on_approval") {
    const filePath = path.join(dispatchQueueDir, filename);
    await writeJson(filePath, {
      ...intent,
      route_decision: "dispatch_queue",
      blocked_by: "waiting_on_approval",
    });
    return { route: "dispatch_queue", filePath };
  }

  const filePath = path.join(inboxDir, filename);
  await writeJson(filePath, { ...intent, route_decision: "inbox" });
  return { route: "inbox", filePath };
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

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  approvalRequest: null,
  requests: [],
  files: {},
};

let client = null;
let server;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(dispatchQueueDir, { recursive: true });
  await fs.mkdir(humanGateDir, { recursive: true });
  await fs.mkdir(quarantineDir, { recursive: true });
  await fs.writeFile(ingressLogPath, "");
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(approvalFilePath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("discord_approval_human_gate_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "discord_approval_human_gate_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });

  const turnStart = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Create the file ${approvalFilePath} with exact contents approval-pending-case. ` +
          `Do not modify any other file.`,
      },
    ],
  });
  const turnId = extractTurnId(turnStart);
  const approvalRequest = await client.waitForAnyServerRequest(
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    (msg) => (msg.params?.threadId ?? null) === threadId,
    180_000,
  );
  const activeApprovalSourceRef = `${approvalRequest.method}:${approvalRequest.id}`;
  summary.approvalRequest = {
    id: approvalRequest.id,
    method: approvalRequest.method,
    source_ref: activeApprovalSourceRef,
    params: approvalRequest.params,
  };
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "waiting_on_approval",
    active_approval_source_ref: activeApprovalSourceRef,
  });

  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/discord/interactions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "not_found" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "invalid_json" }));
      return;
    }
    const verification = verifyDiscordStyleRequest({
      publicKey,
      signatureHex: Array.isArray(req.headers["x-signature-ed25519"])
        ? req.headers["x-signature-ed25519"][0]
        : req.headers["x-signature-ed25519"],
      timestamp: Array.isArray(req.headers["x-signature-timestamp"])
        ? req.headers["x-signature-timestamp"][0]
        : req.headers["x-signature-timestamp"],
      rawBody,
      interactionId: payload.id,
      replayCache,
    });
    if (!verification.ok) {
      await appendJsonl(ingressLogPath, { at: new Date().toISOString(), interaction_id: payload.id, verification });
      res.writeHead(verification.httpStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: verification.reason }));
      return;
    }
    const routed = await routeInteraction(payload, activeApprovalSourceRef);
    await appendJsonl(ingressLogPath, {
      at: new Date().toISOString(),
      interaction_id: payload.id,
      verification,
      route: routed.route,
      filePath: routed.filePath,
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, route: routed.route, filePath: routed.filePath }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address missing");
  const baseUrl = `http://127.0.0.1:${address.port}/discord/interactions`;

  const requests = [
    {
      case: "viewer_approve_quarantine",
      payload: {
        id: "discord-approve-001",
        type: 2,
        guild_id: "guild-1",
        channel_id: "alpha-ops",
        timestamp: "2026-03-26T12:00:00+09:00",
        member: { user: { id: "viewer-user-1" }, roles: ["viewer"] },
        data: {
          name: "approve",
          options: [
            { name: "project", value: "project-alpha" },
            { name: "source_ref", value: activeApprovalSourceRef },
          ],
        },
      },
    },
    {
      case: "ops_approve_human_gate",
      payload: {
        id: "discord-approve-002",
        type: 2,
        guild_id: "guild-1",
        channel_id: "alpha-ops",
        timestamp: "2026-03-26T12:00:01+09:00",
        member: { user: { id: "ops-user-1" }, roles: ["ops-admin", "operator"] },
        data: {
          name: "approve",
          options: [
            { name: "project", value: "project-alpha" },
            { name: "source_ref", value: activeApprovalSourceRef },
          ],
        },
      },
    },
    {
      case: "ops_intent_deferred",
      payload: {
        id: "discord-intent-003",
        type: 2,
        guild_id: "guild-1",
        channel_id: "alpha-ops",
        timestamp: "2026-03-26T12:00:02+09:00",
        member: { user: { id: "ops-user-2" }, roles: ["ops-admin", "operator"] },
        data: {
          name: "intent",
          options: [
            { name: "project", value: "project-alpha" },
            { name: "request", value: "unrelated follow-up while approval pending" },
          ],
        },
      },
    },
  ];

  for (const entry of requests) {
    const rawBody = JSON.stringify(entry.payload);
    const timestamp = String(nowEpochSeconds());
    const signature = signInteraction(privateKey, timestamp, rawBody);
    const response = await httpPost(baseUrl, rawBody, {
      "x-signature-timestamp": timestamp,
      "x-signature-ed25519": signature,
    });
    summary.requests.push({ case: entry.case, response });
  }

  await client.respond(approvalRequest.id, { decision: "cancel" });
  const completed = await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 240_000);
  summary.turnCompleted = completed.params ?? completed;
  summary.files = {
    inbox: await readDirSafe(inboxDir),
    dispatchQueue: await readDirSafe(dispatchQueueDir),
    humanGateCandidates: await readDirSafe(humanGateDir),
    quarantine: await readDirSafe(quarantineDir),
    fileExistsAfterCancel: (await fs.readFile(approvalFilePath).then(() => true).catch(() => false)),
  };
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.requests.every((entry) => entry.response.status === 202) &&
    summary.files.inbox.length === 0 &&
    summary.files.dispatchQueue.length === 1 &&
    summary.files.humanGateCandidates.length === 1 &&
    summary.files.quarantine.length === 1 &&
    summary.files.fileExistsAfterCancel === false
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = String(error);
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord approval human gate probe failed");
}
