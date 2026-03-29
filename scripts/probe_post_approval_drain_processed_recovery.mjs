import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "post_approval_drain_processed_recovery_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const processedDir = path.join(projectRoot, "processed");
const summaryPath = path.join(verificationDir, "post_approval_drain_processed_recovery_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "post_approval_drain_processed_recovery_probe_events.jsonl");
const approvalTargetPath = path.join(verificationDir, "post_approval_processed_lane_target.txt");
const approvalWrongPath = path.join(verificationDir, "post_approval_processed_lane_wrong.txt");
const drainTargetPath = path.join(verificationDir, "post_approval_processed_drain_target.txt");
const drainWrongPath = path.join(verificationDir, "post_approval_processed_drain_wrong.txt");
const approvalTargetRel = "verification/post_approval_processed_lane_target.txt";
const approvalWrongRel = "verification/post_approval_processed_lane_wrong.txt";
const drainTargetRel = "verification/post_approval_processed_drain_target.txt";
const drainWrongRel = "verification/post_approval_processed_drain_wrong.txt";
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

function completedTurnPredicate(expectedTurnId) {
  return (msg) => {
    const params = msg.params ?? {};
    const actual = params?.turn?.id ?? params?.turnId ?? params?.id ?? null;
    if (!expectedTurnId) return true;
    return actual === expectedTurnId;
  };
}

function waitForAnyApproval(client, threadId, timeoutMs = 180_000) {
  return client.waitForAnyServerRequest(
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ],
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

function renderProcessedIndex(entries) {
  return [
    "# Processed Correlation Index",
    "",
    "```json",
    JSON.stringify({ entries }, null, 2),
    "```",
    "",
  ].join("\n");
}

async function readProcessedIndexEntries() {
  const text = await readTextIfExists(path.join(stateDir, "processed_correlation_index.md"));
  if (!text) return [];
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return [];
  const parsed = JSON.parse(match[1]);
  return parsed.entries ?? [];
}

async function appendProcessedIndexEntry(entry) {
  const entries = await readProcessedIndexEntries();
  entries.push(entry);
  await fs.writeFile(path.join(stateDir, "processed_correlation_index.md"), renderProcessedIndex(entries));
  return entries;
}

async function recordProcessedReceipt({ sourceRef, correlationKey, disposition, origin, processedBy }) {
  const receiptName = `${new Date().toISOString().replaceAll(":", "-")}_${correlationKey}_${disposition}.json`;
  const receipt = {
    workspace_key: "remodex",
    project_key: "project-alpha",
    namespace_ref: "remodex/project-alpha",
    source_ref: sourceRef,
    correlation_key: correlationKey,
    processed_at: new Date().toISOString(),
    processed_by: processedBy,
    disposition,
    origin,
  };
  await writeJson(path.join(processedDir, receiptName), receipt);
  const indexEntries = await appendProcessedIndexEntry({
    correlation_key: correlationKey,
    source_ref: sourceRef,
    disposition,
    origin,
    processed_at: receipt.processed_at,
    processed_by: processedBy,
    processed_receipt: receiptName,
  });
  return { receiptName, receipt, indexEntries };
}

async function readTurnCount(client, threadId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return (result?.thread?.turns ?? []).length;
}

async function completeTurnWithApprovals(client, threadId, turnId, bucket) {
  let completed = null;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      completed = await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 10_000);
      break;
    } catch {
      const approval = await waitForAnyApproval(client, threadId, 2_000).catch(() => null);
      if (!approval) continue;
      bucket.push({
        id: approval.id,
        method: approval.method,
        params: approval.params,
      });
      await client.respond(approval.id, { decision: "accept" });
    }
  }
  if (!completed) {
    completed = await client.waitForNotification("turn/completed", completedTurnPredicate(turnId), 120_000);
  }
  return completed.params ?? completed;
}

