import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const contractPath = path.join(workspace, "MAIN_COORDINATOR_PROMPT_CONTRACT.md");
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "dispatch_queue_probe");
const namespaceDir = path.join(probeDir, "project_alpha");
const stateDir = path.join(namespaceDir, "state");
const runtimeDir = path.join(namespaceDir, "runtime");
const inboxDir = path.join(namespaceDir, "inbox");
const dispatchDir = path.join(namespaceDir, "dispatch_queue");
const pulsesDir = path.join(namespaceDir, "pulses");
const evidenceDir = path.join(namespaceDir, "evidence");
const routerEventPath = path.join(inboxDir, "200_router_event.md");
const dispatchTicketPath = path.join(dispatchDir, "200_dispatch.md");
const deliveryReportPath = path.join(namespaceDir, "delivered_from_queue.md");
const summaryPath = path.join(verificationDir, "dispatch_queue_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "dispatch_queue_probe_events.jsonl");
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

async function seedNamespace(threadId, coordinatorType) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(dispatchDir, { recursive: true });
  await fs.mkdir(pulsesDir, { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true });

  await writeText(
    path.join(stateDir, "project_identity.md"),
    `identity: remodex/project-alpha\nworkspace_key: remodex\nproject_key: project-alpha\nnamespace_ref: ${namespaceDir}\n`,
  );
  await writeText(
    path.join(stateDir, "coordinator_lease.md"),
    `lease_holder_role: main_coordinator\ncurrent_thread_ref: ${threadId}\nlease_status: held\n`,
  );
  await writeText(path.join(stateDir, "coordinator_status.md"), `type: ${coordinatorType}\n`);
  await writeText(
    path.join(stateDir, "prompt_contract_binding.md"),
    `canonical_contract_path: ${contractPath}\ncontract_version: 2026-03-25\n`,
  );
  await writeText(
    path.join(stateDir, "strategy_binding.md"),
    "strategy_version: dispatch-arbitration-r1\nstrategy_label: dispatch-queue-arbitration-probe\n",
  );
  await writeText(
    path.join(stateDir, "roadmap_status.md"),
    "roadmap_current_point: queue-then-deliver\nstale: false\n",
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
  await writeText(path.join(stateDir, "current_goal.md"), "current_goal: verify busy-to-queue dispatch arbitration\n");
  await writeText(path.join(stateDir, "current_plan.md"), "current_plan: queue while busy, deliver at checkpoint\n");
  await writeText(path.join(stateDir, "current_focus.md"), "current_focus: dispatch-arbitration\n");
  await writeText(path.join(stateDir, "active_owner.md"), "active_owner: backend_worker\n");
  await writeText(
    path.join(stateDir, "progress_axes.md"),
    "latest_validated_change: dispatch-base-001\nblockers: none\n",
  );
  await writeText(path.join(stateDir, "deferred_queue.md"), "deferred_queue: none\n");
  await writeText(path.join(stateDir, "pending_artifacts.md"), "pending_artifacts: none\n");
  await writeText(
    path.join(pulsesDir, "backend.md"),
    "verdict: pass\nchanged files: none\nvalidation: seed only\nblocker: none\nnext smallest batch: deliver queued router event\nhuman_required: no\n",
  );
  await writeText(path.join(evidenceDir, "001_latest.md"), "latest_validated_change: dispatch-base-001\n");
  await writeText(path.join(namespaceDir, "decisions.log"), "2026-03-25 queue arbitration seed\n");
}

function buildDeliveryPrompt() {
  return (
    `You are resuming as this project's main coordinator after a queued dispatch. ` +
    `Read ${contractPath} as the canonical contract. ` +
    `Read the shared memory namespace rooted at ${namespaceDir}. ` +
    `Use ${dispatchTicketPath} and ${routerEventPath} as the queued inputs that were deferred while busy. ` +
    `Then write exactly one file at ${deliveryReportPath} with exactly these 5 lines and no bullets: ` +
    `identity, coordinator_status, dispatch_ticket, router_event, delivery_mode. ` +
    `Use plain values from the files when present. ` +
    `For delivery_mode write queued. Do not modify any other file.`
  );
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  queueDecision: null,
  deliveryTurn: null,
  eventCounts: {},
};

let client = null;

try {
  await fs.rm(probeDir, { recursive: true, force: true });
  await fs.mkdir(probeDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("remodex_dispatch_queue_probe");

  const threadResult = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "remodex_dispatch_queue_probe",
  });
  const threadId = threadResult?.thread?.id ?? null;
  if (!threadId) throw new Error("thread/start did not return thread id");
  summary.threadId = threadId;

  await seedNamespace(threadId, "busy_non_interruptible");
  await writeText(
    routerEventPath,
    "route_event: router-200\nsource: router\ntarget_project: project-alpha\nrequest: deliver only after checkpoint\n",
  );

  const coordinatorStatusBefore = await readIfExists(path.join(stateDir, "coordinator_status.md"));
  if (!coordinatorStatusBefore?.includes("busy_non_interruptible")) {
    throw new Error("coordinator status seed failed");
  }

  await writeText(
    dispatchTicketPath,
    "dispatch_ticket: 200_dispatch.md\nstatus: queued\nreason: coordinator_busy\nsource_ref: 200_router_event.md\n",
  );
  const reportBeforeDelivery = await readIfExists(deliveryReportPath);
  summary.queueDecision = {
    coordinatorStatusBefore,
    dispatchTicketPath,
    dispatchTicketBeforeDelivery: await readIfExists(dispatchTicketPath),
    reportExistsBeforeDelivery: reportBeforeDelivery !== null,
  };

  await writeText(path.join(stateDir, "coordinator_status.md"), "type: checkpoint_open\n");

  const deliveryTurnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: buildDeliveryPrompt() }],
  });
  const deliveryTurnId = extractTurnId(deliveryTurnResult);
  const deliveryCompleted = await client.waitForNotification(
    "turn/completed",
    completedTurnPredicate(deliveryTurnId),
    240_000,
  );
  const deliveryReport = await waitForFile(deliveryReportPath);
  await writeText(
    dispatchTicketPath,
    "dispatch_ticket: 200_dispatch.md\nstatus: delivered\nreason: coordinator_checkpoint_open\nsource_ref: 200_router_event.md\n",
  );

  summary.deliveryTurn = {
    turnId: deliveryTurnId,
    completed: deliveryCompleted.params ?? deliveryCompleted,
    coordinatorStatusAtDelivery: await readIfExists(path.join(stateDir, "coordinator_status.md")),
    reportPath: deliveryReportPath,
    reportContent: deliveryReport,
    dispatchTicketAfterDelivery: await readIfExists(dispatchTicketPath),
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
