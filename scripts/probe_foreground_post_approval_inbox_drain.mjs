import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "foreground_post_approval_inbox_drain_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const processedDir = path.join(projectRoot, "processed");
const summaryPath = path.join(verificationDir, "foreground_post_approval_inbox_drain_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "foreground_post_approval_inbox_drain_probe_events.jsonl");
const approvalTargetPath = path.join(verificationDir, "post_approval_lane_target.txt");
const approvalWrongPath = path.join(verificationDir, "post_approval_lane_wrong.txt");
const drainTargetPath = path.join(verificationDir, "post_approval_drain_target.txt");
const drainWrongPath = path.join(verificationDir, "post_approval_drain_wrong.txt");
const approvalTargetRel = "verification/post_approval_lane_target.txt";
const approvalWrongRel = "verification/post_approval_lane_wrong.txt";
const drainTargetRel = "verification/post_approval_drain_target.txt";
const drainWrongRel = "verification/post_approval_drain_wrong.txt";
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
    this.serverRequestQueue = [];
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
        let consumed = false;
        for (const waiter of waiters) {
          if (!waiter.methods.includes(msg.method)) continue;
          if (!waiter.predicate(msg)) continue;
          waiter.resolve(msg);
          this.serverRequestWaiters = this.serverRequestWaiters.filter((candidate) => candidate !== waiter);
          consumed = true;
          break;
        }
        if (!consumed) this.serverRequestQueue.push(msg);
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
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.notificationWaiters.push(entry);
    });
  }

  waitForAnyServerRequest(methods, predicate = () => true, timeoutMs = 180_000) {
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
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.serverRequestWaiters.push(entry);
    });
  }

  clearAllWaiters() {
    for (const waiter of this.notificationWaiters) clearTimeout(waiter.timer);
    for (const waiter of this.serverRequestWaiters) clearTimeout(waiter.timer);
    this.notificationWaiters = [];
    this.serverRequestWaiters = [];
    this.serverRequestQueue = [];
  }

  close() {
    this.ws?.close();
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

function completedTurnPredicate(expectedTurnId) {
  return turnPredicate(expectedTurnId);
}

function waitForAnyApproval(client, threadId, timeoutMs = 180_000) {
  const methods = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ];
  return client.waitForAnyServerRequest(
    methods,
    (msg) => (msg.params?.threadId ?? msg.params?.thread?.id ?? null) === threadId,
    timeoutMs,
  );
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readDirSafe(dirPath) {
  try {
    return (await fs.readdir(dirPath)).sort();
  } catch {
    return [];
  }
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const content = await readTextIfExists(filePath);
    if (content !== null) return content;
    await sleep(250);
  }
  return null;
}

async function readTurnCount(client, threadId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return (result?.thread?.turns ?? []).length;
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  approvalTurnId: null,
  drainTurnId: null,
  approvalSourceRef: null,
  followupApprovals: [],
  drainApprovals: [],
  unreadBeforeApprovalCompletion: null,
  unreadAfterApprovalCompletion: null,
  beforeDrainTurnCount: null,
  afterDrainTurnCount: null,
  finalFiles: null,
};

