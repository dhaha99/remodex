import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const eventsLogPath = path.join(verificationDir, "waiting_on_user_input_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "waiting_on_user_input_probe_summary.json");
const optionAPath = path.join(verificationDir, "waiting_input_option_a.txt");
const optionBPath = path.join(verificationDir, "waiting_input_option_b.txt");
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

function statusPredicate(threadId, activeFlag) {
  return (msg) => {
    if ((msg.params?.threadId ?? null) !== threadId) return false;
    const flags = msg.params?.status?.activeFlags ?? [];
    return Array.isArray(flags) && flags.includes(activeFlag);
  };
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function waitForAnyFile(paths, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const filePath of paths) {
      const content = await readIfExists(filePath);
      if (content !== null) return { filePath, content };
    }
    await sleep(250);
  }
  return null;
}

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);
const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  turnId: null,
  observedPath: null,
  waitingFlagSeen: false,
  waitingFlagEvent: null,
  steerResponse: null,
  steerError: null,
  completed: null,
  createdFile: null,
  createdContent: null,
};

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(optionAPath, { force: true });
  await fs.rm(optionBPath, { force: true });

  await client.connect();
  await client.initialize("remodex_waiting_on_user_input_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_waiting_on_user_input_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  const turnStart = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question: should you create ${optionAPath} ` +
          `or ${optionBPath}? Then wait for my answer. Do not create either file until I answer. ` +
          "After I answer, create only the chosen file with the exact contents user-input-ok\\n.",
      },
    ],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("turn id missing");
  summary.turnId = turnId;

  const firstOutcome = await Promise.race([
    client.waitForNotification(
      "thread/status/changed",
      statusPredicate(threadId, "waitingOnUserInput"),
      120_000,
    ).then((msg) => ({ kind: "waiting", msg })),
    client.waitForNotification(
      "turn/completed",
      turnPredicate(turnId),
      120_000,
    ).then((msg) => ({ kind: "completed", msg })),
  ]);

  if (firstOutcome.kind === "waiting") {
    summary.observedPath = "waiting_flag_then_steer";
    summary.waitingFlagSeen = true;
    summary.waitingFlagEvent = firstOutcome.msg.params ?? firstOutcome.msg;

    try {
      summary.steerResponse = await client.request("turn/steer", {
        threadId,
        expectedTurnId: turnId,
        input: [
          {
            type: "text",
            text:
              `Answer: create ${optionBPath} and do not create ${optionAPath}. ` +
              "Use exact contents user-input-ok\\n.",
          },
        ],
      });
    } catch (error) {
      summary.steerError = String(error);
    }

    const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
    summary.completed = completed.params ?? completed;
  } else {
    summary.observedPath = "completed_without_waiting_flag";
    summary.completed = firstOutcome.msg.params ?? firstOutcome.msg;
  }

  const created = await waitForAnyFile([optionAPath, optionBPath], 15_000);
  summary.createdFile = created?.filePath ?? null;
  summary.createdContent = created?.content ?? null;
  summary.finishedAt = new Date().toISOString();
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.status =
    summary.createdFile === null
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
