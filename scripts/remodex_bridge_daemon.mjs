import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcWsClient } from "./lib/app_server_jsonrpc.mjs";
import { BridgeRuntime } from "./lib/bridge_runtime.mjs";
import {
  buildRecordFilename,
  buildProjectPaths,
  ensureProjectDirs,
  listProjectKeys,
  markProcessed,
  readJsonIfExists,
  readProjectSnapshot,
  readRecord,
  writeOutboxRecord,
  writeAtomicJson,
} from "./lib/shared_memory_runtime.mjs";
import {
  ReplayCache,
  normalizeDiscordInteraction,
  verifyDiscordStyleRequest,
} from "./lib/discord_transport.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const host = process.env.REMODEX_OPERATOR_HTTP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.REMODEX_OPERATOR_HTTP_PORT ?? "8787", 10);
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? process.env.REMODEX_APP_SERVER_WS_URL ?? null;
const autoConsumeHumanGate = process.env.REMODEX_AUTO_CONSUME_HUMAN_GATE === "true";
const eventsLogPath =
  process.env.REMODEX_BRIDGE_EVENTS_LOG_PATH ??
  path.join(sharedBase, workspaceKey, "router", "bridge_daemon_events.jsonl");
const pendingApprovalsPath = path.join(sharedBase, workspaceKey, "router", "pending_approvals.json");
const publicKeyPath = process.env.REMODEX_DISCORD_PUBLIC_KEY_PATH ?? null;
const publicKeyPem = process.env.REMODEX_DISCORD_PUBLIC_KEY_PEM ?? null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureRouterRoot() {
  await fs.mkdir(path.dirname(eventsLogPath), { recursive: true });
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseProjectKeyFromPath(urlPath) {
  const match = urlPath.match(/^\/projects\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return {
    projectKey: decodeURIComponent(match[1]),
    action: decodeURIComponent(match[2]),
  };
}

async function loadPublicKey() {
  if (publicKeyPath) {
    return crypto.createPublicKey(await fs.readFile(publicKeyPath, "utf8"));
  }
  if (publicKeyPem) {
    return crypto.createPublicKey(publicKeyPem);
  }
  return null;
}

class BridgeDaemon {
  constructor({ sharedBase, workspaceKey, wsUrl, eventsLogPath }) {
    this.sharedBase = sharedBase;
    this.workspaceKey = workspaceKey;
    this.wsUrl = wsUrl;
    this.eventsLogPath = eventsLogPath;
    this.client = null;
    this.replayCache = new ReplayCache();
    this.pendingByThread = new Map();
    this.pendingBySource = new Map();
    this.openHumanGateNotificationByThread = new Map();
  }

  async start() {
    await ensureRouterRoot();
    await fs.writeFile(this.eventsLogPath, "", { flag: "a" });
    if (!this.wsUrl) return;
    this.client = new JsonRpcWsClient(this.wsUrl, this.eventsLogPath);
    await this.client.connect();
    await this.client.initialize("remodex_bridge_daemon");
    this.client.onNotification(async (msg) => {
      await this.handleNotification(msg);
    });
    this.client.onServerRequest(async (msg) => {
      await this.handleServerRequest(msg);
    });
  }

  async stop() {
    this.client?.clearAllWaiters();
    this.client?.close();
    this.client = null;
  }

  async runtimeForProject(projectKey) {
    return await BridgeRuntime.forProject({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey,
      wsUrl: this.wsUrl,
      logPath: this.eventsLogPath,
      client: this.client,
      serviceName: "remodex_bridge_daemon",
      processedBy: "remodex_bridge_daemon",
    });
  }

  async resolveProjectKeyByThread(threadId) {
    const projectKeys = await listProjectKeys(this.sharedBase, this.workspaceKey);
    for (const projectKey of projectKeys) {
      const paths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey,
      });
      const binding = await readJsonIfExists(path.join(paths.stateDir, "coordinator_binding.json"));
      if (binding?.threadId === threadId) return projectKey;
    }
    return null;
  }

  async writePendingApprovals() {
    const approvals = [...this.pendingBySource.values()]
      .map((item) => ({
        id: item.id,
        method: item.method,
        source_ref: item.sourceRef,
        thread_id: item.threadId,
        project_key: item.projectKey,
        turn_id: item.turnId,
        observed_at: item.observedAt,
        responded: item.responded,
      }))
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
    await writeAtomicJson(pendingApprovalsPath, { approvals });
  }

  async publishOutbox(projectKey, type, record) {
    const runtime = await this.runtimeForProject(projectKey);
    return await writeOutboxRecord(
      runtime.paths,
      {
        workspace_key: this.workspaceKey,
        project_key: projectKey,
        type,
        emitted_at: new Date().toISOString(),
        ...record,
      },
      buildRecordFilename(type, record.source_ref ?? record.correlation_key ?? projectKey, record.emitted_at ?? new Date().toISOString()),
    );
  }

  async mirrorCoordinatorStatus(projectKey, statusRecord) {
    const paths = buildProjectPaths({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey,
    });
    await ensureProjectDirs(paths);
    const filePath = path.join(paths.stateDir, "coordinator_status.json");
    await writeAtomicJson(filePath, statusRecord);
  }

  async handleNotification(msg) {
    if (msg.method !== "thread/status/changed") return;
    const threadId = msg.params?.threadId ?? null;
    if (!threadId) return;
    const projectKey = await this.resolveProjectKeyByThread(threadId);
    if (!projectKey) return;
    const snapshot = {
      observed_at: new Date().toISOString(),
      threadId,
      ...(msg.params?.status ?? {}),
    };
    await this.mirrorCoordinatorStatus(projectKey, snapshot);

    const activeFlags = snapshot.activeFlags ?? [];
    const waitingOnApproval =
      snapshot.type === "waiting_on_approval" ||
      (snapshot.type === "active" && activeFlags.includes("waitingOnApproval"));
    const statusKey = `${snapshot.type}:${activeFlags.slice().sort().join(",")}`;

    if (waitingOnApproval && !this.openHumanGateNotificationByThread.has(threadId)) {
      this.openHumanGateNotificationByThread.set(threadId, {
        opened_at: new Date().toISOString(),
        status_key: statusKey,
      });
      await this.publishOutbox(projectKey, "human_gate_notification", {
        source_ref: `status:${threadId}:${statusKey}`,
        correlation_key: `human-gate:${projectKey}:${threadId}:${statusKey}`,
        thread_id: threadId,
        summary: {
          coordinator_status: snapshot.type,
          active_flags: activeFlags,
        },
      });
      return;
    }

    const clearsHumanGateNotification =
      !waitingOnApproval &&
      !["active", "busy_non_interruptible"].includes(snapshot.type);
    if (clearsHumanGateNotification) {
      this.openHumanGateNotificationByThread.delete(threadId);
    }
  }

  async handleServerRequest(msg) {
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(msg.method)) {
      return;
    }
    const threadId = msg.params?.threadId ?? null;
    if (!threadId) return;
    const projectKey = await this.resolveProjectKeyByThread(threadId);
    if (!projectKey) return;
    const sourceRef = `${msg.method}:${msg.id}`;
    const approval = {
      id: msg.id,
      method: msg.method,
      threadId,
      projectKey,
      sourceRef,
      turnId: msg.params?.turnId ?? null,
      observedAt: new Date().toISOString(),
      responded: false,
      params: msg.params,
    };
    this.pendingByThread.set(threadId, approval);
    this.pendingBySource.set(sourceRef, approval);
    await this.writePendingApprovals();
    await this.mirrorCoordinatorStatus(projectKey, {
      observed_at: new Date().toISOString(),
      threadId,
      type: "waiting_on_approval",
      active_approval_source_ref: sourceRef,
      last_approval_method: msg.method,
    });
  }

  async respondToHumanGate(projectKey, sourceRef, decision = "accept") {
    if (!this.client) {
      throw new Error("app-server client is not running");
    }
    const approval = this.pendingBySource.get(sourceRef);
    if (!approval || approval.projectKey !== projectKey) {
      throw new Error(`no live approval source for ${projectKey}:${sourceRef}`);
    }

    const runtime = await this.runtimeForProject(projectKey);
    const candidateFiles = await fs.readdir(runtime.paths.humanGateDir).catch(() => []);
    const candidatePath = await this.findHumanGateCandidatePath(runtime.paths, sourceRef, candidateFiles);
    const candidateRecord = candidatePath ? await readRecord(candidatePath) : null;
    const acceptedSources = [];
    const deadline = Date.now() + 120_000;

    while (Date.now() < deadline) {
      const current = this.pendingByThread.get(approval.threadId);
      if (current && !current.responded) {
        await this.client.respond(current.id, { decision });
        current.responded = true;
        acceptedSources.push(current.sourceRef);
        this.pendingByThread.delete(current.threadId);
        this.pendingBySource.delete(current.sourceRef);
        await this.writePendingApprovals();
      }

      const snapshot = await runtime.snapshot();
      if ((snapshot.coordinator_status?.type ?? snapshot.coordinator_status?.status?.type ?? null) !== "waiting_on_approval") {
        if (candidatePath && candidateRecord) {
          const disposition = decision === "accept" ? "consumed_human_gate" : "cancelled_human_gate";
          const { receiptPath } = await markHumanGateProcessed(runtime, candidatePath, candidateRecord, disposition, acceptedSources);
          return {
            route: "human_gate_closure",
            decision,
            accepted_sources: acceptedSources,
            receipt_path: receiptPath,
          };
        }
        return {
          route: "human_gate_closure",
          decision,
          accepted_sources: acceptedSources,
        };
      }

      await sleep(250);
    }

    throw new Error(`timed out closing human gate for ${projectKey}:${sourceRef}`);
  }

  async findHumanGateCandidatePath(paths, sourceRef, candidateFiles = null) {
    const files = candidateFiles ?? (await fs.readdir(paths.humanGateDir).catch(() => []));
    for (const fileName of files.sort()) {
      const candidatePath = path.join(paths.humanGateDir, fileName);
      const record = await readJsonIfExists(candidatePath);
      if (record?.source_ref === sourceRef) return candidatePath;
    }
    return null;
  }

  async handleDiscordInteraction(payload) {
    const projectKey = payload.project_key ?? "_unresolved";
    const runtime = await this.runtimeForProject(projectKey);
    const deliveryMode =
      payload.command_class === "status" || payload.command_class === "approve-candidate"
        ? "sync"
        : "async";
    const result = await runtime.handleCommand(payload, { deliveryMode });

    if (
      autoConsumeHumanGate &&
      payload.command_class === "approve-candidate" &&
      result.route === "human_gate_candidate"
    ) {
      try {
        result.human_gate_closure = await this.respondToHumanGate(projectKey, payload.source_ref, "accept");
      } catch (error) {
        result.human_gate_closure = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (payload.command_class === "status" && result.route === "status") {
      result.outbox = await this.publishOutbox(projectKey, "status_response", {
        source_ref: payload.source_ref,
        correlation_key: payload.correlation_key,
        operator_id: payload.operator_id ?? null,
        summary: result.summary,
      });
    }

    return result;
  }
}

async function markHumanGateProcessed(runtime, candidatePath, candidateRecord, disposition, acceptedSources) {
  return await markProcessed(runtime.paths, {
    record: candidateRecord,
    sourcePath: candidatePath,
    disposition,
    origin: "foreground_human_gate",
    processedBy: "remodex_bridge_daemon",
    extra: {
      approval_sources: acceptedSources,
    },
  });
}

async function main() {
  await ensureRouterRoot();
  const daemon = new BridgeDaemon({
    sharedBase,
    workspaceKey,
    wsUrl,
    eventsLogPath,
  });
  await daemon.start();
  const publicKey = await loadPublicKey();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          workspace_key: workspaceKey,
          shared_base: sharedBase,
          ws_connected: Boolean(daemon.client),
        });
        return;
      }

      const projectRoute = parseProjectKeyFromPath(url.pathname);
      if (projectRoute && req.method === "GET" && projectRoute.action === "status") {
        const runtime = await daemon.runtimeForProject(projectRoute.projectKey);
        json(res, 200, {
          ok: true,
          project_key: projectRoute.projectKey,
          summary: await runtime.statusSummary(),
        });
        return;
      }

      if (projectRoute && req.method === "POST" && projectRoute.action === "dispatch-next") {
        const runtime = await daemon.runtimeForProject(projectRoute.projectKey);
        json(res, 202, {
          ok: true,
          project_key: projectRoute.projectKey,
          result: await runtime.deliverNextDispatch(),
        });
        return;
      }

      if (projectRoute && req.method === "POST" && projectRoute.action === "inbox-next") {
        const runtime = await daemon.runtimeForProject(projectRoute.projectKey);
        json(res, 202, {
          ok: true,
          project_key: projectRoute.projectKey,
          result: await runtime.deliverNextInbox(),
        });
        return;
      }

      if (projectRoute && req.method === "POST" && projectRoute.action === "human-gate") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (!body.source_ref) {
          json(res, 400, { ok: false, reason: "missing_source_ref" });
          return;
        }
        const result = await daemon.respondToHumanGate(
          projectRoute.projectKey,
          body.source_ref,
          body.decision === "cancel" ? "cancel" : "accept",
        );
        json(res, 202, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/discord/interactions") {
        const rawBody = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          json(res, 400, { ok: false, reason: "invalid_json" });
          return;
        }

        if (!publicKey) {
          json(res, 500, { ok: false, reason: "discord_public_key_not_configured" });
          return;
        }

        const verification = verifyDiscordStyleRequest({
          publicKey,
          signatureHex: Array.isArray(req.headers["x-signature-ed25519"])
            ? req.headers["x-signature-ed25519"][0]
            : req.headers["x-signature-ed25519"],
          timestamp: Array.isArray(req.headers["x-signature-timestamp"])
            ? req.headers["x-signature-timestamp"][0]
            : req.headers["x-signature-timestamp"],
          rawBody,
          interactionId: payload.id,
          replayCache: daemon.replayCache,
        });
        if (!verification.ok) {
          json(res, verification.httpStatus, { ok: false, reason: verification.reason });
          return;
        }

        const normalized = normalizeDiscordInteraction(payload, workspaceKey);
        const result = await daemon.handleDiscordInteraction(normalized);
        json(res, normalized.command_class === "status" ? 200 : 202, {
          ok: true,
          verification: verification.reason,
          command_class: normalized.command_class,
          project_key: normalized.project_key,
          result,
        });
        return;
      }

      json(res, 404, { ok: false, reason: "not_found" });
    } catch (error) {
      json(res, 500, {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const statePath = path.join(sharedBase, workspaceKey, "router", "bridge_daemon_state.json");
  await writeAtomicJson(statePath, {
    started_at: new Date().toISOString(),
    host,
    port,
    shared_base: sharedBase,
    workspace_key: workspaceKey,
    ws_url: wsUrl,
    auto_consume_human_gate: autoConsumeHumanGate,
  });

  console.log(JSON.stringify({
    ok: true,
    host,
    port,
    shared_base: sharedBase,
    workspace_key: workspaceKey,
    auto_consume_human_gate: autoConsumeHumanGate,
  }, null, 2));

  const shutdown = async () => {
    server.close();
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
