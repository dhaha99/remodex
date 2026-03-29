import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const eventsLogPath = path.join(verificationDir, "app_server_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "app_server_probe_summary.json");
const threadFile1 = path.join(verificationDir, "from_thread_turn1.txt");
const threadFile2 = path.join(verificationDir, "from_thread_turn2.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JsonRpcWsClient {
  constructor(url) {
    this.url = url;
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
      } catch (error) {
        console.error("invalid json from app-server", text);
        return;
      }
      await fs.appendFile(eventsLogPath, `${JSON.stringify(msg)}\n`);

      if (msg.id !== undefined) {
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
    if (!this.ws) return;
    this.ws.close();
  }
}

function extractTurnId(result) {
  return (
    result?.turn?.id ??
    result?.id ??
    result?.turnId ??
    null
  );
}

function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual =
      params?.turn?.id ??
      params?.turnId ??
      params?.id ??
      null;
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

async function waitForFile(filePath, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const content = await readIfExists(filePath);
    if (content !== null) return content;
    await sleep(500);
  }
  return null;
}

const client = new JsonRpcWsClient(wsUrl);

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  turn1: null,
  turn2: null,
  eventCounts: {},
};

try {
  await client.connect();

  await client.request("initialize", {
    clientInfo: {
      name: "remodex_probe",
      title: "Remodex Probe",
      version: "0.1.0",
    },
  });
  client.notify("initialized", {});

  const threadResult = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_probe",
  });

  const threadId = threadResult?.thread?.id ?? null;
  if (!threadId) throw new Error("thread/start did not return thread id");
  summary.threadId = threadId;

  const turn1Result = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `In the current workspace, create the file ${threadFile1} with exact contents turn1\\n` +
          `Do not modify any other file. After the file is written, briefly confirm the path.`,
      },
    ],
  });
  const turn1Id = extractTurnId(turn1Result);
  const turn1Completed = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(turn1Id),
    240_000,
  );
  const turn1Content = await waitForFile(threadFile1);
  summary.turn1 = {
    turnId: turn1Id,
    completed: turn1Completed.params ?? turn1Completed,
    fileContent: turn1Content,
    fileExists: turn1Content !== null,
  };

  const turn2Result = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Use the same thread context. First, append a second line turn2 to ${threadFile1}. ` +
          `Second, create ${threadFile2} with exact contents second-file. ` +
          `Do not modify any other file. After finishing, briefly confirm both paths.`,
      },
    ],
  });
  const turn2Id = extractTurnId(turn2Result);
  const turn2Completed = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(turn2Id),
    240_000,
  );
  const turn1After = await waitForFile(threadFile1);
  const turn2Content = await waitForFile(threadFile2);
  summary.turn2 = {
    turnId: turn2Id,
    completed: turn2Completed.params ?? turn2Completed,
    file1ContentAfterTurn2: turn1After,
    file2Content: turn2Content,
    file2Exists: turn2Content !== null,
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = {
    message: error instanceof Error ? error.message : String(error),
  };
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client.close();
}
