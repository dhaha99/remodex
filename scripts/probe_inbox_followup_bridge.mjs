import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "inbox_followup_bridge_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const processedDir = path.join(projectRoot, "processed");
const dispatchLogPath = path.join(probeRoot, "dispatch_log.jsonl");
const eventsLogPath = path.join(verificationDir, "inbox_followup_bridge_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "inbox_followup_bridge_probe_summary.json");
const optionAPath = path.join(verificationDir, "bridge_followup_option_a.txt");
const optionBPath = path.join(verificationDir, "bridge_followup_option_b.txt");
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
      clientInfo: {
        name,
        title: name,
        version: "0.1.0",
      },
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
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
    }
    this.notificationWaiters = [];
  }

  close() {
    if (!this.ws) return;
    this.ws.close();
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

async function runBridgeDispatch(client) {
  const binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    return null;
  }

  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));

  const turnStart = await client.request("turn/start", {
    threadId: binding.threadId,
    input: [
      {
        type: "text",
        text: event.operator_answer,
      },
    ],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("bridge-dispatched turn id missing");
  await fs.appendFile(
    dispatchLogPath,
    `${JSON.stringify({ dispatchedAt: new Date().toISOString(), inboxFile, threadId: binding.threadId, turnId })}\n`,
  );

  await fs.rename(inboxPath, path.join(processedDir, inboxFile));
  return turnId;
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  questionTurn: null,
  bridgeDispatch: null,
  finalFiles: {
    optionA: null,
    optionB: null,
  },
};

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.writeFile(dispatchLogPath, "");
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(optionAPath, { force: true });
  await fs.rm(optionBPath, { force: true });

  await client.connect();
  await client.initialize("remodex_inbox_followup_bridge_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_inbox_followup_bridge_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await fs.writeFile(
    path.join(stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ projectKey: "project-alpha", threadId }, null, 2)}\n`,
  );

  const questionTurnStart = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question: should you create ${optionAPath} ` +
          `or ${optionBPath}? Then stop and wait for my next turn. Do not create either file yet.`,
      },
    ],
  });
  const questionTurnId = extractTurnId(questionTurnStart);
  if (!questionTurnId) throw new Error("question turn id missing");
  const questionCompleted = await client.waitForNotification(
    "turn/completed",
    turnPredicate(questionTurnId),
    180_000,
  );
  summary.questionTurn = {
    turnId: questionTurnId,
    completed: questionCompleted.params ?? questionCompleted,
  };

  const inboxEventName = "2026-03-25T13-20-00+09-00_operator_answer.json";
  await fs.writeFile(
    path.join(inboxDir, inboxEventName),
    `${JSON.stringify({
      workspace_key: "remodex",
      project_key: "project-alpha",
      correlation_key: "followup-answer-001",
      operator_answer:
        `Answer to your last question: choose ${optionBPath}. ` +
        `Create only ${optionBPath} with exact contents bridge-answer-ok\\n. ` +
        `Do not create ${optionAPath}.`,
    }, null, 2)}\n`,
  );

  const dispatchedTurnId = await runBridgeDispatch(client);
  if (!dispatchedTurnId) throw new Error("bridge dispatch produced no turn");
  const dispatchedCompleted = await client.waitForNotification(
    "turn/completed",
    turnPredicate(dispatchedTurnId),
    240_000,
  );

  summary.bridgeDispatch = {
    turnId: dispatchedTurnId,
    completed: dispatchedCompleted.params ?? dispatchedCompleted,
  };

  summary.finalFiles.optionA = await readIfExists(optionAPath);
  summary.finalFiles.optionB = await waitForFile(optionBPath, 15_000);
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.finalFiles.optionA === null &&
    summary.finalFiles.optionB === "bridge-answer-ok\n"
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client.clearAllWaiters();
  client.close();
}
