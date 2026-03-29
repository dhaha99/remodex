import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const stateDir = path.join(verificationDir, "launchd_appserver_probe_state");
const logsDir = path.join(stateDir, "logs");
const summaryPath = path.join(verificationDir, "launchd_appserver_probe_summary.json");
const eventsLogPath = path.join(stateDir, "events.jsonl");
const resultFile = path.join(verificationDir, "from_launchd_appserver.txt");
const previousSummaryPath = path.join(verificationDir, "thread_resume_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(logsDir, { recursive: true });

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

async function waitForFile(filePath, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await sleep(500);
    }
  }
  return null;
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  resume: null,
  turn: null,
  eventCounts: {},
};

let client = null;

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(resultFile, { force: true });

  const previousSummary = JSON.parse(await fs.readFile(previousSummaryPath, "utf8"));
  const threadId = previousSummary?.sourceThreadId ?? previousSummary?.threadId;
  if (!threadId) throw new Error("thread_resume_probe_summary.json does not contain thread id");
  summary.threadId = threadId;

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_launchd_appserver_probe");

  const resumeResult = await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  summary.resume = {
    threadId: resumeResult?.thread?.id ?? null,
    cwd: resumeResult?.cwd ?? null,
    approvalPolicy: resumeResult?.approvalPolicy ?? null,
    resumedTurnCount: (resumeResult?.thread?.turns ?? []).length,
  };

  const turnResult = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Launchd-app-server probe: create the file ${resultFile} with exact contents launchd-appserver-ok. ` +
          `Do not modify any other file. After finishing, briefly confirm only the path.`,
      },
    ],
  });
  const turnId = extractTurnId(turnResult);
  const turnCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(turnId),
    240_000,
  );
  const resultFileContent = await waitForFile(resultFile);

  summary.turn = {
    turnId,
    completed: turnCompleted.params ?? turnCompleted,
    resultFileContent,
    resultFileExists: resultFileContent !== null,
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = {
    message: error instanceof Error ? error.message : String(error),
  };
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client?.close();
}
