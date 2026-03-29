import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "turn_interrupt_steer_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "turn_interrupt_steer_probe_events.jsonl");
const interruptFilePath = path.join(verificationDir, "interrupt_should_not_exist.txt");
const steerBaseFilePath = path.join(verificationDir, "steer_base.txt");
const steerExtraFilePath = path.join(verificationDir, "steer_extra.txt");
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
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message} (${msg.error.code ?? "no-code"})`));
        } else {
          pending.resolve(msg.result);
        }
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

function turnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

function extractTurnStatus(msg) {
  const params = msg?.params ?? msg ?? {};
  return params?.turn?.status ?? params?.status ?? null;
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

async function startThread(client, serviceName) {
  const result = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName,
  });
  const threadId = result?.thread?.id ?? null;
  if (!threadId) throw new Error(`thread/start did not return thread id for ${serviceName}`);
  return threadId;
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  interruptCase: null,
  steerCase: null,
  eventCounts: {},
};

const client = new JsonRpcWsClient(wsUrl, eventsLogPath);

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(interruptFilePath, { force: true });
  await fs.rm(steerBaseFilePath, { force: true });
  await fs.rm(steerExtraFilePath, { force: true });

  await client.connect();
  await client.initialize("remodex_turn_interrupt_steer_probe");

  const interruptThreadId = await startThread(client, "remodex_interrupt_probe");
  const interruptTurnStart = await client.request("turn/start", {
    threadId: interruptThreadId,
    input: [
      {
        type: "text",
        text:
          "Use a shell command, not internal waiting. " +
          "First run exactly `bash -lc 'sleep 20'`. " +
          `Only after that command exits, create the file ${interruptFilePath} ` +
          "with exact contents interrupt-case\\n. " +
          "Do not create the file earlier and do not modify any other file.",
      },
    ],
  });
  const interruptTurnId = extractTurnId(interruptTurnStart);
  if (!interruptTurnId) throw new Error("interrupt case turn id missing");

  let interruptStarted = null;
  try {
    interruptStarted = await client.waitForNotification("turn/started", turnPredicate(interruptTurnId), 30_000);
  } catch (error) {
    interruptStarted = { error: String(error) };
  }
  await sleep(2_000);

  let interruptResponse = null;
  let interruptError = null;
  try {
    interruptResponse = await client.request("turn/interrupt", {
      threadId: interruptThreadId,
      turnId: interruptTurnId,
    });
  } catch (error) {
    interruptError = String(error);
  }

  const interruptCompleted = await client.waitForNotification(
    "turn/completed",
    turnPredicate(interruptTurnId),
    240_000,
  );
  const interruptFileContent = await waitForFile(interruptFilePath, 5_000);

  summary.interruptCase = {
    threadId: interruptThreadId,
    turnId: interruptTurnId,
    started: interruptStarted?.params ?? interruptStarted,
    interruptResponse,
    interruptError,
    completed: interruptCompleted.params ?? interruptCompleted,
    completedStatus: extractTurnStatus(interruptCompleted),
    fileExists: interruptFileContent !== null,
    fileContent: interruptFileContent,
  };

  const steerThreadId = await startThread(client, "remodex_steer_probe");
  const steerTurnStart = await client.request("turn/start", {
    threadId: steerThreadId,
    input: [
      {
        type: "text",
        text:
          "Use a shell command, not internal waiting. " +
          "First run exactly `bash -lc 'sleep 15'`. " +
          `After that command exits, create the file ${steerBaseFilePath} ` +
          "with exact contents base-case\\n. " +
          "Do not create any other files unless a later steer message explicitly changes the plan.",
      },
    ],
  });
  const steerTurnId = extractTurnId(steerTurnStart);
  if (!steerTurnId) throw new Error("steer case turn id missing");

  let steerStarted = null;
  try {
    steerStarted = await client.waitForNotification("turn/started", turnPredicate(steerTurnId), 30_000);
  } catch (error) {
    steerStarted = { error: String(error) };
  }
  await sleep(2_000);

  let activeSteerResponse = null;
  let activeSteerError = null;
  try {
    activeSteerResponse = await client.request("turn/steer", {
      threadId: steerThreadId,
      expectedTurnId: steerTurnId,
      input: [
        {
          type: "text",
          text:
            `Update: after you finish the previously requested sleep, keep creating ${steerBaseFilePath} ` +
            `with base-case\\n and also create ${steerExtraFilePath} with exact contents steer-case\\n. ` +
            "Do not modify any other file.",
        },
      ],
    });
  } catch (error) {
    activeSteerError = String(error);
  }

  const steerCompleted = await client.waitForNotification(
    "turn/completed",
    turnPredicate(steerTurnId),
    240_000,
  );
  const steerBaseContent = await waitForFile(steerBaseFilePath, 10_000);
  const steerExtraContent = await waitForFile(steerExtraFilePath, 10_000);

  let staleSteerResponse = null;
  let staleSteerError = null;
  try {
    staleSteerResponse = await client.request("turn/steer", {
      threadId: steerThreadId,
      expectedTurnId: steerTurnId,
      input: [
        {
          type: "text",
          text: "This stale steer should fail because the turn is no longer active.",
        },
      ],
    });
  } catch (error) {
    staleSteerError = String(error);
  }

  summary.steerCase = {
    threadId: steerThreadId,
    turnId: steerTurnId,
    started: steerStarted?.params ?? steerStarted,
    activeSteerResponse,
    activeSteerError,
    completed: steerCompleted.params ?? steerCompleted,
    completedStatus: extractTurnStatus(steerCompleted),
    baseFileExists: steerBaseContent !== null,
    baseFileContent: steerBaseContent,
    extraFileExists: steerExtraContent !== null,
    extraFileContent: steerExtraContent,
    staleSteerResponse,
    staleSteerError,
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
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
