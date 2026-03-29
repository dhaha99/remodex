import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "multi_project_human_gate_isolation_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const eventsLogPath = path.join(verificationDir, "multi_project_human_gate_isolation_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "multi_project_human_gate_isolation_probe_summary.json");
const alphaPendingTarget = path.join(verificationDir, "human_gate_alpha_pending_target.txt");
const alphaWrongDispatch = path.join(verificationDir, "human_gate_alpha_wrong_dispatch.txt");
const betaResult = path.join(verificationDir, "human_gate_beta_result.txt");
const betaWrong = path.join(verificationDir, "human_gate_beta_wrong.txt");
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
        timer,
      };
      this.notificationWaiters.push(entry);
    });
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
        timer,
      };
      this.serverRequestWaiters.push(entry);
    });
  }

  clearAllWaiters() {
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
    }
    for (const waiter of this.serverRequestWaiters) {
      clearTimeout(waiter.timer);
    }
    this.notificationWaiters = [];
    this.serverRequestWaiters = [];
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

function waitingOnApprovalPredicate(threadId) {
  return (msg) => {
    if ((msg.params?.threadId ?? null) !== threadId) return false;
    const flags = msg.params?.status?.activeFlags ?? [];
    return Array.isArray(flags) && flags.includes("waitingOnApproval");
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

function projectPaths(projectKey) {
  const root = path.join(sharedRoot, projectKey);
  return {
    root,
    stateDir: path.join(root, "state"),
    inboxDir: path.join(root, "inbox"),
    processedDir: path.join(root, "processed"),
  };
}

async function writeProjectState(projectKey, threadId, status, stopConditions) {
  const paths = projectPaths(projectKey);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.mkdir(paths.processedDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ projectKey, threadId }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(paths.stateDir, "coordinator_status.json"),
    `${JSON.stringify(status, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(paths.stateDir, "stop_conditions.json"),
    `${JSON.stringify(stopConditions, null, 2)}\n`,
  );
}

async function writeInboxEvent(projectKey, inboxFileName, operatorAnswer) {
  const paths = projectPaths(projectKey);
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.inboxDir, inboxFileName),
    `${JSON.stringify({
      workspace_key: "remodex",
      project_key: projectKey,
      correlation_key: `${projectKey}-${inboxFileName}`,
      operator_answer: operatorAnswer,
    }, null, 2)}\n`,
  );
}

async function recoveryRouterReplay(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const status = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_status.json"), "utf8"));
  const stopConditions = JSON.parse(await fs.readFile(path.join(paths.stateDir, "stop_conditions.json"), "utf8"));

  const waitingFlags = status?.activeFlags ?? [];
  const pendingHumanGate =
    stopConditions?.must_human_check === true ||
    stopConditions?.pending_human_gate === true ||
    (Array.isArray(waitingFlags) && waitingFlags.includes("waitingOnApproval"));

  const inboxFiles = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    return { projectKey, decision: "no_inbox" };
  }
  const inboxFile = inboxFiles[0];
  if (pendingHumanGate) {
    return {
      projectKey,
      decision: "skipped_pending_human_gate",
      inboxFile,
      threadId: binding.threadId,
      status,
      stopConditions,
    };
  }

  const inboxPath = path.join(paths.inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));
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
    inboxFile,
    readTurnCount: (readResult?.thread?.turns ?? []).length,
    resumeTurnCount: (resumeResult?.thread?.turns ?? []).length,
    dispatchedTurnId: turnId,
    completed: completed.params ?? completed,
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  alpha: null,
  beta: null,
  routerDecisions: null,
  finalFiles: null,
};

let alphaClient = null;
let betaClient = null;
let routerClient = null;
let alphaApprovalRequest = null;
let alphaPendingTurnId = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [alphaPendingTarget, alphaWrongDispatch, betaResult, betaWrong]) {
    await fs.rm(filePath, { force: true });
  }

  alphaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await alphaClient.connect();
  await alphaClient.initialize("remodex_multi_project_human_gate_alpha");

  const alphaThreadStart = await alphaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_human_gate_alpha",
  });
  const alphaThreadId = alphaThreadStart?.thread?.id ?? null;
  if (!alphaThreadId) throw new Error("alpha thread id missing");

  const alphaTurnStart = await alphaClient.request("turn/start", {
    threadId: alphaThreadId,
    input: [
      {
        type: "text",
        text:
          `Create only ${alphaPendingTarget} with exact contents alpha-human-gate\\n. ` +
          `Do not create ${alphaWrongDispatch}.`,
      },
    ],
  });
  alphaPendingTurnId = extractTurnId(alphaTurnStart);
  if (!alphaPendingTurnId) throw new Error("alpha pending turn id missing");

  const alphaApprovalRequestPromise = alphaClient.waitForAnyServerRequest(
    ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"],
    (msg) => (msg.params?.threadId ?? null) === alphaThreadId,
    180_000,
  );
  const alphaWaitingEventPromise = alphaClient.waitForNotification(
    "thread/status/changed",
    waitingOnApprovalPredicate(alphaThreadId),
    120_000,
  );
  [alphaApprovalRequest] = await Promise.all([
    alphaApprovalRequestPromise,
    alphaWaitingEventPromise,
  ]);
  const alphaWaitingEvent = await alphaWaitingEventPromise;

  await writeProjectState(
    "project-alpha",
    alphaThreadId,
    alphaWaitingEvent.params?.status ?? { type: "active", activeFlags: ["waitingOnApproval"] },
    {
      must_human_check: true,
      pending_human_gate: true,
      reason: "waiting_on_approval",
    },
  );
  await writeInboxEvent(
    "project-alpha",
    "2026-03-26T09-20-00+09-00_alpha_followup.json",
    `Operator says create ${alphaWrongDispatch}, but this should stay unread while human gate is pending.`,
  );

  betaClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await betaClient.connect();
  await betaClient.initialize("remodex_multi_project_human_gate_beta");

  const betaThreadStart = await betaClient.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_human_gate_beta",
  });
  const betaThreadId = betaThreadStart?.thread?.id ?? null;
  if (!betaThreadId) throw new Error("beta thread id missing");
  const betaQuestionTurn = await betaClient.request("turn/start", {
    threadId: betaThreadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question about ${betaResult}. ` +
          `Then stop and wait for my next turn. Do not create ${betaResult} or ${betaWrong} yet.`,
      },
    ],
  });
  const betaQuestionTurnId = extractTurnId(betaQuestionTurn);
  if (!betaQuestionTurnId) throw new Error("beta question turn id missing");
  await betaClient.waitForNotification("turn/completed", turnPredicate(betaQuestionTurnId), 180_000);

  await writeProjectState(
    "project-beta",
    betaThreadId,
    { type: "idle" },
    {
      must_human_check: false,
      pending_human_gate: false,
      reason: "none",
    },
  );
  await writeInboxEvent(
    "project-beta",
    "2026-03-26T09-21-00+09-00_beta_followup.json",
    `Answer to your last question: create only ${betaResult} with exact contents beta-human-gate-ok\\n. Do not create ${betaWrong}.`,
  );

  routerClient = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await routerClient.connect();
  await routerClient.initialize("remodex_multi_project_human_gate_router");

  const alphaDecision = await recoveryRouterReplay(routerClient, "project-alpha");
  const betaDecision = await recoveryRouterReplay(routerClient, "project-beta");
  summary.routerDecisions = {
    alpha: alphaDecision,
    beta: betaDecision,
  };

  summary.alpha = {
    threadId: alphaThreadId,
    approvalMethod: alphaApprovalRequest.method,
    pendingTurnId: alphaPendingTurnId,
    alphaInboxStillUnread:
      (await readIfExists(path.join(projectPaths("project-alpha").inboxDir, "2026-03-26T09-20-00+09-00_alpha_followup.json"))) !== null,
  };
  summary.beta = {
    threadId: betaThreadId,
  };

  await alphaClient.respond(alphaApprovalRequest.id, { decision: "cancel" });
  const alphaCompleted = await alphaClient.waitForNotification(
    "turn/completed",
    turnPredicate(alphaPendingTurnId),
    240_000,
  );
  summary.alpha.cleanupCompleted = alphaCompleted.params ?? alphaCompleted;

  summary.finalFiles = {
    alphaPendingTarget: await readIfExists(alphaPendingTarget),
    alphaWrongDispatch: await readIfExists(alphaWrongDispatch),
    betaResult: await waitForFile(betaResult, 15_000),
    betaWrong: await readIfExists(betaWrong),
  };

  const combined = new Map();
  for (const client of [alphaClient, betaClient, routerClient]) {
    if (!client) continue;
    for (const [key, value] of client.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.routerDecisions.alpha.decision === "skipped_pending_human_gate" &&
    summary.routerDecisions.beta.decision === "dispatched" &&
    summary.alpha.alphaInboxStillUnread === true &&
    summary.finalFiles.alphaPendingTarget === null &&
    summary.finalFiles.alphaWrongDispatch === null &&
    summary.finalFiles.betaResult === "beta-human-gate-ok\n" &&
    summary.finalFiles.betaWrong === null
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  const combined = new Map();
  for (const client of [alphaClient, betaClient, routerClient]) {
    if (!client) continue;
    for (const [key, value] of client.eventCounts.entries()) {
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