let client = null;
try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [approvalTargetPath, approvalWrongPath, drainTargetPath, drainWrongPath]) {
    await fs.rm(filePath, { force: true });
  }

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("foreground_post_approval_inbox_drain_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "foreground_post_approval_inbox_drain_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeJson(path.join(stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId,
  });

  const approvalTurn = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `In the current workspace, create only ${approvalTargetRel} with exact contents post-approval-lane-ok\\n. ` +
          `Do not create ${approvalWrongRel}, ${drainTargetRel}, or ${drainWrongRel}. ` +
          `Do not inspect unrelated files.`,
      },
    ],
  });
  const approvalTurnId = extractTurnId(approvalTurn);
  if (!approvalTurnId) throw new Error("approval turn id missing");
  summary.approvalTurnId = approvalTurnId;

  const approvalRequest = await waitForAnyApproval(client, threadId, 180_000);
  const approvalSourceRef = `${approvalRequest.method}:${approvalRequest.id}`;
  summary.approvalSourceRef = approvalSourceRef;
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "waiting_on_approval",
    active_approval_source_ref: approvalSourceRef,
  });

  const inboxFileName = "2026-03-26T23-30-00+09-00_post_approval_answer.json";
  const inboxPath = path.join(inboxDir, inboxFileName);
  await writeJson(inboxPath, {
    workspace_key: "remodex",
    project_key: "project-alpha",
    correlation_key: "post-approval-drain-001",
    operator_answer:
      `In the current workspace, create only ${drainTargetRel} with exact contents post-approval-drain-ok\\n. ` +
      `Do not create ${drainWrongRel}. Do not touch any other file and do not inspect unrelated files.`,
  });
  summary.unreadBeforeApprovalCompletion = (await readDirSafe(inboxDir)).includes(inboxFileName);

  await client.respond(approvalRequest.id, { decision: "accept" });

  let approvalCompleted = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      approvalCompleted = await client.waitForNotification(
        "turn/completed",
        completedTurnPredicate(approvalTurnId),
        10_000,
      );
      break;
    } catch {
      const extraApproval = await waitForAnyApproval(client, threadId, 2_000).catch(() => null);
      if (!extraApproval) continue;
      summary.followupApprovals.push({
        id: extraApproval.id,
        method: extraApproval.method,
        params: extraApproval.params,
      });
      await client.respond(extraApproval.id, { decision: "accept" });
    }
  }
  if (!approvalCompleted) {
    approvalCompleted = await client.waitForNotification(
      "turn/completed",
      completedTurnPredicate(approvalTurnId),
      120_000,
    );
  }

  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "checkpoint_open",
    active_approval_source_ref: null,
  });

  summary.completedApprovalTurn = approvalCompleted.params ?? approvalCompleted;
  summary.unreadAfterApprovalCompletion = (await readDirSafe(inboxDir)).includes(inboxFileName);
  summary.filesBeforeDrain = {
    approvalTarget: await readTextIfExists(approvalTargetPath),
    approvalWrong: await readTextIfExists(approvalWrongPath),
    drainTarget: await readTextIfExists(drainTargetPath),
    drainWrong: await readTextIfExists(drainWrongPath),
  };

  const event = await readJson(inboxPath);
  await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  summary.beforeDrainTurnCount = await readTurnCount(client, threadId);
  const drainTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: event.operator_answer }],
  });
  const drainTurnId = extractTurnId(drainTurn);
  if (!drainTurnId) throw new Error("drain turn id missing");
  summary.drainTurnId = drainTurnId;
  let drainCompleted = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      drainCompleted = await client.waitForNotification(
        "turn/completed",
        completedTurnPredicate(drainTurnId),
        10_000,
      );
      break;
    } catch {
      const extraApproval = await waitForAnyApproval(client, threadId, 2_000).catch(() => null);
      if (!extraApproval) continue;
      summary.drainApprovals.push({
        id: extraApproval.id,
        method: extraApproval.method,
        params: extraApproval.params,
      });
      await client.respond(extraApproval.id, { decision: "accept" });
    }
  }
  if (!drainCompleted) {
    drainCompleted = await client.waitForNotification(
      "turn/completed",
      completedTurnPredicate(drainTurnId),
      120_000,
    );
  }
  summary.completedDrainTurn = drainCompleted.params ?? drainCompleted;

  await fs.rename(inboxPath, path.join(processedDir, inboxFileName));
  summary.afterDrainTurnCount = await readTurnCount(client, threadId);

  summary.finalFiles = {
    approvalTarget: await waitForFile(approvalTargetPath, 15_000),
    approvalWrong: await readTextIfExists(approvalWrongPath),
    drainTarget: await waitForFile(drainTargetPath, 15_000),
    drainWrong: await readTextIfExists(drainWrongPath),
    inbox: await readDirSafe(inboxDir),
    processed: await readDirSafe(processedDir),
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.unreadBeforeApprovalCompletion === true &&
    summary.unreadAfterApprovalCompletion === true &&
    summary.filesBeforeDrain.approvalTarget === "post-approval-lane-ok\n" &&
    summary.filesBeforeDrain.approvalWrong === null &&
    summary.filesBeforeDrain.drainTarget === null &&
    summary.filesBeforeDrain.drainWrong === null &&
    summary.beforeDrainTurnCount === 1 &&
    summary.afterDrainTurnCount === 2 &&
    summary.finalFiles.approvalTarget === "post-approval-lane-ok\n" &&
    summary.finalFiles.approvalWrong === null &&
    summary.finalFiles.drainTarget === "post-approval-drain-ok\n" &&
    summary.finalFiles.drainWrong === null &&
    summary.finalFiles.inbox.length === 0 &&
    summary.finalFiles.processed.includes(inboxFileName)
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.clearAllWaiters();
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "foreground post approval inbox drain probe failed");
}
