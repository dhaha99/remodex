import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_operator_roundtrip_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const processedDir = path.join(projectRoot, "processed");
const routerRoot = path.join(probeRoot, "router");
const ingressLogPath = path.join(routerRoot, "ingress_log.jsonl");
const dispatchLogPath = path.join(probeRoot, "dispatch_log.jsonl");
const eventsLogPath = path.join(verificationDir, "discord_operator_roundtrip_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "discord_operator_roundtrip_probe_summary.json");
const targetPath = path.join(verificationDir, "discord_roundtrip_target.txt");
const wrongPath = path.join(verificationDir, "discord_roundtrip_wrong.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  clearAllWaiters() {
    for (const waiter of this.notificationWaiters) clearTimeout(waiter.timer);
    this.notificationWaiters = [];
  }

  close() {
    this.ws?.close();
  }
}

function extractTurnId(result) {
  return result?.turn?.id ?? result?.turnId ?? result?.id ?? null;
}

function turnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const content = await readIfExists(filePath);
    if (content !== null) return content;
    await sleep(250);
  }
  return null;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
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

function normalizeIntentPayload(payload) {
  const options = payload.data?.options ?? [];
  return {
    source: "discord",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: payload.member?.roles ?? [],
    command_name: payload.data?.name ?? null,
    workspace_key: "remodex",
    project_key: options.find((option) => option.name === "project")?.value ?? null,
    request: options.find((option) => option.name === "request")?.value ?? null,
    source_ref: payload.id,
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
  if (!roles.has("ops-admin")) {
    return { decision: "quarantine", reason: "unauthorized_operator" };
  }
  return { decision: "route", reason: null };
}

async function routePayload(payload) {
  const intent = normalizeIntentPayload(payload);
  const acl = evaluateAcl(intent);
  const filename = `${isoSafe(payload.timestamp)}_${intent.command_name}_${intent.source_ref}.json`;
  if (acl.decision !== "route") {
    const filePath = path.join(routerRoot, "quarantine", filename);
    await writeJson(filePath, {
      ...intent,
      route_decision: "quarantine",
      quarantine_reason: acl.reason,
    });
    return { route: "quarantine", filePath };
  }

  const filePath = path.join(inboxDir, filename);
  await writeJson(filePath, {
    ...intent,
    type: "operator_intent",
    route_decision: "route",
    operator_answer: intent.request,
  });
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

async function bridgeDispatch(client) {
  const binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    throw new Error("no inbox file to dispatch");
  }
  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  const turnStart = await client.request("turn/start", {
    threadId: binding.threadId,
    input: [{ type: "text", text: event.operator_answer }],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("bridge dispatched turn id missing");
  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  await appendJsonl(dispatchLogPath, {
    at: new Date().toISOString(),
    threadId: binding.threadId,
    inboxFile,
    turnId,
    correlation_key: event.correlation_key,
  });
  await writeJson(path.join(processedDir, inboxFile), {
    workspace_key: event.workspace_key,
    project_key: event.project_key,
    source_ref: event.source_ref,
    correlation_key: event.correlation_key,
    processed_at: new Date().toISOString(),
    processed_by: "discord_roundtrip_bridge_probe",
    disposition: "consumed",
    origin: "direct_delivery",
  });
  await fs.rm(inboxPath, { force: true });
  return { turnId, completed: completed.params ?? completed, correlationKey: event.correlation_key };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  questionTurnId: null,
  transport: null,
  bridgeDispatch: null,
  finalFiles: null,
};

let server;
let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(routerRoot, { recursive: true });
  await fs.writeFile(ingressLogPath, "");
  await fs.writeFile(dispatchLogPath, "");
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(targetPath, { force: true });
  await fs.rm(wrongPath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("discord_operator_roundtrip_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "discord_operator_roundtrip_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });

  const questionTurn = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question about ${targetPath}. ` +
          `Then stop and wait for my next turn. Do not create ${targetPath} or ${wrongPath} yet.`,
      },
    ],
  });
  const questionTurnId = extractTurnId(questionTurn);
  if (!questionTurnId) throw new Error("question turn id missing");
  summary.questionTurnId = questionTurnId;
  await client.waitForNotification("turn/completed", turnPredicate(questionTurnId), 180_000);

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
      await appendJsonl(ingressLogPath, {
        at: new Date().toISOString(),
        interaction_id: payload.id,
        verification,
      });
      res.writeHead(verification.httpStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: verification.reason }));
      return;
    }

    const routed = await routePayload(payload);
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

  const payload = {
    id: "discord-roundtrip-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "alpha-ops",
    timestamp: "2026-03-26T11:00:00+09:00",
    member: {
      user: { id: "ops-user-roundtrip" },
      roles: ["ops-admin", "operator"],
    },
    data: {
      name: "intent",
      options: [
        { name: "project", value: "project-alpha" },
        {
          name: "request",
          value:
            `Answer to your last question: create only ${targetPath} with exact contents discord-roundtrip-ok\\n. ` +
            `Do not create ${wrongPath}.`,
        },
      ],
    },
  };
  const rawBody = JSON.stringify(payload);
  const timestamp = String(nowEpochSeconds());
  const signature = signInteraction(privateKey, timestamp, rawBody);
  summary.transport = await httpPost(baseUrl, rawBody, {
    "x-signature-timestamp": timestamp,
    "x-signature-ed25519": signature,
  });

  summary.bridgeDispatch = await bridgeDispatch(client);
  summary.finalFiles = {
    target: await waitForFile(targetPath, 15_000),
    wrong: await readIfExists(wrongPath),
  };
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.transport?.status === 202 &&
    summary.bridgeDispatch?.completed?.turn?.status === "completed" &&
    summary.finalFiles.target === "discord-roundtrip-ok\n" &&
    summary.finalFiles.wrong === null
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
  client?.clearAllWaiters();
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord operator roundtrip probe failed");
}
