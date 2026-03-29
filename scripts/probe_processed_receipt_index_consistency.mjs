import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "processed_receipt_index_consistency_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const eventsLogPath = path.join(verificationDir, "processed_receipt_index_consistency_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "processed_receipt_index_consistency_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

const alphaTarget = path.join(verificationDir, "index_consistency_alpha.txt");
const betaTarget = path.join(verificationDir, "index_consistency_beta.txt");
const gammaTarget = path.join(verificationDir, "index_consistency_gamma.txt");
const deltaTarget = path.join(verificationDir, "index_consistency_delta.txt");
const alphaWrong = path.join(verificationDir, "index_consistency_alpha_wrong.txt");
const betaWrong = path.join(verificationDir, "index_consistency_beta_wrong.txt");
const gammaWrong = path.join(verificationDir, "index_consistency_gamma_wrong.txt");
const deltaWrong = path.join(verificationDir, "index_consistency_delta_wrong.txt");

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
    for (const waiter of this.notificationWaiters) clearTimeout(waiter.timer);
    this.notificationWaiters = [];
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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectPaths(projectKey) {
  const root = path.join(sharedRoot, projectKey);
  return {
    root,
    stateDir: path.join(root, "state"),
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
    dispatchQueueDir: path.join(root, "dispatch_queue"),
  };
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

async function readProcessedIndexEntries(projectKey) {
  const indexPath = path.join(projectPaths(projectKey).stateDir, "processed_correlation_index.md");
  const text = await readIfExists(indexPath);
  if (!text) return [];
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return [];
  const parsed = JSON.parse(match[1]);
  return parsed.entries ?? [];
}

async function appendProcessedIndexEntry(projectKey, entry) {
  const indexPath = path.join(projectPaths(projectKey).stateDir, "processed_correlation_index.md");
  const entries = await readProcessedIndexEntries(projectKey);
  entries.push(entry);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, renderProcessedIndex(entries));
  return entries;
}

async function seedProjectState(projectKey, threadId, toggleState) {
  const paths = projectPaths(projectKey);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.mkdir(paths.processedDir, { recursive: true });
  await fs.mkdir(paths.dispatchQueueDir, { recursive: true });
  await writeJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId,
  });
  await writeJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
    activeFlags: [],
  });
  await writeJson(path.join(paths.stateDir, "background_trigger_toggle.json"), toggleState);
  await fs.writeFile(path.join(paths.stateDir, "processed_correlation_index.md"), renderProcessedIndex([]));
}

async function seedInbox(projectKey, filename, operatorAnswer, correlationKey) {
  const paths = projectPaths(projectKey);
  const record = {
    workspace_key: "remodex",
    project_key: projectKey,
    source_ref: filename,
    correlation_key: correlationKey,
    operator_answer: operatorAnswer,
  };
  await writeJson(path.join(paths.inboxDir, filename), record);
  return record;
}

async function seedDispatchTicket(projectKey, filename, inboxFilename, operatorAnswer, correlationKey) {
  const paths = projectPaths(projectKey);
  const record = {
    source_ref: inboxFilename,
    correlation_key: correlationKey,
    operator_answer: operatorAnswer,
    blocked_reasons: ["foreground_session_active"],
  };
  await writeJson(path.join(paths.dispatchQueueDir, filename), record);
  return record;
}

async function recordProcessedReceipt(projectKey, {
  sourceRef,
  correlationKey,
  processedBy,
  disposition,
  origin,
}) {
  const paths = projectPaths(projectKey);
  const receiptName = `${new Date().toISOString().replaceAll(":", "-")}_${correlationKey}_${disposition}.json`;
  const receipt = {
    workspace_key: "remodex",
    project_key: projectKey,
    namespace_ref: `remodex/${projectKey}`,
    source_ref: sourceRef,
    correlation_key: correlationKey,
    processed_at: new Date().toISOString(),
    processed_by: processedBy,
    disposition,
    origin,
  };
  await writeJson(path.join(paths.processedDir, receiptName), receipt);
  const indexEntry = {
    correlation_key: correlationKey,
    source_ref: sourceRef,
    disposition,
    origin,
    processed_at: receipt.processed_at,
    processed_by: processedBy,
    processed_receipt: receiptName,
  };
  const entries = await appendProcessedIndexEntry(projectKey, indexEntry);
  return { receiptName, receipt, indexEntry, indexEntries: entries };
}

