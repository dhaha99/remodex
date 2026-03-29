import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const contractPath = path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md");
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "multi_project_routing_probe");
const routerDir = path.join(probeDir, "router");
const quarantineDir = path.join(routerDir, "quarantine");
const alphaDir = path.join(probeDir, "project_alpha");
const betaDir = path.join(probeDir, "project_beta");
const alphaReportPath = path.join(alphaDir, "report_alpha.md");
const betaReportPath = path.join(betaDir, "report_beta.md");
const alphaGuardPath = path.join(alphaDir, "guard.txt");
const betaGuardPath = path.join(betaDir, "guard.txt");
const summaryPath = path.join(verificationDir, "multi_project_routing_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "multi_project_routing_probe_events.jsonl");
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

      if (msg.id !== undefined) {
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

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const content = await readIfExists(filePath);
    if (content !== null) return content;
    await sleep(500);
  }
  return null;
}

async function seedProject({
  projectLabel,
  projectKey,
  namespaceDir,
  threadId,
  strategyVersion,
  roadmapPoint,
  latestValidatedChange,
  activeOwner,
  nextSmallestBatch,
}) {
  const stateDir = path.join(namespaceDir, "state");
  const runtimeDir = path.join(namespaceDir, "runtime");
  const inboxDir = path.join(namespaceDir, "inbox");
  const dispatchDir = path.join(namespaceDir, "dispatch_queue");
  const pulsesDir = path.join(namespaceDir, "pulses");
  const evidenceDir = path.join(namespaceDir, "evidence");

  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(dispatchDir, { recursive: true });
  await fs.mkdir(pulsesDir, { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true });

  await writeText(
    path.join(stateDir, "project_identity.md"),
    `identity: remodex/${projectKey}\nworkspace_key: remodex\nproject_key: ${projectKey}\nnamespace_ref: ${namespaceDir}\n`,
  );
  await writeText(
    path.join(stateDir, "coordinator_lease.md"),
    `lease_holder_role: main_coordinator\ncurrent_thread_ref: ${threadId}\nlease_status: held\n`,
  );
  await writeText(path.join(stateDir, "coordinator_status.md"), "type: idle\n");
  await writeText(
    path.join(stateDir, "prompt_contract_binding.md"),
    `canonical_contract_path: ${contractPath}\ncontract_version: 2026-03-25\n`,
  );
  await writeText(
    path.join(stateDir, "strategy_binding.md"),
    `strategy_version: ${strategyVersion}\nstrategy_label: ${projectLabel}\n`,
  );
  await writeText(
    path.join(stateDir, "roadmap_status.md"),
    `roadmap_current_point: ${roadmapPoint}\nstale: false\n`,
  );
  await writeText(
    path.join(stateDir, "autonomy_policy.md"),
    "autonomous_background_allowed: true\nautonomy_mode: constrained\n",
  );
  await writeText(
    path.join(stateDir, "background_trigger_toggle.md"),
    "background_trigger_enabled: true\nforeground_session_active: false\nforeground_lock_enabled: false\n",
  );
  await writeText(
    path.join(runtimeDir, "scheduler_runtime.md"),
    "scheduler_installed: true\nscheduler_active: true\nscheduler_runtime_state: active_launchd\n",
  );
  await writeText(
    path.join(stateDir, "stop_conditions.md"),
    "must_human_check: false\npending_human_gate: none\nreason: none\n",
  );
  await writeText(path.join(stateDir, "current_goal.md"), `current_goal: ${projectLabel}\n`);
  await writeText(path.join(stateDir, "current_plan.md"), "current_plan: reconstruct and verify routing isolation\n");
  await writeText(path.join(stateDir, "current_focus.md"), "current_focus: project-scoped-routing\n");
  await writeText(path.join(stateDir, "active_owner.md"), `active_owner: ${activeOwner}\n`);
  await writeText(
    path.join(stateDir, "progress_axes.md"),
    `latest_validated_change: ${latestValidatedChange}\nblockers: none\n`,
  );
  await writeText(path.join(stateDir, "deferred_queue.md"), "deferred_queue: none\n");
  await writeText(path.join(stateDir, "pending_artifacts.md"), "pending_artifacts: none\n");
  await writeText(
    path.join(inboxDir, "001_next_batch.md"),
    `next_smallest_batch: ${nextSmallestBatch}\n`,
  );
  await writeText(path.join(dispatchDir, "001_dispatch.md"), "dispatch_status: none\n");
  await writeText(
    path.join(pulsesDir, "backend.md"),
    `verdict: pass\nchanged files: none\nvalidation: seed only\nblocker: none\nnext smallest batch: ${nextSmallestBatch}\nhuman_required: no\n`,
  );
  await writeText(
    path.join(evidenceDir, "001_latest.md"),
    `latest_validated_change: ${latestValidatedChange}\n`,
  );
  await writeText(
    path.join(namespaceDir, "decisions.log"),
    `2026-03-25 adopt ${projectKey} routing verification seed\n`,
  );
}

