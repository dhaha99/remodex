import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const previousSummaryPath = path.join(verificationDir, "app_server_probe_summary.json");
const summaryPath = path.join(verificationDir, "thread_resume_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "thread_resume_probe_events.jsonl");
const resumedFile = path.join(verificationDir, "from_thread_resume.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JsonRpcWsClient {
  constructor(url, eventsLogPathArg) {
    this.url = url;
    this.eventsLogPath = eventsLogPathArg;
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
      await fs.appendFile(this.eventsLogPath, `${JSON.stringify(msg)}\n`);

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
  sourceThreadId: null,
  read: null,
  resume: null,
  turn3: null,
  eventCounts: {},
};

let client1 = null;
let client2 = null;

try {
  const previousSummary = JSON.parse(await fs.readFile(previousSummaryPath, "utf8"));
  const threadId = previousSummary?.threadId;
  if (!threadId) throw new Error("previous probe summary does not contain threadId");
  summary.sourceThreadId = threadId;

  client1 = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client1.connect();
  await client1.initialize("remodex_resume_probe_read");

  const readResult = await client1.request("thread/read", {
    threadId,
    includeTurns: true,
  });

  const turns = readResult?.thread?.turns ?? [];
  summary.read = {
    threadId: readResult?.thread?.id ?? null,
    turnCount: turns.length,
    turnIds: turns.map((turn) => turn?.id).filter(Boolean),
    status: readResult?.thread?.status ?? null,
  };

  client1.close();
  client1 = null;

  client2 = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client2.connect();
  await client2.initialize("remodex_resume_probe_resume");

  const resumeResult = await client2.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  const resumedTurns = resumeResult?.thread?.turns ?? [];
  summary.resume = {
    threadId: resumeResult?.thread?.id ?? null,
    cwd: resumeResult?.cwd ?? null,
    approvalPolicy: resumeResult?.approvalPolicy ?? null,
    resumedTurnCount: resumedTurns.length,
    resumedTurnIds: resumedTurns.map((turn) => turn?.id).filter(Boolean),
  };

  const turn3Result = await client2.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `This is a resumed-thread verification. Create the file ${resumedFile} with exact contents resumed-same-thread. ` +
          `Also append a third line turn3 to ${path.join(verificationDir, "from_thread_turn1.txt")}. ` +
          `Do not modify any other file. After finishing, briefly confirm both paths.`,
      },
    ],
  });
  const turn3Id = extractTurnId(turn3Result);
  const turn3Completed = await client2.waitForNotification(
    "turn/completed",
    completedTurnPredicate(turn3Id),
    240_000,
  );

  const resumedFileContent = await waitForFile(resumedFile);
  const file1Content = await waitForFile(path.join(verificationDir, "from_thread_turn1.txt"));
  summary.turn3 = {
    turnId: turn3Id,
    completed: turn3Completed.params ?? turn3Completed,
    resumedFileContent,
    file1ContentAfterResume: file1Content,
  };

  summary.eventCounts = Object.fromEntries([...client2.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();

  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = {
    message: error instanceof Error ? error.message : String(error),
  };
  const combinedCounts = new Map();
  for (const client of [client1, client2]) {
    if (!client) continue;
    for (const [key, value] of client.eventCounts.entries()) {
      combinedCounts.set(key, (combinedCounts.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combinedCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client1?.close();
  client2?.close();
}
