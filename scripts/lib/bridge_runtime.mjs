import path from "node:path";
import {
  extractFinalText,
  extractTurn,
  JsonRpcWsClient,
  readThreadWithTurns,
  runTurnAndRead,
} from "./app_server_jsonrpc.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  buildRecordFilename,
  findProcessedCorrelation,
  listFilesSafe,
  markProcessed,
  readInFlightDelivery,
  readOperatorAcl,
  readProjectSnapshot,
  readRecord,
  readTextIfExists,
  summarizeSnapshot,
  writeInFlightDelivery,
  clearInFlightDelivery,
  writeDispatchTicket,
  writeHumanGateCandidate,
  writeInboxEvent,
  writeQuarantineRecord,
} from "./shared_memory_runtime.mjs";

const DEFAULT_REQUIRED_ROLES = {
  status: "operator",
  intent: "operator",
  reply: "operator",
  "approve-candidate": "ops-admin",
};

export function operatorHasPermission(requiredRole, operatorRoles) {
  if (!requiredRole) return true;
  const roles = new Set(operatorRoles ?? []);
  if (roles.has("ops-admin")) return true;
  return roles.has(requiredRole);
}

function commandRoleField(commandClass) {
  if (commandClass === "status") return "status_allow";
  if (commandClass === "reply") return "reply_allow";
  if (commandClass === "approve-candidate") return "approval_allow";
  return "intent_allow";
}

function statusType(snapshot) {
  return (
    snapshot.coordinator_status?.type ??
    snapshot.coordinator_status?.status?.type ??
    snapshot.coordinator_status?.status ??
    "offline_or_no_lease"
  );
}

function activeApprovalSourceRef(snapshot) {
  return snapshot.coordinator_status?.active_approval_source_ref ?? null;
}

function resolveOperatorMessage(record) {
  return record.operator_answer ?? record.request ?? null;
}

function normalizeThreadId(snapshot) {
  return (
    snapshot.coordinator_binding?.threadId ??
    snapshot.coordinator_lease?.current_thread_ref ??
    null
  );
}

function underAllowedDeliveryDir(filePath, paths) {
  return (
    filePath.startsWith(`${paths.inboxDir}${path.sep}`) ||
    filePath.startsWith(`${paths.dispatchQueueDir}${path.sep}`)
  );
}

export class BridgeRuntime {
  constructor({
    paths,
    wsUrl,
    logPath = null,
    client = null,
    serviceName = "remodex_bridge_runtime",
    processedBy = "remodex_bridge_runtime",
  }) {
    this.paths = paths;
    this.wsUrl = wsUrl;
    this.logPath = logPath;
    this.client = client;
    this.serviceName = serviceName;
    this.processedBy = processedBy;
    this.ownsClient = false;
  }

