import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "multi_project_recovery_router_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const eventsLogPath = path.join(verificationDir, "multi_project_recovery_router_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "multi_project_recovery_router_probe_summary.json");
const alphaFile = path.join(verificationDir, "multi_recovery_alpha.txt");
const betaFile = path.join(verificationDir, "multi_recovery_beta.txt");
const alphaWrongFile = path.join(verificationDir, "multi_recovery_alpha_wrong.txt");
const betaWrongFile = path.join(verificationDir, "multi_recovery_beta_wrong.txt");
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
        timer,
      };
      this.notificationWaiters.push(entry);
    });
  }

  clearAllWaiters() {
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
    }
    this.notificationWaiters = [];
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

async function seedProject(projectKey, threadId, inboxFileName, operatorAnswer) {
  const paths = projectPaths(projectKey);
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.mkdir(paths.inboxDir, { recursive: true });
  await fs.mkdir(paths.processedDir, { recursive: true });
  await fs.writeFile(
    path.join(paths.stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ projectKey, threadId }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(paths.inboxDir, inboxFileName),
    `${JSON.stringify({
      workspace_key: "remodex",
      project_key: projectKey,
      correlation_key: `${projectKey}-recovery-001`,
      operator_answer: operatorAnswer,
    }, null, 2)}\n`,
  );
}

async function runProjectReplay(client, projectKey) {
  const paths = projectPaths(projectKey);
  const binding = JSON.parse(await fs.readFile(path.join(paths.stateDir, "coordinator_binding.json"), "utf8"));
  const inboxFiles = (await fs.readdir(paths.inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    throw new Error(`no inbox files for ${projectKey}`);
  }
  const inboxFile = inboxFiles[0];
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
  if (!turnId) throw new Error(`missing dispatched turn id for ${projectKey}`);
  const completed = await client.waitForNotification("turn/completed", turnPredicate(turnId), 240_000);
  await fs.rename(inboxPath, path.join(paths.processedDir, inboxFile));

  return {
    projectKey,
    threadId: binding.threadId,
    readTurnCount: (readResult?.thread?.turns ?? []).length,
    resumeTurnCount: (resumeResult?.thread?.turns ?? []).length,
    dispatchedTurnId: turnId,
    completed: completed.params ?? completed,
    processedInboxFile: inboxFile,
  };
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  alpha: null,
  beta: null,
  finalFiles: null,
};

let client1 = null;
let client2 = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.writeFile(eventsLogPath, "");
  for (const filePath of [alphaFile, betaFile, alphaWrongFile, betaWrongFile]) {
    await fs.rm(filePath, { force: true });
  }

  client1 = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client1.connect();
  await client1.initialize("remodex_multi_project_recovery_router_phase1");

  const alphaThread = await client1.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_recovery_router_alpha",
  });
  const alphaThreadId = alphaThread?.thread?.id ?? null;
  if (!alphaThreadId) throw new Error("alpha thread id missing");
  const alphaQuestionTurn = await client1.request("turn/start", {
    threadId: alphaThreadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question about ${alphaFile}. ` +
          `Then stop and wait for my next turn. Do not create ${alphaFile} or ${alphaWrongFile} yet.`,
      },
    ],
  });
  const alphaQuestionTurnId = extractTurnId(alphaQuestionTurn);
  await client1.waitForNotification("turn/completed", turnPredicate(alphaQuestionTurnId), 180_000);

  const betaThread = await client1.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_recovery_router_beta",
  });
  const betaThreadId = betaThread?.thread?.id ?? null;
  if (!betaThreadId) throw new Error("beta thread id missing");
  const betaQuestionTurn = await client1.request("turn/start", {
    threadId: betaThreadId,
    input: [
      {
        type: "text",
        text:
          `Before making any file changes, ask exactly one clarifying question about ${betaFile}. ` +
          `Then stop and wait for my next turn. Do not create ${betaFile} or ${betaWrongFile} yet.`,
      },
    ],
  });
  const betaQuestionTurnId = extractTurnId(betaQuestionTurn);
  await client1.waitForNotification("turn/completed", turnPredicate(betaQuestionTurnId), 180_000);

  await seedProject(
    "project-alpha",
    alphaThreadId,
    "2026-03-26T09-10-00+09-00_alpha_answer.json",
    `Answer to your last question: create only ${alphaFile} with exact contents alpha-recovery-ok\\n. Do not create ${alphaWrongFile}.`,
  );
  await seedProject(
    "project-beta",
    betaThreadId,
    "2026-03-26T09-11-00+09-00_beta_answer.json",
    `Answer to your last question: create only ${betaFile} with exact contents beta-recovery-ok\\n. Do not create ${betaWrongFile}.`,
  );

  client1.clearAllWaiters();
  client1.close();
  client1 = null;

  client2 = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client2.connect();
  await client2.initialize("remodex_multi_project_recovery_router_phase2");

  summary.alpha = await runProjectReplay(client2, "project-alpha");
  summary.beta = await runProjectReplay(client2, "project-beta");

  summary.finalFiles = {
    alpha: await waitForFile(alphaFile, 15_000),
    beta: await waitForFile(betaFile, 15_000),
    alphaWrong: await readIfExists(alphaWrongFile),
    betaWrong: await readIfExists(betaWrongFile),
  };
  summary.eventCounts = Object.fromEntries([...client2.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.finalFiles.alpha === "alpha-recovery-ok\n" &&
    summary.finalFiles.beta === "beta-recovery-ok\n" &&
    summary.finalFiles.alphaWrong === null &&
    summary.finalFiles.betaWrong === null
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  const combined = new Map();
  for (const client of [client1, client2]) {
    if (!client) continue;
    for (const [key, value] of client.eventCounts.entries()) {
      combined.set(key, (combined.get(key) ?? 0) + value);
    }
  }
  summary.eventCounts = Object.fromEntries([...combined.entries()].sort());
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client1?.clearAllWaiters();
  client2?.clearAllWaiters();
  client1?.close();
  client2?.close();
}
