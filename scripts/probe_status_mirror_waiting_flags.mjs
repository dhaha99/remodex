import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const runtimeDir = path.join(verificationDir, "status_mirror_probe");
const runtimeStatePath = path.join(runtimeDir, "coordinator_status.json");
const runtimeHistoryPath = path.join(runtimeDir, "coordinator_status_history.jsonl");
const eventsLogPath = path.join(verificationDir, "status_mirror_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "status_mirror_probe_summary.json");
const outputFilePath = path.join(verificationDir, "status_mirror_accepted.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(verificationDir, { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });

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
    this.serverRequestWaiters = [];
    this.eventCounts = new Map();
    this.notificationHooks = [];
    this.serverRequestHooks = [];
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
        for (const hook of this.serverRequestHooks) {
          await hook(msg);
        }
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

      for (const hook of this.notificationHooks) {
        await hook(msg);
      }

      const waiters = [...this.notificationWaiters];
      for (const waiter of waiters) {
        if (waiter.method !== method) continue;
        if (!waiter.predicate(msg)) continue;
        waiter.resolve(msg);
        this.notificationWaiters = this.notificationWaiters.filter((candidate) => candidate !== waiter);
      }
    });
  }

  onNotification(fn) {
    this.notificationHooks.push(fn);
  }

  onServerRequest(fn) {
    this.serverRequestHooks.push(fn);
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

async function waitForFile(filePath, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const content = await readIfExists(filePath);
    if (content !== null) return content;
    await sleep(250);
  }
  return null;
}

const history = [];
let mirroredThreadId = null;
const approvalMethods = [];
let approvalCount = 0;

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);
client.onNotification(async (msg) => {
  if (msg.method !== "thread/status/changed") return;
  const threadId = msg.params?.threadId ?? null;
  if (!mirroredThreadId || threadId !== mirroredThreadId) return;
  const status = msg.params?.status ?? null;
  const snapshot = {
    observedAt: new Date().toISOString(),
    threadId,
    status,
  };
  history.push(snapshot);
  await fs.writeFile(runtimeStatePath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.appendFile(runtimeHistoryPath, `${JSON.stringify(snapshot)}\n`);
});
client.onServerRequest(async (msg) => {
  const threadId = msg.params?.threadId ?? null;
  if (threadId !== mirroredThreadId) return;
  if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(msg.method)) return;
  approvalMethods.push(msg.method);
  approvalCount += 1;
  await client.respond(msg.id, { decision: "accept" });
});

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  turnId: null,
  approvalMethods: [],
  approvalCount: 0,
  statusesObserved: [],
  waitingOnApprovalSeen: false,
  finalStatusType: null,
  fileExists: false,
  fileContent: null,
};

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.writeFile(runtimeHistoryPath, "");
  await fs.rm(runtimeStatePath, { force: true });
  await fs.rm(outputFilePath, { force: true });

  await client.connect();
  await client.initialize("remodex_status_mirror_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "remodex_status_mirror_probe",
  });
  mirroredThreadId = threadStart?.thread?.id ?? null;
  if (!mirroredThreadId) throw new Error("thread id missing");
  summary.threadId = mirroredThreadId;

  const turnStart = await client.request("turn/start", {
    threadId: mirroredThreadId,
    input: [
      {
        type: "text",
        text:
          `Create the file ${outputFilePath} with exact contents status-mirror-ok\\n. ` +
          "Do not modify any other file. After finishing, briefly confirm the path.",
      },
    ],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("turn id missing");
  summary.turnId = turnId;

  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  const fileContent = await waitForFile(outputFilePath, 10_000);

  summary.completed = completed.params ?? completed;
  summary.approvalMethods = [...approvalMethods];
  summary.approvalCount = approvalCount;
  summary.statusesObserved = history.map((entry) => entry.status);
  summary.waitingOnApprovalSeen = history.some((entry) =>
    Array.isArray(entry.status?.activeFlags) && entry.status.activeFlags.includes("waitingOnApproval"),
  );
  summary.finalStatusType = history.at(-1)?.status?.type ?? null;
  summary.fileExists = fileContent !== null;
  summary.fileContent = fileContent;
  summary.finishedAt = new Date().toISOString();
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.status = "PASS";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client.close();
}
