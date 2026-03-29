import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_human_gate_processed_recovery_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const dispatchQueueDir = path.join(projectRoot, "dispatch_queue");
const humanGateDir = path.join(projectRoot, "human_gate_candidates");
const processedDir = path.join(projectRoot, "processed");
const quarantineDir = path.join(probeRoot, "router", "quarantine");
const ingressLogPath = path.join(probeRoot, "router", "ingress_log.jsonl");
const eventsLogPath = path.join(verificationDir, "discord_human_gate_processed_recovery_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "discord_human_gate_processed_recovery_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const approvedFilePath = path.join(verificationDir, "discord_human_gate_processed_recovery_accepted.txt");
const wrongFilePath = path.join(verificationDir, "discord_human_gate_processed_recovery_wrong.txt");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    this.serverRequestQueue = [];
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
        let consumed = false;
        for (const waiter of waiters) {
          if (!waiter.methods.includes(msg.method)) continue;
          if (!waiter.predicate(msg)) continue;
          waiter.resolve(msg);
          this.serverRequestWaiters = this.serverRequestWaiters.filter((candidate) => candidate !== waiter);
          consumed = true;
          break;
        }
        if (!consumed) this.serverRequestQueue.push(msg);
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
      };
      this.notificationWaiters.push(entry);
    });
  }

  waitForAnyServerRequest(methods, predicate = () => true, timeoutMs = 180_000) {
    const queuedIndex = this.serverRequestQueue.findIndex(
      (msg) => methods.includes(msg.method) && predicate(msg),
    );
    if (queuedIndex >= 0) {
      const [msg] = this.serverRequestQueue.splice(queuedIndex, 1);
      return Promise.resolve(msg);
    }
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

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readDirSafe(dirPath) {
  try {
    return (await fs.readdir(dirPath)).sort();
  } catch {
    return [];
  }
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

function renderProcessedIndex(entries) {
  return [
    "# Processed Correlation Index",
    "",
    "```json",
    JSON.stringify({ entries }, null, 2),
    "```",
    "",
  ].join("\n");
}

async function readProcessedIndexEntries() {
  const text = await readTextIfExists(path.join(stateDir, "processed_correlation_index.md"));
  if (!text) return [];
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return [];
  const parsed = JSON.parse(match[1]);
  return parsed.entries ?? [];
}

async function appendProcessedIndexEntry(entry) {
  const entries = await readProcessedIndexEntries();
  entries.push(entry);
  await fs.writeFile(path.join(stateDir, "processed_correlation_index.md"), renderProcessedIndex(entries));
  return entries;
}

async function recordProcessedReceipt({ sourceRef, correlationKey, disposition, origin, processedBy }) {
  const receiptName = `${new Date().toISOString().replaceAll(":", "-")}_${correlationKey}_${disposition}.json`;
  const receipt = {
    workspace_key: "remodex",
    project_key: "project-alpha",
    namespace_ref: "remodex/project-alpha",
    source_ref: sourceRef,
    correlation_key: correlationKey,
    processed_at: new Date().toISOString(),
    processed_by: processedBy,
    disposition,
    origin,
  };
  await writeJson(path.join(processedDir, receiptName), receipt);
  const indexEntries = await appendProcessedIndexEntry({
    correlation_key: correlationKey,
    source_ref: sourceRef,
    disposition,
    origin,
    processed_at: receipt.processed_at,
    processed_by: processedBy,
    processed_receipt: receiptName,
  });
  return { receiptName, receipt, indexEntries };
}

async function readTurnCount(client, threadId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return (result?.thread?.turns ?? []).length;
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
  if (!intent.project_key) return { decision: "quarantine", reason: "missing_project" };
  if (intent.project_key !== "project-alpha") return { decision: "quarantine", reason: "unknown_project" };
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

async function waitForAnyApproval(client, threadId, timeoutMs = 180_000) {
  return client.waitForAnyServerRequest(
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    (msg) => (msg.params?.threadId ?? null) === threadId,
    timeoutMs,
  );
}

async function recoveryDecisionFromProcessed(candidateFile) {
  const candidate = await readJson(path.join(humanGateDir, candidateFile));
  const receipts = await readDirSafe(processedDir);
  const indexEntries = await readProcessedIndexEntries();
  const duplicateInIndex = indexEntries.some((entry) => entry.correlation_key === candidate.correlation_key);
  const duplicateInReceipt = await (async () => {
    for (const name of receipts) {
      const receipt = await readJson(path.join(processedDir, name));
      if (receipt.correlation_key === candidate.correlation_key) return true;
    }
    return false;
  })();
  return {
    decision: duplicateInIndex || duplicateInReceipt ? "skipped_duplicate_human_gate" : "would_reprocess",
    candidate,
    duplicateInIndex,
    duplicateInReceipt,
    processedFiles: receipts,
    indexEntries,
  };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  approvalRequest: null,
  humanGateCandidate: null,
  operatorApprove: null,
  followupApprovals: [],
  completedTurn: null,
  processed: null,
  recovery: null,
  files: {},
};

let client = null;
let server;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  for (const dirPath of [stateDir, inboxDir, dispatchQueueDir, humanGateDir, processedDir, quarantineDir]) {
    await fs.mkdir(dirPath, { recursive: true });
  }
  await fs.writeFile(ingressLogPath, "");
  await fs.writeFile(eventsLogPath, "");
  await fs.writeFile(path.join(stateDir, "processed_correlation_index.md"), renderProcessedIndex([]));
  await fs.rm(approvedFilePath, { force: true });
  await fs.rm(wrongFilePath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("discord_human_gate_processed_recovery_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "discord_human_gate_processed_recovery_probe",
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
          `Create only ${approvedFilePath} with exact contents human-gate-processed-ok\\n. ` +
          `Do not create ${wrongFilePath} and do not modify any other file.`,
      },
    ],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("turn id missing");

  const approvalRequest = await waitForAnyApproval(client, threadId, 180_000);
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
    for await (const chunk of req) chunks.push(chunk);
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

  const approvePayload = {
    id: "discord-hg-processed-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "alpha-ops",
    timestamp: "2026-03-26T13:20:00+09:00",
    member: { user: { id: "ops-user-processed-1" }, roles: ["ops-admin", "operator"] },
    data: {
      name: "approve",
      options: [
        { name: "project", value: "project-alpha" },
        { name: "source_ref", value: activeApprovalSourceRef },
      ],
    },
  };
  const rawBody = JSON.stringify(approvePayload);
  const timestamp = String(nowEpochSeconds());
  const signature = signInteraction(privateKey, timestamp, rawBody);
  summary.operatorApprove = await httpPost(baseUrl, rawBody, {
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": signature,
  });

  const candidateFile = await waitFor(async () => {
    const files = await readDirSafe(humanGateDir);
    return files.length > 0 ? files[0] : null;
  }, 15_000);
  if (!candidateFile) throw new Error("human gate candidate not created");
  const candidate = await readJson(path.join(humanGateDir, candidateFile));
  summary.humanGateCandidate = {
    file: candidateFile,
    payload: candidate,
  };
  if (candidate.approval_source_ref !== activeApprovalSourceRef) {
    throw new Error("human gate candidate source_ref mismatch");
  }

  await client.respond(approvalRequest.id, { decision: "accept" });

  let completed = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      completed = await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 10_000);
      break;
    } catch {
      const extraApproval = await waitForAnyApproval(client, threadId, 2_000).catch(() => null);
      if (!extraApproval) continue;
      summary.followupApprovals.push({
        id: extraApproval.id,
        method: extraApproval.method,
        params: extraApproval.params,
      });
      await client.respond(extraApproval.id, { decision: "accept" });
    }
  }
  if (!completed) {
    completed = await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 120_000);
  }
  summary.completedTurn = completed.params ?? completed;

  summary.processed = await recordProcessedReceipt({
    sourceRef: candidateFile,
    correlationKey: candidate.correlation_key,
    disposition: "consumed_human_gate",
    origin: "human_gate_candidate",
    processedBy: "foreground_main_probe",
  });

  const beforeRecoveryTurnCount = await readTurnCount(client, threadId);
  summary.recovery = await recoveryDecisionFromProcessed(candidateFile);
  const afterRecoveryTurnCount = await readTurnCount(client, threadId);
  summary.recovery.beforeTurnCount = beforeRecoveryTurnCount;
  summary.recovery.afterTurnCount = afterRecoveryTurnCount;

  summary.files = {
    inbox: await readDirSafe(inboxDir),
    dispatchQueue: await readDirSafe(dispatchQueueDir),
    humanGateCandidates: await readDirSafe(humanGateDir),
    quarantine: await readDirSafe(quarantineDir),
    processed: await readDirSafe(processedDir),
    approved: await readTextIfExists(approvedFilePath),
    wrong: await readTextIfExists(wrongFilePath),
  };
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.operatorApprove?.status === 202 &&
    summary.completedTurn?.turn?.status === "completed" &&
    summary.processed?.receipt?.correlation_key === candidate.correlation_key &&
    summary.recovery?.decision === "skipped_duplicate_human_gate" &&
    summary.recovery.beforeTurnCount === summary.recovery.afterTurnCount &&
    summary.files.approved === "human-gate-processed-ok\n" &&
    summary.files.wrong === null &&
    summary.files.processed.length >= 1
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord human gate processed recovery probe failed");
}