function buildPrompt({ namespaceDir, reportPath, otherGuardPath }) {
  return (
    `You are resuming as this project's main coordinator. ` +
    `Read ${contractPath} as the canonical contract. ` +
    `Read the shared memory namespace rooted at ${namespaceDir} using the fixed read order from that contract. ` +
    `Then write exactly one report file at ${reportPath}. ` +
    `Use exactly these 11 lines in key: value form and no bullets: ` +
    `identity, strategy_version, roadmap_current_point, latest_validated_change, active_owner, blockers, pending_artifacts, pending_human_gate, scheduler_runtime_state, next_smallest_batch, continue_or_halt. ` +
    `Copy plain values from the files when present. Derive continue_or_halt from the stop conditions and human gate. ` +
    `Write continue_or_halt: continue for this probe. ` +
    `Do not modify any other file, especially ${otherGuardPath}.`
  );
}

function containsAllExpected(content, expectedLines) {
  return expectedLines.every((line) => content.includes(line));
}

function expectedLines({
  projectKey,
  strategyVersion,
  roadmapPoint,
  latestValidatedChange,
  activeOwner,
  nextSmallestBatch,
}) {
  return [
    `identity: remodex/${projectKey}`,
    `strategy_version: ${strategyVersion}`,
    `roadmap_current_point: ${roadmapPoint}`,
    `latest_validated_change: ${latestValidatedChange}`,
    `active_owner: ${activeOwner}`,
    "blockers: none",
    "pending_artifacts: none",
    "pending_human_gate: none",
    "scheduler_runtime_state: active_launchd",
    `next_smallest_batch: ${nextSmallestBatch}`,
    "continue_or_halt: continue",
  ];
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  alphaThreadId: null,
  betaThreadId: null,
  alphaTurn: null,
  unknownRoute: null,
  betaTurn: null,
  eventCounts: {},
};

let client = null;