async function recoveryDecisionFromUnread(client, threadId, inboxFileName, correlationKey, sourceRef) {
  const beforeTurnCount = await readTurnCount(client, threadId);
  const indexEntries = await readProcessedIndexEntries();
  const duplicateInIndex = indexEntries.some((entry) => entry.correlation_key === correlationKey);
  const processedFiles = await readDirSafe(processedDir);
  let duplicateInReceipt = false;
  for (const fileName of processedFiles) {
    const receipt = await readJson(path.join(processedDir, fileName));
    if (receipt.correlation_key === correlationKey) {
      duplicateInReceipt = true;
      break;
    }
  }

  let decision = "would_replay";
  let skipReceipt = null;
  if (duplicateInIndex || duplicateInReceipt) {
    decision = "skipped_duplicate";
    skipReceipt = await recordProcessedReceipt({
      sourceRef,
      correlationKey,
      disposition: "skipped_duplicate",
      origin: "recovery_replay",
      processedBy: "recovery_router_probe",
    });
  }
  const afterTurnCount = await readTurnCount(client, threadId);
  return {
    decision,
    inboxFileName,
    correlationKey,
    sourceRef,
    duplicateInIndex,
    duplicateInReceipt,
    beforeTurnCount,
    afterTurnCount,
    skipReceipt,
    processedFiles: await readDirSafe(processedDir),
    indexEntries: await readProcessedIndexEntries(),
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  approvalTurnId: null,
  drainTurnId: null,
  approvalApprovals: [],
  drainApprovals: [],
  processed: null,
  recovery: null,
};

let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  for (const dirPath of [stateDir, inboxDir, processedDir]) {
    await fs.mkdir(dirPath, { recursive: true });
  }
  await fs.writeFile(eventsLogPath, "");
  await fs.writeFile(path.join(stateDir, "processed_correlation_index.md"), renderProcessedIndex([]));
  for (const filePath of [approvalTargetPath, approvalWrongPath, drainTargetPath, drainWrongPath]) {
    await fs.rm(filePath, { force: true });
  }

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("post_approval_drain_processed_recovery_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "post_approval_drain_processed_recovery_probe",
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
          `In the current workspace, create only ${approvalTargetRel} with exact contents post-approval-processed-lane-ok\\n. ` +
          `Do not create ${approvalWrongRel}, ${drainTargetRel}, or ${drainWrongRel}. Do not inspect unrelated files.`,
      },
    ],
  });
  const approvalTurnId = extractTurnId(approvalTurn);
  if (!approvalTurnId) throw new Error("approval turn id missing");
  summary.approvalTurnId = approvalTurnId;

  const firstApproval = await waitForAnyApproval(client, threadId, 180_000);
  summary.firstApprovalSourceRef = `${firstApproval.method}:${firstApproval.id}`;
  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "waiting_on_approval",
    active_approval_source_ref: summary.firstApprovalSourceRef,
  });
  summary.approvalApprovals.push({
    id: firstApproval.id,
    method: firstApproval.method,
    params: firstApproval.params,
  });
  await client.respond(firstApproval.id, { decision: "accept" });
  summary.completedApprovalTurn = await completeTurnWithApprovals(
    client,
    threadId,
    approvalTurnId,
    summary.approvalApprovals,
  );

  const inboxFileName = "2026-03-26T23-40-00+09-00_post_approval_processed_answer.json";
  const inboxPath = path.join(inboxDir, inboxFileName);
  const sourceRef = `inbox:${inboxFileName}`;
  const correlationKey = "post-approval-processed-recovery-001";
  await writeJson(inboxPath, {
    workspace_key: "remodex",
    project_key: "project-alpha",
    correlation_key: correlationKey,
    operator_answer:
      `In the current workspace, create only ${drainTargetRel} with exact contents post-approval-processed-drain-ok\\n. ` +
      `Do not create ${drainWrongRel}. Do not touch any other file and do not inspect unrelated files.`,
  });
  summary.inboxRetainedBeforeDrain = (await readDirSafe(inboxDir)).includes(inboxFileName);

  await writeJson(path.join(stateDir, "coordinator_status.json"), {
    type: "checkpoint_open",
    active_approval_source_ref: null,
  });

  await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  summary.beforeDrainTurnCount = await readTurnCount(client, threadId);

  const drainEvent = await readJson(inboxPath);
  const drainTurn = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: drainEvent.operator_answer }],
  });
  const drainTurnId = extractTurnId(drainTurn);
  if (!drainTurnId) throw new Error("drain turn id missing");
  summary.drainTurnId = drainTurnId;
  summary.completedDrainTurn = await completeTurnWithApprovals(
    client,
    threadId,
    drainTurnId,
    summary.drainApprovals,
  );
  summary.afterDrainTurnCount = await readTurnCount(client, threadId);

  summary.processed = await recordProcessedReceipt({
    sourceRef,
    correlationKey,
    disposition: "consumed",
    origin: "foreground_drain",
    processedBy: "foreground_main_probe",
  });

  summary.recovery = await recoveryDecisionFromUnread(
    client,
    threadId,
    inboxFileName,
    correlationKey,
    sourceRef,
  );

  summary.finalFiles = {
    approvalTarget: await waitForFile(approvalTargetPath, 15_000),
    approvalWrong: await readTextIfExists(approvalWrongPath),
    drainTarget: await waitForFile(drainTargetPath, 15_000),
    drainWrong: await readTextIfExists(drainWrongPath),
    inbox: await readDirSafe(inboxDir),
    processed: await readDirSafe(processedDir),
    processedIndex: await readTextIfExists(path.join(stateDir, "processed_correlation_index.md")),
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.inboxRetainedBeforeDrain === true &&
    summary.beforeDrainTurnCount === 1 &&
    summary.afterDrainTurnCount === 2 &&
    summary.processed?.receipt?.correlation_key === correlationKey &&
    summary.recovery?.decision === "skipped_duplicate" &&
    summary.recovery.beforeTurnCount === 2 &&
    summary.recovery.afterTurnCount === 2 &&
    summary.finalFiles.approvalTarget === "post-approval-processed-lane-ok\n" &&
    summary.finalFiles.approvalWrong === null &&
    summary.finalFiles.drainTarget === "post-approval-processed-drain-ok\n" &&
    summary.finalFiles.drainWrong === null &&
    summary.finalFiles.inbox.includes(inboxFileName) &&
    summary.finalFiles.processed.length >= 2
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
  throw new Error(summary.error ?? "post approval drain processed recovery probe failed");
}
