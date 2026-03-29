import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "contract_driven_correlation_router_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const strategyPath = path.join(workspace, "STRATEGY.md");
const promptContractPath = path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md");
const eventsLogPath = path.join(verificationDir, "contract_driven_correlation_router_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "contract_driven_correlation_router_probe_summary.json");
const alphaFile = path.join(verificationDir, "contract_driven_alpha.txt");
const betaFile = path.join(verificationDir, "contract_driven_beta.txt");
const alphaWrong = path.join(verificationDir, "contract_driven_alpha_wrong.txt");
const betaWrong = path.join(verificationDir, "contract_driven_beta_wrong.txt");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const sharedCorrelationKey = "contract-driven-correlation-001";

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

function parseMachineGuard(docText, keys) {
  const result = {};
  for (const key of keys) {
    const match = docText.match(new RegExp(String.raw`${key}: ([^\n]+)`));
    if (!match) throw new Error(`missing machine-checkable guard: ${key}`);
    result[key] = match[1].replaceAll("`", "").trim();
  }
  return result;
}

async function readContractGuards() {
  const strategyText = await fs.readFile(strategyPath, "utf8");
  const promptText = await fs.readFile(promptContractPath, "utf8");

  const strategyGuard = parseMachineGuard(strategyText, [
    "processed_receipt_required",
    "processed_dedupe_scope",
    "processed_dedupe_key",
    "recovery_replay_skip_if_processed",
    "foreground_drain_must_record_processed_receipt",
  ]);
  const promptGuard = parseMachineGuard(promptText, [
    "replay_guard_source",
    "replay_guard_scope",
    "replay_guard_key",
    "replay_guard_required_before_unread_replay",
  ]);

  return { strategyGuard, promptGuard };
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

async function seedProcessedReceipt(projectKey, processedFile) {
  const paths = projectPaths(projectKey);
  await writeJson(path.join(paths.processedDir, processedFile), {
    workspace_key: "remodex",
    project_key: projectKey,
    source_ref: processedFile,
    correlation_key: sharedCorrelationKey,
    processed_at: new Date().toISOString(),
    processed_by: "contract_probe_seed",
    disposition: "consumed",
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

async function contractAwareReplayProject(client, projectKey, guards) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    return { projectKey, decision: "no_inbox" };
  }
  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));

  let processedCandidates = [];
  if (guards.promptGuard.replay_guard_scope === "project_local" || guards.strategyGuard.processed_dedupe_scope === "project_local") {
    processedCandidates = (await fs.readdir(paths.processedDir)).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(paths.processedDir, name));
  } else {
    const allProjects = await fs.readdir(sharedRoot);
    for (const candidateProject of allProjects) {
      const candidateDir = path.join(sharedRoot, candidateProject, "processed");
      try {
        const names = (await fs.readdir(candidateDir)).filter((name) => name.endsWith(".json")).sort();
        processedCandidates.push(...names.map((name) => path.join(candidateDir, name)));
      } catch {}
    }
  }

  if (
    guards.strategyGuard.recovery_replay_skip_if_processed === "true" &&
    guards.promptGuard.replay_guard_required_before_unread_replay === "true"
  ) {
    for (const candidate of processedCandidates) {
      const processed = JSON.parse(await fs.readFile(candidate, "utf8"));
      const keyName = guards.strategyGuard.processed_dedupe_key;
      if (processed[keyName] === event[keyName]) {
        return {
          projectKey,
          decision: "skipped_duplicate_correlation",
          inboxFile,
          correlationKey: event[keyName],
          processedFile: path.basename(candidate),
          processedProject: path.basename(path.dirname(path.dirname(candidate))),
          threadId: binding.threadId,
        };
      }
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
  if (!turnId) throw new Error(`missing turn id for ${projectKey}`);
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
    completed: completed.params ?? completed,
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  contractGuards: null,
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

  summary.contractGuards = await readContractGuards();

  alphaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await alphaClient.connect();
  await alphaClient.initialize("remodex_contract_driven_alpha");
  const alphaThreadStart = await alphaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_contract_driven_alpha",
  });
  const alphaThreadId = alphaThreadStart?.thread?.id ?? null;
  if (!alphaThreadId) throw new Error("alpha thread id missing");
  const alphaQuestionTurnId = await askOneQuestion(alphaClient, alphaThreadId, alphaFile, alphaWrong);
  await seedBinding("project-alpha", alphaThreadId);
  await seedInbox(
    "project-alpha",
    "2026-03-26T10-10-00+09-00_alpha_followup.json",
    `Answer to your last question: create only ${alphaFile} with exact contents alpha-contract-should-skip\\n. Do not create ${alphaWrong}.`,
  );
  await seedProcessedReceipt("project-alpha", "2026-03-26T10-09-59+09-00_alpha_processed.json");

  betaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await betaClient.connect();
  await betaClient.initialize("remodex_contract_driven_beta");
  const betaThreadStart = await betaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_contract_driven_beta",
  });
  const betaThreadId = betaThreadStart?.thread?.id ?? null;
  if (!betaThreadId) throw new Error("beta thread id missing");
  const betaQuestionTurnId = await askOneQuestion(betaClient, betaThreadId, betaFile, betaWrong);
  await seedBinding("project-beta", betaThreadId);
  await seedInbox(
    "project-beta",
    "2026-03-26T10-10-01+09-00_beta_followup.json",
    `Answer to your last question: create only ${betaFile} with exact contents beta-contract-ok\\n. Do not create ${betaWrong}.`,
  );

  routerClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await routerClient.connect();
  await routerClient.initialize("remodex_contract_driven_router");

  const alphaDecision = await contractAwareReplayProject(routerClient, "project-alpha", summary.contractGuards);
  const betaDecision = await contractAwareReplayProject(routerClient, "project-beta", summary.contractGuards);

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
    summary.contractGuards.strategyGuard.processed_dedupe_scope === "project_local" &&
    summary.contractGuards.strategyGuard.processed_dedupe_key === "correlation_key" &&
    summary.contractGuards.promptGuard.replay_guard_key === "correlation_key" &&
    summary.alpha.decision.decision === "skipped_duplicate_correlation" &&
    summary.alpha.decision.processedProject === "project-alpha" &&
    summary.beta.decision.decision === "dispatched" &&
    summary.finalFiles.alphaFile === null &&
    summary.finalFiles.alphaWrong === null &&
    summary.finalFiles.betaFile === "beta-contract-ok\n" &&
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
