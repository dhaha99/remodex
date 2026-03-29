import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const probeDir =
  process.env.REMODEX_LAUNCHD_PROBE_DIR ??
  path.join(workspace, "verification", "launchd_discord_race_probe");
const projectDir = path.join(probeDir, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectDir, "state");
const inboxDir = path.join(projectDir, "inbox");
const processedDir = path.join(projectDir, "processed");
const runtimeDir = path.join(probeDir, "runtime");
const inputPath = path.join(runtimeDir, "input.json");
const lastRunPath = path.join(runtimeDir, "last_run.json");
const inflightPath = path.join(runtimeDir, "inflight_delivery.json");

class JsonRpcWsClient {
  constructor(url) {
    this.url = url;
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

    this.ws.addEventListener("message", (event) => {
      const text = String(event.data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
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

function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

async function readText(filePath) {
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
  const text = await readText(path.join(stateDir, "processed_correlation_index.md"));
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

function collectBlockedReasons(toggleText, statusText) {
  const reasons = [];
  if (!toggleText?.includes("background_trigger_enabled: true")) reasons.push("background_trigger_disabled");
  if (toggleText?.includes("foreground_session_active: true")) reasons.push("foreground_session_active");
  if (statusText?.includes("busy_non_interruptible")) reasons.push("status_busy_non_interruptible");
  return reasons;
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
  const entries = await appendProcessedIndexEntry({
    correlation_key: correlationKey,
    source_ref: sourceRef,
    disposition,
    origin,
    processed_at: receipt.processed_at,
    processed_by: processedBy,
    processed_receipt: receiptName,
  });
  return { receiptName, receipt, indexEntries: entries };
}

async function readThreadTurn(client, threadId, turnId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const turns = result?.thread?.turns ?? [];
  const turn = turns.find((candidate) => candidate?.id === turnId) ?? null;
  return { thread: result?.thread ?? null, turn };
}

const run = {
  startedAt: new Date().toISOString(),
  decision: null,
  blockedReasons: [],
  turnId: null,
  processed: null,
  error: null,
};

let client = null;

try {
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const toggleText = await readText(path.join(stateDir, "background_trigger_toggle.md"));
  const statusText = await readText(path.join(stateDir, "coordinator_status.md"));
  const blockedReasons = collectBlockedReasons(toggleText, statusText);
  run.blockedReasons = blockedReasons;
  const inflight = await readText(inflightPath).then((text) => (text ? JSON.parse(text) : null));

  const inboxFiles = (await fs.readdir(inboxDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
  if (blockedReasons.length > 0) {
    run.decision = "blocked";
  } else if (inflight) {
    run.decision = "inflight_wait";
    client = new JsonRpcWsClient(input.wsUrl);
    await client.connect();
    await client.initialize("launchd_discord_race_worker_recovery");
    const threadRead = await readThreadTurn(client, inflight.threadId, inflight.turnId);
    run.turnId = inflight.turnId;
    run.inflight = {
      claim: inflight,
      turnStatus: threadRead.turn?.status ?? null,
    };
    if (threadRead.turn?.status === "completed") {
      run.decision = "completed_inflight";
      run.processed = await recordProcessedReceipt({
        sourceRef: inflight.sourceRef,
        correlationKey: inflight.correlationKey,
        disposition: "consumed",
        origin: "direct_delivery",
        processedBy: "launchd_worker_probe",
      });
      await writeJson(input.wakeMarkerPath, {
        created_at: new Date().toISOString(),
        correlation_key: inflight.correlationKey,
        turnId: inflight.turnId,
        recovered_from_inflight: true,
      });
      await fs.rm(path.join(inboxDir, inflight.sourceRef), { force: true });
      await fs.rm(inflightPath, { force: true });
    }
  } else if (inboxFiles.length === 0) {
    run.decision = "idle";
  } else {
    const inboxFile = inboxFiles[0];
    const inboxPath = path.join(inboxDir, inboxFile);
    const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
    const processedFiles = (await fs.readdir(processedDir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
    const indexEntries = await readProcessedIndexEntries();
    const duplicateInIndex = indexEntries.some((entry) => entry.correlation_key === event.correlation_key);
    let duplicateInReceipt = false;
    for (const name of processedFiles) {
      const receipt = JSON.parse(await fs.readFile(path.join(processedDir, name), "utf8"));
      if (receipt.correlation_key === event.correlation_key) {
        duplicateInReceipt = true;
        break;
      }
    }

    if (duplicateInIndex || duplicateInReceipt) {
      run.decision = "skipped_duplicate";
      run.processed = await recordProcessedReceipt({
        sourceRef: event.source_ref,
        correlationKey: event.correlation_key,
        disposition: "skipped_duplicate",
        origin: "recovery_replay",
        processedBy: "launchd_worker_probe",
      });
      await fs.rm(inboxPath, { force: true });
    } else {
      run.decision = "wake";
      client = new JsonRpcWsClient(input.wsUrl);
      await client.connect();
      await client.initialize("launchd_discord_race_worker");
      const turnResult = await client.request("turn/start", {
        threadId: input.threadId,
        input: [{ type: "text", text: event.operator_answer }],
      });
      const turnId = extractTurnId(turnResult);
      run.turnId = turnId;
      await writeJson(inflightPath, {
        threadId: input.threadId,
        turnId,
        sourceRef: inboxFile,
        correlationKey: event.correlation_key,
        startedAt: new Date().toISOString(),
      });
      await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 240_000);
      run.processed = await recordProcessedReceipt({
        sourceRef: inboxFile,
        correlationKey: event.correlation_key,
        disposition: "consumed",
        origin: "direct_delivery",
        processedBy: "launchd_worker_probe",
      });
      await writeJson(input.wakeMarkerPath, {
        created_at: new Date().toISOString(),
        correlation_key: event.correlation_key,
        turnId,
      });
      await fs.rm(inboxPath, { force: true });
      await fs.rm(inflightPath, { force: true });
    }
  }
} catch (error) {
  run.decision = run.decision ?? "error";
  run.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  run.finishedAt = new Date().toISOString();
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(lastRunPath, JSON.stringify(run, null, 2));
  client?.close();
}
