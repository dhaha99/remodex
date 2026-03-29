import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const contractPath = path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md");
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "shared_memory_contract_probe");
const namespaceDir = path.join(probeDir, "project_alpha");
const stateDir = path.join(namespaceDir, "state");
const runtimeDir = path.join(namespaceDir, "runtime");
const inboxDir = path.join(namespaceDir, "inbox");
const dispatchDir = path.join(namespaceDir, "dispatch_queue");
const pulsesDir = path.join(namespaceDir, "pulses");
const evidenceDir = path.join(namespaceDir, "evidence");
const summaryPath = path.join(verificationDir, "shared_memory_contract_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "shared_memory_contract_probe_events.jsonl");
const reportContinuePath = path.join(probeDir, "report_continue.md");
const reportHaltPath = path.join(probeDir, "report_halt.md");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const previousSummaryPath = path.join(verificationDir, "thread_resume_probe_summary.json");

await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(runtimeDir, { recursive: true });
await fs.mkdir(inboxDir, { recursive: true });
await fs.mkdir(dispatchDir, { recursive: true });
await fs.mkdir(pulsesDir, { recursive: true });
await fs.mkdir(evidenceDir, { recursive: true });

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

async function waitForFile(filePath, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await sleep(500);
    }
  }
  return null;
}

async function seedSharedMemory({ threadId, haltMode }) {
  const projectIdText =
    `identity: remodex/project-alpha\n` +
    `workspace_key: remodex\n` +
    `project_key: project-alpha\n` +
    `namespace_ref: ${namespaceDir}\n`;

  const coordinatorLease =
    `lease_holder_role: main_coordinator\n` +
    `current_thread_ref: ${threadId}\n` +
    `lease_status: held\n`;

  const coordinatorStatus = `type: idle\n`;
  const promptContractBinding =
    `canonical_contract_path: ${contractPath}\n` +
    `contract_version: 2026-03-25\n`;

  const strategyBinding =
    `strategy_version: strategy-2026-03-25-r3\n` +
    `strategy_label: shared-memory-contract-probe\n`;

  const roadmapStatus =
    `roadmap_current_point: batch-3-shared-memory-reconstruction\n` +
    `stale: false\n`;

  const autonomyPolicy =
    `autonomous_background_allowed: true\n` +
    `autonomy_mode: constrained\n`;

  const backgroundTrigger =
    `background_trigger_enabled: true\n` +
    `foreground_session_active: false\n` +
    `foreground_lock_enabled: false\n`;

  const schedulerRuntime =
    `scheduler_installed: true\n` +
    `scheduler_active: true\n` +
    `scheduler_runtime_state: active_launchd\n`;

  const stopConditions = haltMode
    ? `must_human_check: true\npending_human_gate: MUST_HUMAN_CHECK\nreason: artifact-204 requires human review\n`
    : `must_human_check: false\npending_human_gate: none\nreason: none\n`;

  const currentGoal = `current_goal: verify shared memory contract reconstruction\n`;
  const currentPlan = `current_plan: read contract, reconstruct state, emit report\n`;
  const currentFocus = `current_focus: contract-read-and-reconstruct\n`;
  const activeOwner = `active_owner: backend_worker\n`;

  const progressAxes = haltMode
    ? `latest_validated_change: commit-simulated-def456\nblockers: waiting-human-review\n`
    : `latest_validated_change: commit-simulated-abc123\nblockers: none\n`;

  const deferredQueue = `deferred_queue: none\n`;
  const pendingArtifacts = haltMode
    ? `pending_artifacts: artifact-204-awaiting-human-review\n`
    : `pending_artifacts: none\n`;

  const inboxItem = haltMode
    ? `next_smallest_batch: wait-for-human-review-artifact-204\n`
    : `next_smallest_batch: review-inbox-item-verify-scheduler-handoff\n`;

  const pulseBackend =
    `verdict: pass\nchanged files: verification log only\nvalidation: probe stack green\nblocker: none\nnext smallest batch: review-inbox-item-verify-scheduler-handoff\nhuman_required: no\n`;

  const evidenceLatest = haltMode
    ? `latest_validated_change: commit-simulated-def456\n`
    : `latest_validated_change: commit-simulated-abc123\n`;

  const decisionsLog = haltMode
    ? `2026-03-25 adopt artifact-204 pending human gate\n`
    : `2026-03-25 adopt scheduler verification evidence\n`;

  await writeText(path.join(stateDir, "project_identity.md"), projectIdText);
  await writeText(path.join(stateDir, "coordinator_lease.md"), coordinatorLease);
  await writeText(path.join(stateDir, "coordinator_status.md"), coordinatorStatus);
  await writeText(path.join(stateDir, "prompt_contract_binding.md"), promptContractBinding);
  await writeText(path.join(stateDir, "strategy_binding.md"), strategyBinding);
  await writeText(path.join(stateDir, "roadmap_status.md"), roadmapStatus);
  await writeText(path.join(stateDir, "autonomy_policy.md"), autonomyPolicy);
  await writeText(path.join(stateDir, "background_trigger_toggle.md"), backgroundTrigger);
  await writeText(path.join(runtimeDir, "scheduler_runtime.md"), schedulerRuntime);
  await writeText(path.join(stateDir, "stop_conditions.md"), stopConditions);
  await writeText(path.join(stateDir, "current_goal.md"), currentGoal);
  await writeText(path.join(stateDir, "current_plan.md"), currentPlan);
  await writeText(path.join(stateDir, "current_focus.md"), currentFocus);
  await writeText(path.join(stateDir, "active_owner.md"), activeOwner);
  await writeText(path.join(stateDir, "progress_axes.md"), progressAxes);
  await writeText(path.join(stateDir, "deferred_queue.md"), deferredQueue);
  await writeText(path.join(stateDir, "pending_artifacts.md"), pendingArtifacts);
  await writeText(path.join(inboxDir, "001_next_batch.md"), inboxItem);
  await writeText(path.join(dispatchDir, "001_dispatch.md"), `dispatch_status: none\n`);
  await writeText(path.join(pulsesDir, "backend.md"), pulseBackend);
  await writeText(path.join(evidenceDir, "001_latest.md"), evidenceLatest);
  await writeText(path.join(namespaceDir, "decisions.log"), decisionsLog);
}

