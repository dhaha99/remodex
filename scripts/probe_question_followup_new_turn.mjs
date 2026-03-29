import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "question_followup_new_turn_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "question_followup_new_turn_probe_events.jsonl");
const optionAPath = path.join(verificationDir, "followup_option_a.txt");
const optionBPath = path.join(verificationDir, "followup_option_b.txt");
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

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  questionTurn: null,
  answerTurn: null,
  finalFiles: {
    optionA: null,
    optionB: null,
  },
};

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(optionAPath, { force: true });
  await fs.rm(optionBPath, { force: true });

  await client.connect();
  await client.initialize("remodex_question_followup_new_turn_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_question_followup_new_turn_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

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
  const optionAAfterQuestion = await readIfExists(optionAPath);
  const optionBAfterQuestion = await readIfExists(optionBPath);

  summary.questionTurn = {
    turnId: questionTurnId,
    completed: questionCompleted.params ?? questionCompleted,
    optionAExistsAfterQuestion: optionAAfterQuestion !== null,
    optionBExistsAfterQuestion: optionBAfterQuestion !== null,
  };

  const answerTurnStart = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Answer to your last question: choose ${optionBPath}. ` +
          `Create only ${optionBPath} with exact contents user-input-ok\\n. ` +
          `Do not create ${optionAPath}.`,
      },
    ],
  });
  const answerTurnId = extractTurnId(answerTurnStart);
  if (!answerTurnId) throw new Error("answer turn id missing");
  const answerCompleted = await client.waitForNotification(
    "turn/completed",
    turnPredicate(answerTurnId),
    240_000,
  );
  const finalOptionA = await readIfExists(optionAPath);
  const finalOptionB = await waitForFile(optionBPath, 15_000);

  summary.answerTurn = {
    turnId: answerTurnId,
    completed: answerCompleted.params ?? answerCompleted,
  };
  summary.finalFiles.optionA = finalOptionA;
  summary.finalFiles.optionB = finalOptionB;
  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    optionAAfterQuestion === null &&
    optionBAfterQuestion === null &&
    finalOptionA === null &&
    finalOptionB === "user-input-ok\n"
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