async function setupQuestionThread(client, projectKey, targetFile, wrongFile, toggleState) {
  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: `probe_${projectKey}`,
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error(`${projectKey} thread id missing`);
  await seedProjectState(projectKey, threadId, toggleState);

  const questionTurn = await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question about ${targetFile}. ` +
          `Then stop and wait for my next turn. Do not create ${targetFile} or ${wrongFile} yet.`,
      },
    ],
  });
  const questionTurnId = extractTurnId(questionTurn);
  if (!questionTurnId) throw new Error(`${projectKey} question turn id missing`);
  await client.waitForNotification("turn/completed", turnPredicate(questionTurnId), 180_000);
  return { threadId, questionTurnId };
}

async function readTurnCount(client, threadId) {
  const result = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  return (result?.thread?.turns ?? []).length;
}

async function dispatchAnswer(client, threadId, operatorAnswer) {
  const readResult = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
  const resumeResult = await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  const turnStart = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: operatorAnswer }],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error(`missing dispatch turn id for ${threadId}`);
  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  const afterTurnCount = await readTurnCount(client, threadId);
  return {
    beforeTurnCount: (readResult?.thread?.turns ?? []).length,
    resumeTurnCount: (resumeResult?.thread?.turns ?? []).length,
    afterTurnCount,
    dispatchedTurnId: turnId,
    completed: completed.params ?? completed,
  };
}

async function foregroundDrainProject(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const queueFile = (await fs.readdir(paths.dispatchQueueDir)).filter((name) => name.endsWith(".json")).sort()[0];
  const ticketPath = path.join(paths.dispatchQueueDir, queueFile);
  const ticket = JSON.parse(await fs.readFile(ticketPath, "utf8"));
  const dispatch = await dispatchAnswer(client, binding.threadId, ticket.operator_answer);
  const processed = await recordProcessedReceipt(projectKey, {
    sourceRef: ticket.source_ref,
    correlationKey: ticket.correlation_key,
    processedBy: "foreground_main_probe",
    disposition: "consumed",
    origin: "foreground_drain",
  });
  await fs.rm(ticketPath, { force: true });
  await fs.rm(path.join(paths.inboxDir, ticket.source_ref), { force: true });
  return { queueFile, ticket, dispatch, processed };
}

async function directDeliverProject(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const toggle = JSON.parse(await fs.readFile(path.join(paths.stateDir, "background_trigger_toggle.json"), "utf8"));
  const status = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_status.json"), "utf8"));
  const inboxFile = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort()[0];
  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  if (!toggle.background_trigger_enabled || toggle.foreground_session_active || !["idle", "checkpoint_open"].includes(status.type)) {
    throw new Error(`${projectKey} direct delivery gate failed`);
  }
  const dispatch = await dispatchAnswer(client, binding.threadId, event.operator_answer);
  const processed = await recordProcessedReceipt(projectKey, {
    sourceRef: event.source_ref,
    correlationKey: event.correlation_key,
    processedBy: "bridge_direct_probe",
    disposition: "consumed",
    origin: "direct_delivery",
  });
  await fs.rm(inboxPath, { force: true });
  return { inboxFile, event, dispatch, processed };
}

async function recoveryReplayProject(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFile = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort()[0];
  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  const dispatch = await dispatchAnswer(client, binding.threadId, event.operator_answer);
  const processed = await recordProcessedReceipt(projectKey, {
    sourceRef: event.source_ref,
    correlationKey: event.correlation_key,
    processedBy: "recovery_router_probe",
    disposition: "consumed",
    origin: "recovery_replay",
  });
  await fs.rm(inboxPath, { force: true });
  return { inboxFile, event, dispatch, processed };
}

async function safeSkipProject(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFile = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort()[0];
  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  const beforeTurnCount = await readTurnCount(client, binding.threadId);
  const indexEntries = await readProcessedIndexEntries(projectKey);
  const processedFiles = (await fs.readdir(paths.processedDir)).filter((name) => name.endsWith(".json")).sort();
  const duplicateInIndex = indexEntries.some((entry) => entry.correlation_key === event.correlation_key);
  let duplicateInReceipt = false;
  for (const name of processedFiles) {
    const receipt = JSON.parse(await fs.readFile(path.join(paths.processedDir, name), "utf8"));
    if (receipt.correlation_key === event.correlation_key) {
      duplicateInReceipt = true;
      break;
    }
  }
  if (!duplicateInIndex && !duplicateInReceipt) {
    throw new Error(`${projectKey} duplicate skip precondition missing`);
  }
  const processed = await recordProcessedReceipt(projectKey, {
    sourceRef: event.source_ref,
    correlationKey: event.correlation_key,
    processedBy: "recovery_router_probe",
    disposition: "skipped_duplicate",
    origin: "recovery_replay",
  });
  await fs.rm(inboxPath, { force: true });
  const afterTurnCount = await readTurnCount(client, binding.threadId);
  return {
    inboxFile,
    event,
    duplicateInIndex,
    duplicateInReceipt,
    beforeTurnCount,
    afterTurnCount,
    processed,
  };
}

function latestIndexEntry(result) {
  return result.processed.indexEntries[result.processed.indexEntries.length - 1] ?? null;
}

function receiptMatchesIndex(result, expectedOrigin, expectedDisposition) {
  const entry = latestIndexEntry(result);
  return (
    result.processed.receipt.origin === expectedOrigin &&
    result.processed.receipt.disposition === expectedDisposition &&
    entry?.origin === expectedOrigin &&
    entry?.disposition === expectedDisposition &&
    entry?.correlation_key === result.processed.receipt.correlation_key &&
    entry?.source_ref === result.processed.receipt.source_ref &&
    entry?.processed_receipt === result.processed.receiptName
  );
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  alpha: null,
  beta: null,
  gamma: null,
  delta: null,
  finalFiles: null,
};

let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [
    alphaTarget,
    betaTarget,
    gammaTarget,
    deltaTarget,
    alphaWrong,
    betaWrong,
    gammaWrong,
    deltaWrong,
  ]) {
    await fs.rm(filePath, { force: true });
  }

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("processed_receipt_index_consistency_probe");

  const alphaSetup = await setupQuestionThread(client, "project-alpha", alphaTarget, alphaWrong, {
    background_trigger_enabled: true,
    foreground_session_active: true,
    foreground_lock_enabled: true,
    mode: "foreground",
  });
  await seedInbox(
    "project-alpha",
    "2026-03-26T10-40-00+09-00_alpha_followup.json",
    `Answer to your last question: create only ${alphaTarget} with exact contents alpha-foreground-ok\\n. Do not create ${alphaWrong}.`,
    "consistency-foreground-001",
  );
  await seedDispatchTicket(
    "project-alpha",
    "2026-03-26T10-40-00+09-00_alpha_followup.json",
    "2026-03-26T10-40-00+09-00_alpha_followup.json",
    `Answer to your last question: create only ${alphaTarget} with exact contents alpha-foreground-ok\\n. Do not create ${alphaWrong}.`,
    "consistency-foreground-001",
  );
  const alphaResult = await foregroundDrainProject(client, "project-alpha");

  const betaSetup = await setupQuestionThread(client, "project-beta", betaTarget, betaWrong, {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
    mode: "background",
  });
  await seedInbox(
    "project-beta",
    "2026-03-26T10-41-00+09-00_beta_followup.json",
    `Answer to your last question: create only ${betaTarget} with exact contents beta-direct-ok\\n. Do not create ${betaWrong}.`,
    "consistency-direct-001",
  );
  const betaResult = await directDeliverProject(client, "project-beta");

  const gammaSetup = await setupQuestionThread(client, "project-gamma", gammaTarget, gammaWrong, {
    background_trigger_enabled: false,
    foreground_session_active: false,
    foreground_lock_enabled: false,
    mode: "recovery",
  });
  await seedInbox(
    "project-gamma",
    "2026-03-26T10-42-00+09-00_gamma_followup.json",
    `Answer to your last question: create only ${gammaTarget} with exact contents gamma-recovery-ok\\n. Do not create ${gammaWrong}.`,
    "consistency-recovery-001",
  );
  const gammaResult = await recoveryReplayProject(client, "project-gamma");

  const deltaSetup = await setupQuestionThread(client, "project-delta", deltaTarget, deltaWrong, {
    background_trigger_enabled: false,
    foreground_session_active: false,
    foreground_lock_enabled: false,
    mode: "recovery",
  });
  await recordProcessedReceipt("project-delta", {
    sourceRef: "2026-03-26T10-43-00+09-00_delta_previous.json",
    correlationKey: "consistency-skip-001",
    processedBy: "seeded_previous_run",
    disposition: "consumed",
    origin: "recovery_replay",
  });
  await seedInbox(
    "project-delta",
    "2026-03-26T10-43-01+09-00_delta_followup.json",
    `Answer to your last question: create only ${deltaTarget} with exact contents delta-should-not-exist\\n. Do not create ${deltaWrong}.`,
    "consistency-skip-001",
  );
  const deltaResult = await safeSkipProject(client, "project-delta");

  summary.alpha = {
    ...alphaSetup,
    result: alphaResult,
    indexPath: path.join(projectPaths("project-alpha").stateDir, "processed_correlation_index.md"),
  };
  summary.beta = {
    ...betaSetup,
    result: betaResult,
    indexPath: path.join(projectPaths("project-beta").stateDir, "processed_correlation_index.md"),
  };
  summary.gamma = {
    ...gammaSetup,
    result: gammaResult,
    indexPath: path.join(projectPaths("project-gamma").stateDir, "processed_correlation_index.md"),
  };
  summary.delta = {
    ...deltaSetup,
    result: deltaResult,
    indexPath: path.join(projectPaths("project-delta").stateDir, "processed_correlation_index.md"),
  };

  summary.finalFiles = {
    alphaTarget: await waitForFile(alphaTarget, 15_000),
    betaTarget: await waitForFile(betaTarget, 15_000),
    gammaTarget: await waitForFile(gammaTarget, 15_000),
    deltaTarget: await readIfExists(deltaTarget),
    alphaWrong: await readIfExists(alphaWrong),
    betaWrong: await readIfExists(betaWrong),
    gammaWrong: await readIfExists(gammaWrong),
    deltaWrong: await readIfExists(deltaWrong),
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    receiptMatchesIndex(alphaResult, "foreground_drain", "consumed") &&
    receiptMatchesIndex(betaResult, "direct_delivery", "consumed") &&
    receiptMatchesIndex(gammaResult, "recovery_replay", "consumed") &&
    receiptMatchesIndex(deltaResult, "recovery_replay", "skipped_duplicate") &&
    deltaResult.beforeTurnCount === deltaResult.afterTurnCount &&
    summary.finalFiles.alphaTarget === "alpha-foreground-ok\n" &&
    summary.finalFiles.betaTarget === "beta-direct-ok\n" &&
    summary.finalFiles.gammaTarget === "gamma-recovery-ok\n" &&
    summary.finalFiles.deltaTarget === null &&
    summary.finalFiles.alphaWrong === null &&
    summary.finalFiles.betaWrong === null &&
    summary.finalFiles.gammaWrong === null &&
    summary.finalFiles.deltaWrong === null
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = String(error);
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.clearAllWaiters();
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "processed receipt/index consistency probe failed");
}