  static async forProject({
    sharedBase,
    workspaceKey,
    projectKey,
    projectRoot,
    wsUrl,
    logPath = null,
    client = null,
    serviceName,
    processedBy,
  }) {
    const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey, projectRoot });
    await ensureProjectDirs(paths);
    return new BridgeRuntime({
      paths,
      wsUrl,
      logPath,
      client,
      serviceName,
      processedBy,
    });
  }

  async close() {
    if (this.ownsClient) {
      this.client?.clearAllWaiters();
      this.client?.close();
      this.client = null;
      this.ownsClient = false;
    }
  }

  async connectClientIfNeeded() {
    if (this.client) return this.client;
    if (!this.wsUrl) {
      throw new Error("bridge runtime requires wsUrl for delivery");
    }
    this.client = new JsonRpcWsClient(this.wsUrl, this.logPath);
    await this.client.connect();
    await this.client.initialize(this.serviceName);
    this.ownsClient = true;
    return this.client;
  }

  async snapshot() {
    return await readProjectSnapshot(this.paths);
  }

  async statusSummary() {
    return summarizeSnapshot(this.paths, await this.snapshot());
  }

  async readInFlight() {
    return await readInFlightDelivery(this.paths);
  }

  async recoverInFlightDelivery() {
    const inflight = await this.readInFlight();
    if (!inflight) return null;

    const eventRecord = inflight.record ?? {
      workspace_key: inflight.workspace_key ?? path.basename(this.paths.workspaceRoot),
      project_key: inflight.project_key ?? path.basename(this.paths.root),
      source_ref: inflight.source_ref,
      correlation_key: inflight.correlation_key,
      command_class: inflight.command_class ?? "intent",
      received_at: inflight.started_at ?? new Date().toISOString(),
      operator_answer: inflight.operator_answer ?? null,
    };
    const threadId = normalizeInflightThreadId(inflight);
    const turnId = normalizeInflightTurnId(inflight);

    if (!eventRecord.source_ref || !eventRecord.correlation_key || !threadId || !turnId) {
      await clearInFlightDelivery(this.paths);
      return {
        delivery_decision: "stale_inflight_cleared",
        reasons: ["invalid_inflight_shape"],
      };
    }

    const duplicate = await findProcessedCorrelation(this.paths, eventRecord.correlation_key);
    if (duplicate) {
      const { receiptPath } = await markProcessed(this.paths, {
        record: eventRecord,
        sourcePath: inflight.source_path ?? null,
        disposition: "skipped_duplicate",
        origin: "inflight_recovery_duplicate",
        processedBy: this.processedBy,
        extra: {
          duplicate_of: duplicate.processed_receipt ?? null,
          recovered_from_inflight: true,
          turn_id: turnId,
        },
      });
      await clearInFlightDelivery(this.paths);
      return {
        delivery_decision: "skipped_duplicate_inflight",
        receipt_path: receiptPath,
        duplicate_of: duplicate.processed_receipt ?? null,
        thread_id: threadId,
        turn_id: turnId,
      };
    }

    const client = await this.connectClientIfNeeded();
    const threadRead = await readThreadWithTurns(client, threadId);
    const turn = extractTurn(threadRead, turnId);
    if (!inflightTerminal(turn)) {
      return {
        delivery_decision: "inflight_wait",
        thread_id: threadId,
        turn_id: turnId,
        reasons: [turn ? `turn_${turn.status}` : "turn_missing"],
      };
    }

    const { receiptPath } = await markProcessed(this.paths, {
      record: eventRecord,
      sourcePath: inflight.source_path ?? null,
      disposition: "consumed",
      origin: "inflight_recovery",
      processedBy: this.processedBy,
      extra: {
        turn_id: turnId,
        final_text: extractFinalText(threadRead, turnId),
        recovered_from_inflight: true,
        turn_start_attempts: inflight.turn_start_attempts ?? null,
      },
    });
    await clearInFlightDelivery(this.paths);
    return {
      delivery_decision: "completed_inflight",
      receipt_path: receiptPath,
      thread_id: threadId,
      turn_id: turnId,
      final_text: extractFinalText(threadRead, turnId),
    };
  }

  async evaluateAcl(command) {
    const acl = await readOperatorAcl(this.paths);
    const requiredRole = acl[commandRoleField(command.command_class)] ?? DEFAULT_REQUIRED_ROLES[command.command_class] ?? "operator";
    return {
      acl,
      requiredRole,
      allowed: operatorHasPermission(requiredRole, command.operator_roles),
    };
  }

  async handleCommand(command, { deliveryMode = "sync" } = {}) {
    const runtimeProjectKey = path.basename(this.paths.root);
    if (
      command.project_key &&
      runtimeProjectKey !== "_unresolved" &&
      command.project_key !== runtimeProjectKey
    ) {
      const routed = await writeQuarantineRecord(
        this.paths,
        {
          ...command,
          route_decision: "quarantine",
          quarantine_reason: "project_mismatch",
          expected_project_key: runtimeProjectKey,
        },
        buildRecordFilename(command.command_class, command.source_ref, command.received_at),
      );
      return {
        route: "quarantine",
        delivery_decision: "blocked",
        quarantine_reason: "project_mismatch",
        ...routed,
      };
    }

    if (command.command_class === "status") {
      return {
        route: "status",
        delivery_decision: "not_applicable",
        summary: await this.statusSummary(),
      };
    }

    const acl = await this.evaluateAcl(command);
    if (!command.project_key) {
      const routed = await writeQuarantineRecord(
        this.paths,
        {
          ...command,
          route_decision: "quarantine",
          quarantine_reason: "missing_project",
        },
        buildRecordFilename(command.command_class, command.source_ref, command.received_at),
      );
      return { route: "quarantine", delivery_decision: "blocked", quarantine_reason: "missing_project", ...routed };
    }

    if (!acl.allowed) {
      const routed = await writeQuarantineRecord(
        this.paths,
        {
          ...command,
          route_decision: "quarantine",
          quarantine_reason: `missing_role:${acl.requiredRole}`,
        },
        buildRecordFilename(command.command_class, command.source_ref, command.received_at),
      );
      return { route: "quarantine", delivery_decision: "blocked", quarantine_reason: `missing_role:${acl.requiredRole}`, ...routed };
    }

    const snapshot = await this.snapshot();
    if (command.command_class === "approve-candidate") {
      return await this.routeApprovalCandidate(command, snapshot);
    }

    const filename = buildRecordFilename(command.command_class, command.source_ref, command.received_at);
    const routed = await writeInboxEvent(
      this.paths,
      {
        ...command,
        type: command.command_class === "reply" ? "operator_reply" : "operator_intent",
        route_decision: "inbox",
      },
      filename,
    );
    const delivery =
      deliveryMode === "async"
        ? await this.schedulePersistedEvent(routed.filePath, { snapshot })
        : await this.arbitratePersistedEvent(routed.filePath, { snapshot });
    return {
      route: "inbox",
      ...routed,
      ...delivery,
    };
  }

  async routeApprovalCandidate(command, snapshot) {
    const currentStatus = statusType(snapshot);
    const activeSourceRef = activeApprovalSourceRef(snapshot);
    const filename = buildRecordFilename(command.command_class, command.source_ref, command.received_at);

    if (currentStatus !== "waiting_on_approval") {
      const routed = await writeQuarantineRecord(
        this.paths,
        {
          ...command,
          route_decision: "quarantine",
          quarantine_reason: `invalid_approval_state:${currentStatus}`,
        },
        filename,
      );
      return {
        route: "quarantine",
        delivery_decision: "blocked",
        quarantine_reason: `invalid_approval_state:${currentStatus}`,
        ...routed,
      };
    }

    if (!command.source_ref || command.source_ref !== activeSourceRef) {
      const routed = await writeQuarantineRecord(
        this.paths,
        {
          ...command,
          route_decision: "quarantine",
          quarantine_reason: "active_approval_source_mismatch",
          expected_source_ref: activeSourceRef,
        },
        filename,
      );
      return {
        route: "quarantine",
        delivery_decision: "blocked",
        quarantine_reason: "active_approval_source_mismatch",
        ...routed,
      };
    }

    const routed = await writeHumanGateCandidate(
      this.paths,
      {
        ...command,
        type: "human_gate_candidate",
        route_decision: "human_gate_candidate",
        approval_source_ref: activeSourceRef,
      },
      filename,
    );
    return {
      route: "human_gate_candidate",
      delivery_decision: "await_human_gate",
      ...routed,
    };
  }

  async arbitratePersistedEvent(filePath, { snapshot = null } = {}) {
    const record = await readRecord(filePath);
    const currentSnapshot = snapshot ?? (await this.snapshot());
    const gate = await this.evaluateDeliveryGate(record, currentSnapshot);

    if (gate.decision === "skipped_duplicate") {
      const { receiptPath } = await markProcessed(this.paths, {
        record,
        sourcePath: filePath,
        disposition: "skipped_duplicate",
        origin: gate.origin,
        processedBy: this.processedBy,
        extra: {
          duplicate_of: gate.duplicate_of,
        },
      });
      return {
        delivery_decision: "skipped_duplicate",
        receipt_path: receiptPath,
        reasons: gate.reasons,
      };
    }

    if (gate.decision === "defer") {
      const ticket = await writeDispatchTicket(
        this.paths,
        {
          workspace_key: record.workspace_key,
          project_key: record.project_key,
          source_ref: record.source_ref,
          correlation_key: record.correlation_key,
          operator_answer: resolveOperatorMessage(record),
          source_path: filePath,
          blocked_reasons: gate.reasons,
          route_decision: "dispatch_queue",
          received_at: record.received_at ?? new Date().toISOString(),
        },
        path.basename(filePath),
      );
      return {
        delivery_decision: "deferred",
        dispatch_ticket_path: ticket.filePath,
        reasons: gate.reasons,
      };
    }

    return await this.deliverPersistedEvent(filePath, {
      record,
      origin: gate.origin,
    });
  }

  async schedulePersistedEvent(filePath, { snapshot = null } = {}) {
    const record = await readRecord(filePath);
    const currentSnapshot = snapshot ?? (await this.snapshot());
    const gate = await this.evaluateDeliveryGate(record, currentSnapshot);

    if (gate.decision === "skipped_duplicate") {
      return await this.arbitratePersistedEvent(filePath, { snapshot: currentSnapshot });
    }

    if (gate.decision === "defer") {
      return await this.arbitratePersistedEvent(filePath, { snapshot: currentSnapshot });
    }

    void this.deliverPersistedEvent(filePath, {
      record,
      origin: gate.origin,
    }).catch((error) => {
      console.error(
        `[remodex_bridge_runtime] async delivery failed for ${record.correlation_key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return {
      delivery_decision: "scheduled_delivery",
      reasons: [],
    };
  }

  async evaluateDeliveryGate(record, snapshot) {
    const duplicate = await findProcessedCorrelation(this.paths, record.correlation_key);
    if (duplicate) {
      return {
        decision: "skipped_duplicate",
        reasons: ["processed_correlation_exists"],
        duplicate_of: duplicate.processed_receipt ?? null,
        origin: "dedupe_guard",
      };
    }

    const inflight = await this.readInFlight();
    if (inflight && inflight.correlation_key !== record.correlation_key) {
      return {
        decision: "defer",
        reasons: ["inflight_delivery_exists"],
      };
    }

    const threadId = normalizeThreadId(snapshot);
    if (!threadId) {
      return {
        decision: "defer",
        reasons: ["missing_binding"],
      };
    }

    if (snapshot.project_identity?.project_key && record.project_key !== snapshot.project_identity.project_key) {
      return {
        decision: "defer",
        reasons: ["project_mismatch"],
      };
    }

    if (snapshot.stop_conditions?.must_human_check) {
      return {
        decision: "defer",
        reasons: ["must_human_check"],
      };
    }

    if ((snapshot.counts?.human_gate_candidates ?? 0) > 0) {
      return {
        decision: "defer",
        reasons: ["pending_human_gate"],
      };
    }

    const toggle = snapshot.background_trigger_toggle ?? {};
    if (toggle.foreground_session_active) {
      return {
        decision: "defer",
        reasons: ["foreground_session_active"],
      };
    }
    if (toggle.background_trigger_enabled === false) {
      return {
        decision: "defer",
        reasons: ["background_trigger_disabled"],
      };
    }

    const currentStatus = statusType(snapshot);
    if (["busy_non_interruptible", "active", "offline_or_no_lease"].includes(currentStatus)) {
      return {
        decision: "defer",
        reasons: [`status_${currentStatus}`],
      };
    }

    if (["waiting_on_approval", "waiting_on_user_input"].includes(currentStatus)) {
      return {
        decision: "defer",
        reasons: [`status_${currentStatus}`],
      };
    }

    if (!["idle", "checkpoint_open"].includes(currentStatus)) {
      return {
        decision: "defer",
        reasons: [`status_${currentStatus}`],
      };
    }

    return {
      decision: "deliver",
      reasons: [],
      origin: filePathOrigin(filePathFromRecord(record, this.paths), this.paths),
    };
  }

  async deliverPersistedEvent(filePath, { record = null, origin = "direct_delivery" } = {}) {
    if (!underAllowedDeliveryDir(filePath, this.paths)) {
      throw new Error(`no-direct-injection guard: unsupported source path ${filePath}`);
    }

    const eventRecord = record ?? (await readRecord(filePath));
    const message = resolveOperatorMessage(eventRecord);
    if (!message) {
      throw new Error(`persisted event ${filePath} has no operator message`);
    }

    const snapshot = await this.snapshot();
    const threadId = normalizeThreadId(snapshot);
    if (!threadId) {
      throw new Error("persisted delivery requires coordinator binding");
    }

    const existingInflight = await this.readInFlight();
    if (existingInflight && existingInflight.correlation_key !== eventRecord.correlation_key) {
      return {
        delivery_decision: "inflight_wait",
        reasons: ["inflight_delivery_exists"],
        thread_id: normalizeInflightThreadId(existingInflight),
        turn_id: normalizeInflightTurnId(existingInflight),
      };
    }

    const client = await this.connectClientIfNeeded();
    const result = await runTurnAndRead(client, threadId, message, 240_000, {
      onTurnStarted: async ({ turnId, turnStartAttempts }) => {
        await writeInFlightDelivery(this.paths, {
          workspace_key: eventRecord.workspace_key,
          project_key: eventRecord.project_key,
          source_ref: eventRecord.source_ref,
          correlation_key: eventRecord.correlation_key,
          command_class: eventRecord.command_class ?? eventRecord.type ?? "event",
          source_path: filePath,
          operator_answer: message,
          thread_id: threadId,
          turn_id: turnId,
          origin,
          started_at: new Date().toISOString(),
          turn_start_attempts: turnStartAttempts,
          record: eventRecord,
        });
      },
    });
    const existingProcessed = await findProcessedCorrelation(this.paths, eventRecord.correlation_key);
    if (existingProcessed) {
      await clearInFlightDelivery(this.paths);
      return {
        delivery_decision: "already_processed",
        thread_id: threadId,
        turn_id: result.turnId,
        receipt_path: existingProcessed.processed_receipt ?? null,
        final_text: result.text,
        turn_start_attempts: result.turnStartAttempts,
        reasons: ["post_turn_duplicate_receipt_reused"],
      };
    }
    const { receiptPath } = await markProcessed(this.paths, {
      record: eventRecord,
      sourcePath: filePath,
      disposition: "consumed",
      origin,
      processedBy: this.processedBy,
      extra: {
        turn_id: result.turnId,
        final_text: result.text,
        turn_start_attempts: result.turnStartAttempts,
      },
    });
    await clearInFlightDelivery(this.paths);

    return {
      delivery_decision: "delivered",
      thread_id: threadId,
      turn_id: result.turnId,
      receipt_path: receiptPath,
      final_text: result.text,
      turn_start_attempts: result.turnStartAttempts,
    };
  }

  async deliverNextDispatch() {
    const inflightRecovery = await this.recoverInFlightDelivery();
    if (inflightRecovery) return inflightRecovery;
    const ticketFiles = await listFilesSafe(this.paths.dispatchQueueDir, ".json");
    for (const fileName of ticketFiles) {
      const ticketPath = path.join(this.paths.dispatchQueueDir, fileName);
      const ticket = await readRecord(ticketPath);
      const sourcePath = ticket.source_path ?? path.join(this.paths.inboxDir, fileName);
      const sourceText = await readTextIfExists(sourcePath);
      if (sourceText === null) {
        await markProcessed(this.paths, {
          record: ticket,
          sourcePath: ticketPath,
          disposition: "skipped_duplicate",
          origin: "missing_source_after_queue",
          processedBy: this.processedBy,
        });
        continue;
      }
      return await this.deliverPersistedEvent(sourcePath, {
        origin: "dispatch_queue",
      });
    }
    return {
      delivery_decision: "noop",
      reasons: ["empty_dispatch_queue"],
    };
  }

  async deliverNextInbox() {
    const inflightRecovery = await this.recoverInFlightDelivery();
    if (inflightRecovery) return inflightRecovery;
    const inboxFiles = await listFilesSafe(this.paths.inboxDir, ".json");
    if (inboxFiles.length === 0) {
      return {
        delivery_decision: "noop",
        reasons: ["empty_inbox"],
      };
    }
    return await this.arbitratePersistedEvent(path.join(this.paths.inboxDir, inboxFiles[0]));
  }
}

function filePathOrigin(filePath, paths) {
  if (!filePath) return "direct_delivery";
  if (filePath.startsWith(`${paths.dispatchQueueDir}${path.sep}`)) return "dispatch_queue";
  return "direct_delivery";
}

function filePathFromRecord(record, paths) {
  if (record.source_path) return record.source_path;
  return path.join(paths.inboxDir, buildRecordFilename(record.command_class ?? record.type ?? "event", record.source_ref ?? record.correlation_key, record.received_at ?? new Date().toISOString()));
}

function normalizeInflightThreadId(inflight) {
  return inflight?.thread_id ?? inflight?.threadId ?? null;
}

function normalizeInflightTurnId(inflight) {
  return inflight?.turn_id ?? inflight?.turnId ?? null;
}

function inflightTerminal(turn) {
  return Boolean(turn?.status) && turn.status !== "inProgress";
}
