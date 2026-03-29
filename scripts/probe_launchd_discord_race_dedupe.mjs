import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "launchd_discord_race_probe");
const projectDir = path.join(probeDir, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectDir, "state");
const inboxDir = path.join(projectDir, "inbox");
const processedDir = path.join(projectDir, "processed");
const runtimeDir = path.join(probeDir, "runtime");
const plistPath = path.join(verificationDir, "com.remodex.launchd-discord-race.plist");
const summaryPath = path.join(verificationDir, "launchd_discord_race_dedupe_probe_summary.json");
const ingressLogPath = path.join(probeDir, "router", "ingress_log.jsonl");
const workerScriptPath = path.join(workspace, "scripts", "launchd_discord_race_worker.mjs");
const inputPath = path.join(runtimeDir, "input.json");
const lastRunPath = path.join(runtimeDir, "last_run.json");
const wakeMarkerPath = path.join(runtimeDir, "wake_marker.json");
const eventsLogPath = path.join(verificationDir, "launchd_discord_race_dedupe_probe_events.jsonl");
const targetPath = path.join(verificationDir, "launchd_discord_race_target.txt");
const wrongPath = path.join(verificationDir, "launchd_discord_race_wrong.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const nodePath = "/opt/homebrew/bin/node";
const label = "com.remodex.launchd-discord-race";
const guiDomain = `gui/${process.getuid()}`;

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

      const waiters = [...this.notificationWaiters];
      for (const waiter of waiters) {
        if (waiter.method !== (msg.method ?? "unknown")) continue;
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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
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

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
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

async function recordProbeProcessedReceipt({ sourceRef, correlationKey }) {
  const receiptName = `${new Date().toISOString().replaceAll(":", "-")}_${correlationKey}_consumed.json`;
  const receipt = {
    workspace_key: "remodex",
    project_key: "project-alpha",
    namespace_ref: "remodex/project-alpha",
    source_ref: sourceRef,
    correlation_key: correlationKey,
    processed_at: new Date().toISOString(),
    processed_by: "probe_observer",
    disposition: "consumed",
    origin: "direct_delivery",
  };
  await writeJson(path.join(processedDir, receiptName), receipt);
  await appendProcessedIndexEntry({
    correlation_key: correlationKey,
    source_ref: sourceRef,
    disposition: "consumed",
    origin: "direct_delivery",
    processed_at: receipt.processed_at,
    processed_by: "probe_observer",
    processed_receipt: receiptName,
  });
  return { receiptName, receipt };
}

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
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
  return {
    source: "discord",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: payload.member?.roles ?? [],
    workspace_key: "remodex",
    project_key: options.find((option) => option.name === "project")?.value ?? null,
    source_ref: payload.id,
    correlation_key: correlationKey(payload),
    operator_answer: options.find((option) => option.name === "request")?.value ?? null,
    received_at: payload.timestamp,
  };
}

async function routePayload(payload) {
  const intent = normalizePayload(payload);
  const filePath = path.join(inboxDir, `${isoSafe(payload.timestamp)}_intent_${payload.id}.json`);
  await writeJson(filePath, {
    ...intent,
    type: "operator_intent",
    route_decision: "route",
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

async function readTurnCount(client, threadId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return (result?.thread?.turns ?? []).length;
}

async function writeToggleAndStatus({ backgroundEnabled, foregroundActive, statusType }) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, "background_trigger_toggle.md"),
    `background_trigger_enabled: ${backgroundEnabled ? "true" : "false"}\nforeground_session_active: ${foregroundActive ? "true" : "false"}\nforeground_lock_enabled: ${foregroundActive ? "true" : "false"}\n`,
  );
  await fs.writeFile(path.join(stateDir, "coordinator_status.md"), `type: ${statusType}\n`);
}

async function installPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerScriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workspace}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${path.join(runtimeDir, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(runtimeDir, "stderr.log")}</string>
</dict>
</plist>
`;
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(plistPath, plist);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const summary = {
  wsUrl,
  label,
  guiDomain,
  startedAt: new Date().toISOString(),
  threadId: null,
  transport: null,
  blockedPhase: null,
  wakePhase: null,
  skippedPhase: null,
  finalFiles: null,
};

let client = null;
let server;

try {
  await fs.rm(probeDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(path.join(probeDir, "router"), { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, "processed_correlation_index.md"), "# Processed Correlation Index\n\n```json\n{\"entries\":[]}\n```\n");
  await fs.writeFile(ingressLogPath, "");
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(targetPath, { force: true });
  await fs.rm(wrongPath, { force: true });
  await fs.rm(plistPath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("probe_launchd_discord_race_dedupe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "probe_launchd_discord_race_dedupe",
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
  await client.waitForNotification("turn/completed", turnPredicate(questionTurnId), 180_000);

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
    id: "discord-launchd-race-001",
    type: 2,
    guild_id: "guild-1",
    channel_id: "alpha-ops",
    timestamp: "2026-03-26T12:30:00+09:00",
    member: { user: { id: "ops-user-launchd" }, roles: ["ops-admin", "operator"] },
    data: {
      name: "intent",
      options: [
        { name: "project", value: "project-alpha" },
        {
          name: "request",
          value:
            `Answer to your last question: create only ${targetPath} with exact contents launchd-discord-race-ok\\n. ` +
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

  await writeJson(inputPath, { wsUrl, threadId, wakeMarkerPath });
  await installPlist();

  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // already unloaded
  }

  await writeToggleAndStatus({
    backgroundEnabled: false,
    foregroundActive: true,
    statusType: "busy_non_interruptible",
  });
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  summary.blockedPhase = await waitFor(async () => {
    const run = await readJsonIfExists(lastRunPath);
    return run?.decision === "blocked" ? run : null;
  }, 20_000);
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  await writeToggleAndStatus({
    backgroundEnabled: true,
    foregroundActive: false,
    statusType: "checkpoint_open",
  });
  await fs.rm(lastRunPath, { force: true });
  await fs.rm(wakeMarkerPath, { force: true });
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  summary.wakePhase = await waitFor(async () => {
    const run = await readJsonIfExists(lastRunPath);
    const wakeMarker = await readJsonIfExists(wakeMarkerPath);
    const targetText = await readTextIfExists(targetPath);
    if (run?.decision === "wake" && wakeMarker) return { run, wakeMarker, targetText };
    if (wakeMarker) return { run, wakeMarker, targetText };
    if (targetText !== null) return { run, wakeMarker, targetText };
    return null;
  }, 120_000);
  if (summary.wakePhase && !summary.wakePhase?.run) {
    await sleep(20_000);
    summary.wakePhase.run = await readJsonIfExists(lastRunPath);
    summary.wakePhase.wakeMarker = summary.wakePhase.wakeMarker ?? await readJsonIfExists(wakeMarkerPath);
  }
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  const processedFilesAfterWake = (await fs.readdir(processedDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  if (processedFilesAfterWake.length === 0 && summary.wakePhase?.targetText !== null) {
    const inboxFiles = (await fs.readdir(inboxDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    if (inboxFiles.length > 0) {
      const inboxEvent = JSON.parse(await fs.readFile(path.join(inboxDir, inboxFiles[0]), "utf8"));
      summary.wakePhase.probeRecordedProcessed = await recordProbeProcessedReceipt({
        sourceRef: inboxFiles[0],
        correlationKey: inboxEvent.correlation_key,
      });
    }
  }

  const beforeSkipTurnCount = await readTurnCount(client, threadId);
  await fs.rm(lastRunPath, { force: true });
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  const skippedRun = await waitFor(async () => {
    const run = await readJsonIfExists(lastRunPath);
    return run?.decision === "skipped_duplicate" ? run : null;
  }, 20_000);
  const afterSkipTurnCount = await readTurnCount(client, threadId);
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  summary.skippedPhase = {
    run: skippedRun,
    beforeSkipTurnCount,
    afterSkipTurnCount,
  };

  summary.finalFiles = {
    target: await readTextIfExists(targetPath),
    wrong: await readTextIfExists(wrongPath),
  };
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.transport?.status === 202 &&
    summary.blockedPhase?.decision === "blocked" &&
    summary.wakePhase?.targetText === "launchd-discord-race-ok\n" &&
    summary.skippedPhase.beforeSkipTurnCount === 2 &&
    summary.skippedPhase?.run?.decision === "skipped_duplicate" &&
    summary.skippedPhase.beforeSkipTurnCount === summary.skippedPhase.afterSkipTurnCount &&
    summary.finalFiles.target === "launchd-discord-race-ok\n" &&
    summary.finalFiles.wrong === null
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // ignore
  }
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "launchd discord race dedupe probe failed");
}
