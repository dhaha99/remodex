import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "multi_project_processed_correlation_dedupe_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const eventsLogPath = path.join(verificationDir, "multi_project_processed_correlation_dedupe_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "multi_project_processed_correlation_dedupe_probe_summary.json");
const alphaFile = path.join(verificationDir, "multi_project_processed_dedupe_alpha.txt");
const betaFile = path.join(verificationDir, "multi_project_processed_dedupe_beta.txt");
const alphaWrong = path.join(verificationDir, "multi_project_processed_dedupe_alpha_wrong.txt");
const betaWrong = path.join(verificationDir, "multi_project_processed_dedupe_beta_wrong.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const sharedCorrelationKey = "cross-project-correlation-001";

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
  };
}

async function seedBinding(projectKey, threadId) {
  const paths = projectPaths(projectKey);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.mkdir(paths.processedDir, { recursive: true });
  await writeJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId,
  });
}

async function seedInbox(projectKey, inboxFile, operatorAnswer) {
  const paths = projectPaths(projectKey);
  await writeJson(path.join(paths.inboxDir, inboxFile), {
    workspace_key: "remodex",
    project_key: projectKey,
    correlation_key: sharedCorrelationKey,
    operator_answer: operatorAnswer,
  });
}

async function seedProcessedReceipt(projectKey, processedFile, disposition) {
  const paths = projectPaths(projectKey);
  await writeJson(path.join(paths.processedDir, processedFile), {
    workspace_key: "remodex",
    project_key: projectKey,
    source_ref: processedFile,
    correlation_key: sharedCorrelationKey,
    processed_at: new Date().toISOString(),
    processed_by: "probe_seed",
    disposition,
    origin: "foreground_drain",
  });
}

async function askOneQuestion(client, threadId, targetFile, wrongFile) {
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
  const turnId = extractTurnId(questionTurn);
  if (!turnId) throw new Error("question turn id missing");
  await client.waitForNotification("turn/completed", turnPredicate(turnId), 180_000);
  return turnId;
}

async function safeReplayProject(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    return { projectKey, decision: "no_inbox" };
  }

  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
  const processedFiles = (await fs.readdir(paths.processedDir)).filter((name) => name.endsWith(".json")).sort();

  for (const processedFile of processedFiles) {
    const processed = JSON.parse(await fs.readFile(path.join(paths.processedDir, processedFile), "utf8"));
    if (processed.correlation_key === event.correlation_key) {
      return {
        projectKey,
        decision: "skipped_duplicate_correlation",
        inboxFile,
        processedFile,
        correlationKey: event.correlation_key,
        threadId: binding.threadId,
      };
    }
  }

  const readResult = await client.request("thread/read", {
    threadId: binding.threadId,
    includeTurns: true,
  });
  const resumeResult = await client.request("thread/resume", {
    threadId: binding.threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  const turnStart = await client.request("turn/start", {
    threadId: binding.threadId,
    input: [{ type: "text", text: event.operator_answer }],
  });
  const turnId = extractTurnId(turnStart);
  if (!turnId) throw new Error(`missing replay turn id for ${projectKey}`);
  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  await fs.rename(inboxPath, path.join(paths.processedDir, inboxFile));

  return {
    projectKey,
    decision: "dispatched",
    threadId: binding.threadId,
    correlationKey: event.correlation_key,
    readTurnCount: (readResult?.thread?.turns ?? []).length,
    resumeTurnCount: (resumeResult?.thread?.turns ?? []).length,
    dispatchedTurnId: turnId,
    processedInboxFile: inboxFile,
    completed: completed.params ?? completed,
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  alpha: null,
  beta: null,
  finalFiles: null,
};

let alphaClient = null;
let betaClient = null;
let routerClient = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [alphaFile, betaFile, alphaWrong, betaWrong]) {
    await fs.rm(filePath, { force: true });
  }

  alphaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await alphaClient.connect();
  await alphaClient.initialize("remodex_multi_project_processed_dedupe_alpha");
  const alphaThreadStart = await alphaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_processed_dedupe_alpha",
  });
  const alphaThreadId = alphaThreadStart?.thread?.id ?? null;
  if (!alphaThreadId) throw new Error("alpha thread id missing");
  const alphaQuestionTurnId = await askOneQuestion(alphaClient, alphaThreadId, alphaFile, alphaWrong);
  await seedBinding("project-alpha", alphaThreadId);
  await seedInbox(
    "project-alpha",
    "2026-03-26T10-00-00+09-00_alpha_followup.json",
    `Answer to your last question: create only ${alphaFile} with exact contents alpha-should-not-run\\n. Do not create ${alphaWrong}.`,
  );
  await seedProcessedReceipt("project-alpha", "2026-03-26T09-59-59+09-00_alpha_processed.json", "consumed");

  betaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await betaClient.connect();
  await betaClient.initialize("remodex_multi_project_processed_dedupe_beta");
  const betaThreadStart = await betaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_processed_dedupe_beta",
  });
  const betaThreadId = betaThreadStart?.thread?.id ?? null;
  if (!betaThreadId) throw new Error("beta thread id missing");
  const betaQuestionTurnId = await askOneQuestion(betaClient, betaThreadId, betaFile, betaWrong);
  await seedBinding("project-beta", betaThreadId);
  await seedInbox(
    "project-beta",
    "2026-03-26T10-00-01+09-00_beta_followup.json",
    `Answer to your last question: create only ${betaFile} with exact contents beta-dedupe-ok\\n. Do not create ${betaWrong}.`,
  );

  routerClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await routerClient.connect();
  await routerClient.initialize("remodex_multi_project_processed_dedupe_router");

  const alphaDecision = await safeReplayProject(routerClient, "project-alpha");
  const betaDecision = await safeReplayProject(routerClient, "project-beta");

  summary.alpha = {
    threadId: alphaThreadId,
    questionTurnId: alphaQuestionTurnId,
    decision: alphaDecision,
  };
  summary.beta = {
    threadId: betaThreadId,
    questionTurnId: betaQuestionTurnId,
    decision: betaDecision,
  };
  summary.finalFiles = {
    alphaFile: await readIfExists(alphaFile),
    alphaWrong: await readIfExists(alphaWrong),
    betaFile: await waitForFile(betaFile, 15_000),
    betaWrong: await readIfExists(betaWrong),
  };

  const combined = new Map();
  for (const currentClient of [alphaClient, betaClient, routerClient]) {
    if (!currentClient) continue;
    for (const [key, value] of currentClient.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.alpha.decision.decision === "skipped_duplicate_correlation" &&
    summary.alpha.decision.correlationKey === sharedCorrelationKey &&
    summary.beta.decision.decision === "dispatched" &&
    summary.beta.decision.correlationKey === sharedCorrelationKey &&
    summary.finalFiles.alphaFile === null &&
    summary.finalFiles.alphaWrong === null &&
    summary.finalFiles.betaFile === "beta-dedupe-ok\n" &&
    summary.finalFiles.betaWrong === null
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  const combined = new Map();
  for (const currentClient of [alphaClient, betaClient, routerClient]) {
    if (!currentClient) continue;
    for (const [key, value] of currentClient.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  alphaClient?.clearAllWaiters();
  betaClient?.clearAllWaiters();
  routerClient?.clearAllWaiters();
  alphaClient?.close();
  betaClient?.close();
  routerClient?.close();
}
