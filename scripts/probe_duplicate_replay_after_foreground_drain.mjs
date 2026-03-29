import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "duplicate_replay_after_foreground_drain_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const processedDir = path.join(projectRoot, "processed");
const dispatchQueueDir = path.join(projectRoot, "dispatch_queue");
const summaryPath = path.join(verificationDir, "duplicate_replay_after_foreground_drain_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "duplicate_replay_after_foreground_drain_probe_events.jsonl");
const targetPath = path.join(verificationDir, "duplicate_replay_target.txt");
const wrongPath = path.join(verificationDir, "duplicate_replay_wrong.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function bridgeDeferIfForeground() {
  const toggle = JSON.parse(await fs.readFile(path.join(stateDir, "background_trigger_toggle.json"), "utf8"));
  const status = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_status.json"), "utf8"));
  const binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) return { decision: "no_inbox" };

  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));

  if (toggle.foreground_session_active || !toggle.background_trigger_enabled || !["idle", "checkpoint_open"].includes(status.type)) {
    const ticketPath = path.join(dispatchQueueDir, inboxFile);
    await fs.mkdir(dispatchQueueDir, { recursive: true });
    await writeJson(ticketPath, {
      deferred_from: inboxPath,
      thread_id: binding.threadId,
      correlation_key: event.correlation_key,
      operator_answer: event.operator_answer,
    });
    return { decision: "deferred", ticketPath, inboxFile };
  }

  return { decision: "unexpected_dispatch" };
}

async function runTurnFromText(client, threadId, text) {
  const readResult = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const resumeResult = await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  const turnStart = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("turn id missing");
  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  return {
    readTurnCount: (readResult?.thread?.turns ?? []).length,
    resumeTurnCount: (resumeResult?.thread?.turns ?? []).length,
    turnId,
    completed: completed.params ?? completed,
  };
}

async function foregroundDrain(client) {
  const binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  const queueFiles = (await fs.readdir(dispatchQueueDir)).filter((name) => name.endsWith(".json")).sort();
  if (queueFiles.length === 0) return { decision: "no_dispatch_ticket" };

  const queueFile = queueFiles[0];
  const queuePath = path.join(dispatchQueueDir, queueFile);
  const ticket = JSON.parse(await fs.readFile(queuePath, "utf8"));
  const turn = await runTurnFromText(client, binding.threadId, ticket.operator_answer);
  await fs.mkdir(processedDir, { recursive: true });
  await fs.rename(queuePath, path.join(processedDir, queueFile));
  return { decision: "drained", queueFile, ...turn };
}

async function recoveryReplayInbox(client) {
  const binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) return { decision: "no_inbox_left" };

  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  const turn = await runTurnFromText(client, binding.threadId, event.operator_answer);
  return { decision: "replayed_from_inbox", inboxFile, ...turn };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  questionTurnId: null,
  bridgeDecision: null,
  firstDrain: null,
  replayDecision: null,
  finalFiles: null,
};

let seedClient = null;
let drainClient = null;
let replayClient = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [targetPath, wrongPath]) {
    await fs.rm(filePath, { force: true });
  }

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.mkdir(dispatchQueueDir, { recursive: true });

  seedClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await seedClient.connect();
  await seedClient.initialize("remodex_duplicate_replay_seed");

  const threadStart = await seedClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_duplicate_replay_seed",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "idle",
    activeFlags: [],
  });
  await writeJson(path.join(stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: true,
    foreground_lock_enabled: true,
    mode: "foreground",
  });

  const questionTurn = await seedClient.request("turn/start", {
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
  await seedClient.waitForNotification("turn/completed", turnPredicate(questionTurnId), 180_000);

  await writeJson(path.join(inboxDir, "2026-03-26T09-40-00+09-00_operator_answer.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    correlation_key: "duplicate-replay-after-drain-001",
    operator_answer:
      `Answer to your last question: append exactly one new line duplicate-replay-evidence to ${targetPath} every time you process this answer, ` +
      `even if the file already exists and already contains that line. Do not create or modify ${wrongPath}.`,
  });

  summary.bridgeDecision = await bridgeDeferIfForeground();

  drainClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await drainClient.connect();
  await drainClient.initialize("remodex_duplicate_replay_drain");
  summary.firstDrain = await foregroundDrain(drainClient);

  replayClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await replayClient.connect();
  await replayClient.initialize("remodex_duplicate_replay_router");
  summary.replayDecision = await recoveryReplayInbox(replayClient);

  const finalTarget = await waitForFile(targetPath, 15_000);
  summary.finalFiles = {
    target: finalTarget,
    wrong: await readIfExists(wrongPath),
  };
  const lines = finalTarget?.split("\n").filter(Boolean) ?? [];
  summary.targetLineCount = lines.length;
  summary.duplicateObserved = summary.replayDecision?.decision === "replayed_from_inbox" && lines.length >= 2;

  const combined = new Map();
  for (const currentClient of [seedClient, drainClient, replayClient]) {
    if (!currentClient) continue;
    for (const [key, value] of currentClient.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.bridgeDecision?.decision === "deferred" &&
    summary.firstDrain?.decision === "drained" &&
    summary.replayDecision?.decision === "replayed_from_inbox" &&
    summary.finalFiles.wrong === null &&
    summary.duplicateObserved === true
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  const combined = new Map();
  for (const currentClient of [seedClient, drainClient, replayClient]) {
    if (!currentClient) continue;
    for (const [key, value] of currentClient.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  seedClient?.clearAllWaiters();
  drainClient?.clearAllWaiters();
  replayClient?.clearAllWaiters();
  seedClient?.close();
  drainClient?.close();
  replayClient?.close();
}