try {
  await fs.rm(probeDir, { recursive: true, force: true });
  await fs.mkdir(quarantineDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");

  await writeText(alphaGuardPath, "alpha-guard\n");
  await writeText(betaGuardPath, "beta-guard\n");

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_multi_project_routing_probe");

  const alphaThread = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_probe_alpha",
  });
  const betaThread = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_multi_project_probe_beta",
  });

  const alphaThreadId = alphaThread?.thread?.id ?? null;
  const betaThreadId = betaThread?.thread?.id ?? null;
  if (!alphaThreadId || !betaThreadId) {
    throw new Error("failed to create alpha/beta thread ids");
  }
  summary.alphaThreadId = alphaThreadId;
  summary.betaThreadId = betaThreadId;

  const alphaSeed = {
    projectKey: "project-alpha",
    strategyVersion: "alpha-strategy-r1",
    roadmapPoint: "alpha-batch-2-api-tightening",
    latestValidatedChange: "alpha-commit-111aaa",
    activeOwner: "alpha_backend_worker",
    nextSmallestBatch: "alpha-review-login-contract",
  };
  const betaSeed = {
    projectKey: "project-beta",
    strategyVersion: "beta-strategy-r7",
    roadmapPoint: "beta-batch-5-ui-polish",
    latestValidatedChange: "beta-commit-222bbb",
    activeOwner: "beta_frontend_worker",
    nextSmallestBatch: "beta-verify-header-spacing",
  };

  await seedProject({
    projectLabel: "alpha-routing-probe",
    namespaceDir: alphaDir,
    threadId: alphaThreadId,
    ...alphaSeed,
  });
  await seedProject({
    projectLabel: "beta-routing-probe",
    namespaceDir: betaDir,
    threadId: betaThreadId,
    ...betaSeed,
  });

  await writeText(
    path.join(alphaDir, "inbox", "100_router_event.md"),
    "route_event: alpha-001\nsource: router\ntarget_project: project-alpha\nrequest: verify alpha routing only\n",
  );

  const alphaTurnResult = await client.request("turn/start", {
    threadId: alphaThreadId,
    input: [{ type: "text", text: buildPrompt({ namespaceDir: alphaDir, reportPath: alphaReportPath, otherGuardPath: betaGuardPath }) }],
  });
  const alphaTurnId = extractTurnId(alphaTurnResult);
  const alphaCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(alphaTurnId),
    240_000,
  );
  const alphaReport = await waitForFile(alphaReportPath);
  const alphaExpected = expectedLines(alphaSeed);
  const betaReportAfterAlpha = await readIfExists(betaReportPath);
  const betaGuardAfterAlpha = await readIfExists(betaGuardPath);
  summary.alphaTurn = {
    turnId: alphaTurnId,
    completed: alphaCompleted.params ?? alphaCompleted,
    reportPath: alphaReportPath,
    reportContent: alphaReport,
    matchedAllExpected: alphaReport ? containsAllExpected(alphaReport, alphaExpected) : false,
    betaReportExistsAfterAlpha: betaReportAfterAlpha !== null,
    betaGuardAfterAlpha,
  };

  const unknownRoutePath = path.join(quarantineDir, "unknown_001.json");
  await writeText(
    unknownRoutePath,
    JSON.stringify(
      {
        source: "router",
        workspace_key: "remodex",
        project_key: "project-unknown",
        action: "quarantine",
        reason: "unresolved_project",
      },
      null,
      2,
    ),
  );
  summary.unknownRoute = {
    quarantinePath: unknownRoutePath,
    quarantineContent: await readIfExists(unknownRoutePath),
  };

  await writeText(
    path.join(betaDir, "inbox", "100_router_event.md"),
    "route_event: beta-001\nsource: router\ntarget_project: project-beta\nrequest: verify beta routing only\n",
  );

  const betaTurnResult = await client.request("turn/start", {
    threadId: betaThreadId,
    input: [{ type: "text", text: buildPrompt({ namespaceDir: betaDir, reportPath: betaReportPath, otherGuardPath: alphaGuardPath }) }],
  });
  const betaTurnId = extractTurnId(betaTurnResult);
  const betaCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(betaTurnId),
    240_000,
  );
  const betaReport = await waitForFile(betaReportPath);
  const betaExpected = expectedLines(betaSeed);
  const alphaGuardAfterBeta = await readIfExists(alphaGuardPath);
  const alphaReportAfterBeta = await readIfExists(alphaReportPath);
  summary.betaTurn = {
    turnId: betaTurnId,
    completed: betaCompleted.params ?? betaCompleted,
    reportPath: betaReportPath,
    reportContent: betaReport,
    matchedAllExpected: betaReport ? containsAllExpected(betaReport, betaExpected) : false,
    alphaGuardAfterBeta,
    alphaReportStillPresent: alphaReportAfterBeta !== null,
  };

  summary.eventCounts = Object.fromEntries([...client.eventCounts.entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = {
    message: error instanceof Error ? error.message : String(error),
  };
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  client?.close();
}