function expectedAssertions({ haltMode }) {
  return haltMode
    ? [
        "identity: remodex/project-alpha",
        "strategy_version: strategy-2026-03-25-r3",
        "roadmap_current_point: batch-3-shared-memory-reconstruction",
        "latest_validated_change: commit-simulated-def456",
        "active_owner: backend_worker",
        "blockers: waiting-human-review",
        "pending_artifacts: artifact-204-awaiting-human-review",
        "pending_human_gate: MUST_HUMAN_CHECK",
        "scheduler_runtime_state: active_launchd",
        "next_smallest_batch: wait-for-human-review-artifact-204",
        "continue_or_halt: halt",
      ]
    : [
        "identity: remodex/project-alpha",
        "strategy_version: strategy-2026-03-25-r3",
        "roadmap_current_point: batch-3-shared-memory-reconstruction",
        "latest_validated_change: commit-simulated-abc123",
        "active_owner: backend_worker",
        "blockers: none",
        "pending_artifacts: none",
        "pending_human_gate: none",
        "scheduler_runtime_state: active_launchd",
        "next_smallest_batch: review-inbox-item-verify-scheduler-handoff",
        "continue_or_halt: continue",
      ];
}

function buildPrompt(reportPath) {
  return (
    `You are resuming as this project's main coordinator. ` +
    `Read ${contractPath} as the canonical contract. ` +
    `Read the shared memory namespace rooted at ${namespaceDir} using the fixed read order from that contract. ` +
    `Then write exactly one report file at ${reportPath}. ` +
    `Use exactly these 11 lines in key: value form and no bullets: ` +
    `identity, strategy_version, roadmap_current_point, latest_validated_change, active_owner, blockers, pending_artifacts, pending_human_gate, scheduler_runtime_state, next_smallest_batch, continue_or_halt. ` +
    `Copy plain values from the files when present. Derive continue_or_halt from the stop conditions and human gate. ` +
    `If a field is absent, write unknown. Do not modify any other file.`
  );
}

function containsAllExpected(content, expectedLines) {
  return expectedLines.every((line) => content.includes(line));
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  continueCase: null,
  haltCase: null,
  eventCounts: {},
};

let client = null;

try {
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(reportContinuePath, { force: true });
  await fs.rm(reportHaltPath, { force: true });

  const previousSummary = JSON.parse(await fs.readFile(previousSummaryPath, "utf8"));
  const threadId = previousSummary?.sourceThreadId ?? previousSummary?.threadId;
  if (!threadId) throw new Error("thread_resume_probe_summary.json does not contain thread id");
  summary.threadId = threadId;

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_shared_memory_contract_probe");

  await client.request("thread/resume", {
    threadId,
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  await seedSharedMemory({ threadId, haltMode: false });
  const continueTurnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: buildPrompt(reportContinuePath) }],
  });
  const continueTurnId = extractTurnId(continueTurnResult);
  const continueCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(continueTurnId),
    240_000,
  );
  const continueReport = await waitForFile(reportContinuePath);
  const continueExpected = expectedAssertions({ haltMode: false });
  summary.continueCase = {
    turnId: continueTurnId,
    completed: continueCompleted.params ?? continueCompleted,
    reportPath: reportContinuePath,
    reportContent: continueReport,
    matchedAllExpected: continueReport ? containsAllExpected(continueReport, continueExpected) : false,
    expected: continueExpected,
  };

  await seedSharedMemory({ threadId, haltMode: true });
  const haltTurnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: buildPrompt(reportHaltPath) }],
  });
  const haltTurnId = extractTurnId(haltTurnResult);
  const haltCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(haltTurnId),
    240_000,
  );
  const haltReport = await waitForFile(reportHaltPath);
  const haltExpected = expectedAssertions({ haltMode: true });
  summary.haltCase = {
    turnId: haltTurnId,
    completed: haltCompleted.params ?? haltCompleted,
    reportPath: reportHaltPath,
    reportContent: haltReport,
    matchedAllExpected: haltReport ? containsAllExpected(haltReport, haltExpected) : false,
    expected: haltExpected,
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
