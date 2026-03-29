import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const probeDir = path.join(workspace, "verification", "launchd_conditional_delivery_probe");
const stateDir = path.join(probeDir, "project_alpha", "state");
const runtimeDir = path.join(probeDir, "runtime");
const inputPath = path.join(runtimeDir, "input.json");
const lastRunPath = path.join(runtimeDir, "last_run.json");

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

    this.ws.addEventListener("message", (event) => {
      const text = String(event.data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code ?? "no-code"})`));
        else pending.resolve(msg.result);
        return;
      }

      const waiters = [...this.notificationWaiters];
      for (const waiter of waiters) {
        if (waiter.method !== (msg.method ?? "unknown")) continue;
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

async function readFileTrim(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function collectBlockedReasons(toggleText, statusText) {
  const reasons = [];
  if (!toggleText?.includes("background_trigger_enabled: true")) reasons.push("background_trigger_disabled");
  if (toggleText?.includes("foreground_session_active: true")) reasons.push("foreground_session_active");
  if (statusText?.includes("busy_non_interruptible")) reasons.push("status_busy_non_interruptible");
  return reasons;
}

const run = {
  startedAt: new Date().toISOString(),
  decision: null,
  blockedReasons: [],
  turnId: null,
  wakeFile: null,
  error: null,
};

let client = null;

try {
  const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const toggleText = await readFileTrim(path.join(stateDir, "background_trigger_toggle.md"));
  const statusText = await readFileTrim(path.join(stateDir, "coordinator_status.md"));
  const wakeFileExists = await readFileTrim(input.wakeFilePath);
  const blockedReasons = collectBlockedReasons(toggleText, statusText);
  run.blockedReasons = blockedReasons;

  if (wakeFileExists !== null) {
    run.decision = "already_delivered";
  } else if (blockedReasons.length > 0) {
    run.decision = "blocked";
  } else {
    run.decision = "wake";
    client = new JsonRpcWsClient(input.wsUrl);
    await client.connect();
    await client.initialize("remodex_launchd_conditional_delivery_worker");
    const turnResult = await client.request("turn/start", {
      threadId: input.threadId,
      input: [
        {
          type: "text",
          text:
            `Write the file ${input.wakeFilePath} with exact contents conditional-launchd-ok. ` +
            `Do not modify any other file. After writing, briefly confirm the path.`,
        },
      ],
    });
    const turnId = extractTurnId(turnResult);
    run.turnId = turnId;
    await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 240_000);
    run.wakeFile = input.wakeFilePath;
    await sleep(250);
  }
} catch (error) {
  run.decision = run.decision ?? "error";
  run.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  run.finishedAt = new Date().toISOString();
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(lastRunPath, JSON.stringify(run, null, 2));
  client?.close();
}
