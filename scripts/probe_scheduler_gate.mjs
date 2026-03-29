import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const stateDir = path.join(verificationDir, "scheduler_probe_state");
const runtimeDir = path.join(stateDir, "runtime");
const eventsLogPath = path.join(verificationDir, "scheduler_gate_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "scheduler_gate_probe_summary.json");
const wakeFilePath = path.join(verificationDir, "from_scheduler_wake.txt");
const previousSummaryPath = path.join(verificationDir, "thread_resume_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function evaluateGate(togglePath, statusPath) {
  const toggle = JSON.parse(await fs.readFile(togglePath, "utf8"));
  const status = JSON.parse(await fs.readFile(statusPath, "utf8"));
  const blockedReasons = [];
  if (!toggle.background_trigger_enabled) blockedReasons.push("background_trigger_disabled");
  if (toggle.foreground_session_active) blockedReasons.push("foreground_session_active");
  if (!["idle", "checkpoint_open"].includes(status.type)) blockedReasons.push(`status_${status.type}`);

  return {
    toggle,
    status,
    shouldWake: blockedReasons.length === 0,
    blockedReasons,
  };
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

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  cases: [],
  eventCounts: {},
};

let client = null;

try {
  await fs.rm(wakeFilePath, { force: true });
  await fs.writeFile(eventsLogPath, "");

  const previousSummary = JSON.parse(await fs.readFile(previousSummaryPath, "utf8"));
  const threadId = previousSummary?.sourceThreadId ?? previousSummary?.threadId;
  if (!threadId) throw new Error("resume probe summary does not contain thread id");
  summary.threadId = threadId;

  const togglePath = path.join(runtimeDir, "background_trigger_toggle.json");
  const statusPath = path.join(runtimeDir, "coordinator_status.json");
  const wakeEventPath = path.join(runtimeDir, "wake_event.json");

  await writeJson(togglePath, {
    background_trigger_enabled: false,
    foreground_session_active: true,
    foreground_lock_enabled: true,
    mode: "foreground",
  });
  await writeJson(statusPath, { type: "busy_non_interruptible" });

  const blockedCase = await evaluateGate(togglePath, statusPath);
  summary.cases.push({
    case: "blocked_when_foreground_active",
    ...blockedCase,
    wakeEventWritten: false,
    wakeFileExistsAfterCase: (await readIfExists(wakeFilePath)) !== null,
  });

  await writeJson(togglePath, {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
    mode: "background",
  });
  await writeJson(statusPath, { type: "idle" });

  const allowedCase = await evaluateGate(togglePath, statusPath);
  if (!allowedCase.shouldWake) {
    throw new Error(`scheduler gate unexpectedly blocked wake: ${allowedCase.blockedReasons.join(",")}`);
  }

  await writeJson(wakeEventPath, {
    type: "scheduled_wake",
    threadId,
    createdAt: new Date().toISOString(),
    reason: "scheduler_probe_allowed_case",
  });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_scheduler_gate_probe");

  await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  const turnResult = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Scheduler wake probe: create the file ${wakeFilePath} with exact contents scheduler-wake-ok. ` +
          `Do not modify any other file. After finishing, briefly confirm the path.`,
      },
    ],
  });
  const turnId = extractTurnId(turnResult);
  const turnCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(turnId),
    240_000,
  );
  const wakeFileContent = await waitForFile(wakeFilePath);

  summary.cases.push({
    case: "allowed_when_background_enabled_and_idle",
    ...allowedCase,
    wakeEventWritten: true,
    wakeEventPath,
    turnId,
    turnCompleted: turnCompleted.params ?? turnCompleted,
    wakeFileContent,
    wakeFileExistsAfterCase: wakeFileContent !== null,
  });

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
