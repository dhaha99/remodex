import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "file_change_approval_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "file_change_approval_probe_events.jsonl");
const declineFilePath = path.join(verificationDir, "approval_declined.txt");
const acceptFilePath = path.join(verificationDir, "approval_accepted.txt");
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
    this.serverRequestWaiters = [];
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

      if (msg.id !== undefined && msg.method !== undefined) {
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

  waitForServerRequest(method, predicate = () => true, timeoutMs = 180_000) {
    return this.waitForAnyServerRequest([method], predicate, timeoutMs);
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

function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await sleep(250);
    }
  }
  return null;
}

async function waitForAnyApproval(client, threadId, timeoutMs = 180_000) {
  return client.waitForAnyServerRequest(
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    (msg) => (msg.params?.threadId ?? null) === threadId,
    timeoutMs,
  );
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  declineCase: null,
  acceptCase: null,
  eventCounts: {},
};

let client = null;

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(declineFilePath, { force: true });
  await fs.rm(acceptFilePath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_file_change_approval_probe");

  const declineThread = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "remodex_file_change_decline",
  });
  const declineThreadId = declineThread?.thread?.id ?? null;
  if (!declineThreadId) throw new Error("decline thread id missing");

  const declineTurnResult = await client.request("turn/start", {
    threadId: declineThreadId,
    input: [
      {
        type: "text",
        text:
          `Create the file ${declineFilePath} with exact contents decline-case. ` +
          `Do not modify any other file. After finishing, briefly confirm the path.`,
      },
    ],
  });
  const declineTurnId = extractTurnId(declineTurnResult);
  const declineApproval = await waitForAnyApproval(client, declineThreadId, 180_000);
  const declineDecision = "cancel";
  await client.respond(declineApproval.id, { decision: declineDecision });
  const declineCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(declineTurnId),
    240_000,
  );
  const declineFileContent = await waitForFile(declineFilePath, 5_000);
  summary.declineCase = {
    threadId: declineThreadId,
    turnId: declineTurnId,
    approvalRequestId: declineApproval.id,
    approvalMethod: declineApproval.method,
    approvalParams: declineApproval.params,
    approvalDecision: declineDecision,
    completed: declineCompleted.params ?? declineCompleted,
    fileExistsAfterDecline: declineFileContent !== null,
    fileContentAfterDecline: declineFileContent,
  };

  const acceptThread = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "remodex_file_change_accept",
  });
  const acceptThreadId = acceptThread?.thread?.id ?? null;
  if (!acceptThreadId) throw new Error("accept thread id missing");

  const acceptTurnResult = await client.request("turn/start", {
    threadId: acceptThreadId,
    input: [
      {
        type: "text",
        text:
          `Create the file ${acceptFilePath} with exact contents accept-case. ` +
          `Do not modify any other file. After finishing, briefly confirm the path.`,
      },
    ],
  });
  const acceptTurnId = extractTurnId(acceptTurnResult);
  const acceptApproval = await waitForAnyApproval(client, acceptThreadId, 180_000);
  await client.respond(acceptApproval.id, { decision: "accept" });
  const followupApprovals = [];
  let acceptCompleted = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      acceptCompleted = await client.waitForNotification(
        "turn/completed",
        completedTurnPredicate(acceptTurnId),
        15_000,
      );
      break;
    } catch {
      const extraApproval = await waitForAnyApproval(client, acceptThreadId, 60_000);
      followupApprovals.push({
        id: extraApproval.id,
        method: extraApproval.method,
        params: extraApproval.params,
      });
      await client.respond(extraApproval.id, { decision: "accept" });
    }
  }
  if (!acceptCompleted) {
    acceptCompleted = await client.waitForNotification(
      "turn/completed",
      completedTurnPredicate(acceptTurnId),
      120_000,
    );
  }
  const acceptFileContent = await waitForFile(acceptFilePath, 15_000);
  summary.acceptCase = {
    threadId: acceptThreadId,
    turnId: acceptTurnId,
    approvalRequestId: acceptApproval.id,
    approvalMethod: acceptApproval.method,
    approvalParams: acceptApproval.params,
    approvalDecision: "accept",
    followupApprovals,
    completed: acceptCompleted.params ?? acceptCompleted,
    fileExistsAfterAccept: acceptFileContent !== null,
    fileContentAfterAccept: acceptFileContent,
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client?.close();
}
