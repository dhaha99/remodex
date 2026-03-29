import fs from "node:fs/promises";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientThreadReadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("includeTurns is unavailable before first user message");
}

export function isRetryableTurnStartError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("(-32001)") ||
    message.toLowerCase().includes("overload") ||
    message.toLowerCase().includes("too many pending") ||
    message.toLowerCase().includes("temporarily unavailable") ||
    message.toLowerCase().includes("try again")
  );
}

export class JsonRpcWsClient {
  constructor(url, logPath) {
    this.url = url;
    this.logPath = logPath;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.serverRequestWaiters = [];
    this.serverRequestQueue = [];
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
      if (this.logPath) {
        await fs.appendFile(this.logPath, `${JSON.stringify(msg)}\n`);
      }

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
        let consumed = false;
        for (const waiter of waiters) {
          if (!waiter.methods.includes(msg.method)) continue;
          if (!waiter.predicate(msg)) continue;
          waiter.resolve(msg);
          this.serverRequestWaiters = this.serverRequestWaiters.filter((candidate) => candidate !== waiter);
          consumed = true;
        }
        if (!consumed) {
          this.serverRequestQueue.push(msg);
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

  async initialize(name) {
    await this.request("initialize", {
      clientInfo: { name, title: name, version: "0.1.0" },
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

  async respond(id, result) {
    this.ws.send(JSON.stringify({ id, result }));
  }

  onNotification(fn) {
    this.notificationHooks.push(fn);
  }

  onServerRequest(fn) {
    this.serverRequestHooks.push(fn);
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
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.notificationWaiters.push(entry);
    });
  }

  waitForServerRequest(methods, predicate = () => true, timeoutMs = 180_000) {
    const queuedIndex = this.serverRequestQueue.findIndex(
      (msg) => methods.includes(msg.method) && predicate(msg),
    );
    if (queuedIndex >= 0) {
      const [msg] = this.serverRequestQueue.splice(queuedIndex, 1);
      return Promise.resolve(msg);
    }

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
        timer,
      };
      this.serverRequestWaiters.push(entry);
    });
  }

  drainQueuedServerRequests(methods, predicate = () => true) {
    const matched = [];
    const remaining = [];
    for (const msg of this.serverRequestQueue) {
      if (methods.includes(msg.method) && predicate(msg)) {
        matched.push(msg);
      } else {
        remaining.push(msg);
      }
    }
    this.serverRequestQueue = remaining;
    return matched;
  }

  clearAllWaiters() {
    for (const waiter of this.notificationWaiters) clearTimeout(waiter.timer);
    this.notificationWaiters = [];
    for (const waiter of this.serverRequestWaiters) clearTimeout(waiter.timer);
    this.serverRequestWaiters = [];
  }

  close() {
    this.ws?.close();
  }
}

export async function createInitializedWsClient(url, logPath, clientName) {
  const client = new JsonRpcWsClient(url, logPath);
  await client.connect();
  await client.initialize(clientName);
  return client;
}

export async function listStoredThreads(client, params = {}) {
  return await client.request("thread/list", params);
}

export async function listLoadedThreads(client) {
  return await client.request("thread/loaded/list", {});
}

export function extractTurnId(result) {
  return result?.turn?.id ?? result?.turnId ?? result?.id ?? null;
}

export function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

export function extractFinalText(threadReadResult, turnId) {
  const turns = threadReadResult?.thread?.turns ?? [];
  const turn = turns.find((item) => item.id === turnId);
  const items = turn?.items ?? [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return null;
}

export function extractTurn(threadReadResult, turnId) {
  const turns = threadReadResult?.thread?.turns ?? [];
  return turns.find((item) => item.id === turnId) ?? null;
}

export async function readThreadWithTurns(client, threadId) {
  return await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
}

export async function readTurnCount(client, threadId) {
  const threadRead = await readThreadWithTurns(client, threadId);
  return {
    count: (threadRead?.thread?.turns ?? []).length,
    threadRead,
  };
}

export async function runTurnAndRead(client, threadId, text, timeoutMs = 180_000, options = {}) {
  const {
    onTurnStarted = null,
    maxTurnStartAttempts = 4,
    retryBaseDelayMs = 500,
    retryMaxDelayMs = 4_000,
  } = options;
  let turnStart = null;
  let turnStartAttempts = 0;
  while (turnStartAttempts < maxTurnStartAttempts) {
    turnStartAttempts += 1;
    try {
      turnStart = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
      });
      break;
    } catch (error) {
      if (!isRetryableTurnStartError(error) || turnStartAttempts >= maxTurnStartAttempts) {
        throw error;
      }
      const delayMs = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** (turnStartAttempts - 1)));
      await sleep(delayMs);
    }
  }
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error("turn id missing");
  if (onTurnStarted) {
    await onTurnStarted({ turnId, turnStartAttempts });
  }
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    try {
      await client.waitForNotification(
        "turn/completed",
        completedTurnPredicate(turnId),
        Math.min(1_500, remaining),
      );
      const threadRead = await readThreadWithTurns(client, threadId);
      return { turnId, text: extractFinalText(threadRead, turnId), threadRead, turnStartAttempts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("timeout waiting for turn/completed")) {
        throw error;
      }
    }

    let threadRead;
    try {
      threadRead = await readThreadWithTurns(client, threadId);
    } catch (error) {
      if (!isTransientThreadReadError(error)) {
        throw error;
      }
      await sleep(Math.min(500, Math.max(100, remaining)));
      continue;
    }
    const turn = extractTurn(threadRead, turnId);
    if (turn?.status && turn.status !== "inProgress") {
      return { turnId, text: extractFinalText(threadRead, turnId), threadRead, turnStartAttempts };
    }

    await sleep(Math.min(500, Math.max(100, remaining)));
  }

  throw new Error(`timeout waiting for turn completion ${turnId}`);
}
