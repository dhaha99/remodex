import fs from "node:fs/promises";
import path from "node:path";
import {
  buildProjectPaths,
  findProcessedCorrelation,
  listFilesSafe,
  listProjectKeys,
  readInFlightDelivery,
  readJsonIfExists,
  readProjectSnapshot,
  readRecord,
  readTextIfExists,
  summarizeSnapshot,
} from "./shared_memory_runtime.mjs";

const DEFAULT_STALE_INFLIGHT_MS = 5 * 60 * 1000;

function workspaceRoot(sharedBase, workspaceKey) {
  return path.join(sharedBase, workspaceKey);
}

function routerPaths(sharedBase, workspaceKey) {
  const root = workspaceRoot(sharedBase, workspaceKey);
  return {
    root,
    outboxDir: path.join(root, "router", "outbox"),
    quarantineDir: path.join(root, "router", "quarantine"),
    pendingApprovalsPath: path.join(root, "router", "pending_approvals.json"),
    bridgeEventsPath: path.join(root, "router", "bridge_daemon_events.jsonl"),
    schedulerEventsPath: path.join(root, "router", "scheduler_tick_events.jsonl"),
    gatewayAdapterStatePath: path.join(root, "router", "discord_gateway_adapter_state.json"),
    gatewayAdapterEventsPath: path.join(root, "router", "discord_gateway_events.jsonl"),
  };
}

function normalizeStatusType(snapshot) {
  return (
    snapshot.coordinator_status?.type ??
    snapshot.coordinator_status?.status?.type ??
    snapshot.coordinator_status?.status ??
    "offline_or_no_lease"
  );
}

function normalizeSchedulerDecision(snapshot) {
  const runtime = snapshot.scheduler_runtime ?? {};
  return {
    decision: runtime.decision ?? "unknown",
    reasons: runtime.reasons ?? runtime.result?.reasons ?? [],
    recorded_at: runtime.recorded_at ?? runtime.result?.recorded_at ?? null,
    result: runtime.result ?? null,
  };
}

function extractTimestamp(record, filename = "") {
  const candidate =
    record?.updated_at ??
    record?.emitted_at ??
    record?.processed_at ??
    record?.recorded_at ??
    record?.received_at ??
    record?.observed_at ??
    record?.started_at ??
    record?.created_at ??
    null;
  if (candidate) return candidate;
  const prefix = filename.split("_")[0] ?? null;
  return prefix || null;
}

function sortByTimestampDesc(items) {
  return [...items].sort((left, right) => {
    const leftTs = left.timestamp ?? "";
    const rightTs = right.timestamp ?? "";
    return rightTs.localeCompare(leftTs);
  });
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function readJsonRecords(dirPath, limit = null) {
  const names = await listFilesSafe(dirPath, ".json");
  const selected = limit ? names.slice(-limit) : names;
  const records = [];
  for (const name of selected) {
    const filePath = path.join(dirPath, name);
    const record = await readJsonIfExists(filePath);
    if (!record) continue;
    records.push({
      filename: name,
      file_path: filePath,
      timestamp: extractTimestamp(record, name),
      record,
    });
  }
  return sortByTimestampDesc(records);
}

async function readJsonlTail(filePath, limit = 200) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return [];
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

function summarizeProcessedRecord(entry) {
  return {
    source_ref: entry.record.source_ref ?? null,
    correlation_key: entry.record.correlation_key ?? null,
    disposition: entry.record.disposition ?? null,
    origin: entry.record.origin ?? null,
    processed_at: entry.record.processed_at ?? entry.timestamp,
    processed_by: entry.record.processed_by ?? null,
    receipt_path: entry.file_path,
  };
}

function summarizeOutboxRecord(entry) {
  return {
    type: entry.record.type ?? null,
    source_ref: entry.record.source_ref ?? null,
    correlation_key: entry.record.correlation_key ?? null,
    emitted_at: entry.record.emitted_at ?? entry.timestamp,
    summary: entry.record.summary ?? null,
    file_path: entry.file_path,
  };
}

function summarizeHumanGateRecord(entry, activeApprovalSourceRef) {
  return {
    source_ref: entry.record.source_ref ?? null,
    correlation_key: entry.record.correlation_key ?? null,
    method: entry.record.method ?? entry.record.approval_method ?? null,
    thread_id: entry.record.thread_id ?? entry.record.threadId ?? null,
    observed_at: entry.record.received_at ?? entry.record.observed_at ?? entry.timestamp,
    active_approval_source_ref: activeApprovalSourceRef,
    foreground_required: true,
    file_path: entry.file_path,
  };
}

function buildTimelineEntry(kind, timestamp, sourcePath, summary, extra = {}) {
  return {
    kind,
    timestamp,
    source_path: sourcePath,
    summary,
    ...extra,
  };
}

function duplicateConsumedCorrelations(processedEntries) {
  const counts = new Map();
  for (const entry of processedEntries) {
    if (entry.record.disposition !== "consumed") continue;
    const key = entry.record.correlation_key ?? entry.record.source_ref ?? null;
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
}

function isStaleInflight(inflight, staleInFlightMs, now = Date.now()) {
  const timestamp = inflight?.started_at ?? inflight?.claimed_at ?? inflight?.received_at ?? null;
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return false;
  return now - parsed >= staleInFlightMs;
}

async function readWorkspaceRouter(sharedBase, workspaceKey) {
  const paths = routerPaths(sharedBase, workspaceKey);
  const pendingApprovals = (await readJsonIfExists(paths.pendingApprovalsPath))?.approvals ?? [];
  const outbox = await readJsonRecords(paths.outboxDir);
  const quarantine = await readJsonRecords(paths.quarantineDir);
  const bridgeEvents = await readJsonlTail(paths.bridgeEventsPath);
  const schedulerEvents = await readJsonlTail(paths.schedulerEventsPath);
  const gatewayAdapterState = await readJsonIfExists(paths.gatewayAdapterStatePath);
  const gatewayAdapterEvents = await readJsonlTail(paths.gatewayAdapterEventsPath);
  return {
    paths,
    pending_approvals: pendingApprovals,
    outbox,
    quarantine,
    bridge_events: bridgeEvents,
    scheduler_events: schedulerEvents,
    gateway_adapter_state: gatewayAdapterState,
    gateway_adapter_events: gatewayAdapterEvents,
  };
}

function summarizeGatewayAdapter(routerSnapshot, projectKey = null) {
  const state = routerSnapshot.gateway_adapter_state ?? null;
  const stateSnapshot = state?.snapshot ?? {};
  const relevantEvents = routerSnapshot.gateway_adapter_events.filter((event) => {
    if (projectKey == null) return true;
    return event.project_key === projectKey;
  });
  const lastInteraction =
    relevantEvents.find((event) => event.type === "interaction_create") ?? relevantEvents[0] ?? null;

  return {
    observed_at: state?.observed_at ?? null,
    last_event_type: state?.last_event_type ?? null,
    ready_seen: stateSnapshot.ready_seen ?? false,
    session_id: stateSnapshot.session_id ?? null,
    seq: state?.seq ?? stateSnapshot.seq ?? null,
    ws_connected: stateSnapshot.is_stopped === false,
    last_project_interaction: lastInteraction
      ? {
          interaction_id: lastInteraction.interaction_id ?? null,
          command_class: lastInteraction.command_class ?? null,
          project_key: lastInteraction.project_key ?? null,
          observed_at: lastInteraction.observed_at ?? lastInteraction.emitted_at ?? null,
          delivery_decision: lastInteraction.delivery_decision ?? null,
        }
      : null,
  };
}

function approvalsByProject(routerSnapshot, projectKey) {
  return routerSnapshot.pending_approvals.filter((entry) => entry.project_key === projectKey);
}

function lastOutboxForProject(routerSnapshot, projectKey) {
  return routerSnapshot.outbox.find((entry) => entry.record.project_key === projectKey) ?? null;
}

function quarantineCountForProject(routerSnapshot, projectKey) {
  return routerSnapshot.quarantine.filter(
    (entry) => entry.record.project_key === projectKey || entry.record.project_key == null,
  ).length;
}

async function readProjectCollections(paths) {
  const [processed, humanGate, inbox, dispatchQueue] = await Promise.all([
    readJsonRecords(paths.processedDir, 100),
    readJsonRecords(paths.humanGateDir, 100),
    readJsonRecords(paths.inboxDir, 100),
    readJsonRecords(paths.dispatchQueueDir, 100),
  ]);
  return { processed, humanGate, inbox, dispatchQueue };
}

function buildIncidentReasons({
  snapshot,
  pendingApprovals,
  inflight,
  processedEntries,
  quarantineCount,
  staleInFlightMs,
}) {
  const incidents = [];
  if (snapshot.stop_conditions?.must_human_check) {
    incidents.push("must_human_check");
  }
  if ((snapshot.counts?.human_gate_candidates ?? 0) > 0 || pendingApprovals.length > 0) {
    incidents.push("pending_human_gate");
  }
  if (
    snapshot.background_trigger_toggle?.foreground_session_active &&
    snapshot.background_trigger_toggle?.background_trigger_enabled
  ) {
    incidents.push("foreground_background_conflict");
  }
  if (inflight && isStaleInflight(inflight, staleInFlightMs)) {
    incidents.push("stale_inflight_delivery");
  }
  if (duplicateConsumedCorrelations(processedEntries).length > 0) {
    incidents.push("duplicate_processed_consumed");
  }
  if (quarantineCount > 0) {
    incidents.push("quarantine_accumulation");
  }
  return incidents;
}

export async function readPortfolioOverview({
  sharedBase,
  workspaceKey,
  staleInFlightMs = DEFAULT_STALE_INFLIGHT_MS,
}) {
  const projectKeys = await listProjectKeys(sharedBase, workspaceKey);
  const routerSnapshot = await readWorkspaceRouter(sharedBase, workspaceKey);
  const projects = [];

  for (const projectKey of projectKeys) {
    const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
    const [snapshot, inflight, collections] = await Promise.all([
      readProjectSnapshot(paths),
      readInFlightDelivery(paths),
      readProjectCollections(paths),
    ]);
    const summary = summarizeSnapshot(paths, snapshot);
    const scheduler = normalizeSchedulerDecision(snapshot);
    const pendingApprovals = approvalsByProject(routerSnapshot, projectKey);
    const lastOutbox = lastOutboxForProject(routerSnapshot, projectKey);
    const latestProcessed = collections.processed[0] ? summarizeProcessedRecord(collections.processed[0]) : null;
    const incidentReasons = buildIncidentReasons({
      snapshot,
      pendingApprovals,
      inflight,
      processedEntries: collections.processed,
      quarantineCount: quarantineCountForProject(routerSnapshot, projectKey),
      staleInFlightMs,
    });

    projects.push({
      workspace_key: workspaceKey,
      project_key: projectKey,
      coordinator_status: normalizeStatusType(snapshot),
      background_trigger_enabled: summary.background_trigger_enabled,
      foreground_session_active: summary.foreground_session_active,
      background_mode:
        summary.background_trigger_enabled === true && summary.foreground_session_active !== true,
      scheduler_decision: scheduler.decision,
      blocked_reasons: scheduler.reasons,
      dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
      inbox_count: snapshot.counts?.inbox ?? 0,
      human_gate_count: snapshot.counts?.human_gate_candidates ?? 0,
      pending_approvals_count: pendingApprovals.length,
      last_processed: latestProcessed,
      last_outbox_event: lastOutbox ? summarizeOutboxRecord(lastOutbox) : null,
      incidents: incidentReasons,
      updated_at:
        latestProcessed?.processed_at ??
        lastOutbox?.timestamp ??
        scheduler.recorded_at ??
        snapshot.coordinator_status?.observed_at ??
        null,
    });
  }

  return {
    workspace_key: workspaceKey,
    project_count: projects.length,
    gateway_adapter: summarizeGatewayAdapter(routerSnapshot),
    projects: sortByTimestampDesc(projects.map((project) => ({ ...project, timestamp: project.updated_at }))).map(
      ({ timestamp, ...project }) => project,
    ),
    generated_at: new Date().toISOString(),
  };
}

export async function readProjectDetail({
  sharedBase,
  workspaceKey,
  projectKey,
  staleInFlightMs = DEFAULT_STALE_INFLIGHT_MS,
}) {
  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  const routerSnapshot = await readWorkspaceRouter(sharedBase, workspaceKey);
  const [snapshot, inflight, collections] = await Promise.all([
    readProjectSnapshot(paths),
    readInFlightDelivery(paths),
    readProjectCollections(paths),
  ]);
  const pendingApprovals = approvalsByProject(routerSnapshot, projectKey);
  const scheduler = normalizeSchedulerDecision(snapshot);
  const incidentReasons = buildIncidentReasons({
    snapshot,
    pendingApprovals,
    inflight,
    processedEntries: collections.processed,
    quarantineCount: quarantineCountForProject(routerSnapshot, projectKey),
    staleInFlightMs,
  });

  return {
    workspace_key: workspaceKey,
    project_key: projectKey,
    summary: summarizeSnapshot(paths, snapshot),
    coordinator: {
      binding: snapshot.coordinator_binding ?? null,
      lease: snapshot.coordinator_lease ?? null,
      status: snapshot.coordinator_status ?? null,
    },
    mode: {
      background_trigger_toggle: snapshot.background_trigger_toggle ?? null,
      scheduler_runtime: snapshot.scheduler_runtime ?? null,
      inflight_delivery: inflight,
    },
    queues: {
      inbox_count: snapshot.counts?.inbox ?? 0,
      dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
      processed_count: snapshot.counts?.processed ?? 0,
      human_gate_count: snapshot.counts?.human_gate_candidates ?? 0,
      inbox_preview: collections.inbox.slice(0, 5).map((entry) => ({
        source_ref: entry.record.source_ref ?? null,
        correlation_key: entry.record.correlation_key ?? null,
        command_class: entry.record.command_class ?? entry.record.type ?? null,
        received_at: entry.record.received_at ?? entry.timestamp,
      })),
      dispatch_preview: collections.dispatchQueue.slice(0, 5).map((entry) => ({
        source_ref: entry.record.source_ref ?? null,
        correlation_key: entry.record.correlation_key ?? null,
        command_class: entry.record.command_class ?? entry.record.type ?? null,
        received_at: entry.record.received_at ?? entry.timestamp,
      })),
    },
    approvals: {
      pending_approvals: pendingApprovals,
      active_approval_source_ref: snapshot.coordinator_status?.active_approval_source_ref ?? null,
      human_gate_candidates: collections.humanGate
        .slice(0, 20)
        .map((entry) =>
          summarizeHumanGateRecord(entry, snapshot.coordinator_status?.active_approval_source_ref ?? null),
        ),
    },
    last_action: {
      last_processed: collections.processed[0] ? summarizeProcessedRecord(collections.processed[0]) : null,
      last_outbox: lastOutboxForProject(routerSnapshot, projectKey)
        ? summarizeOutboxRecord(lastOutboxForProject(routerSnapshot, projectKey))
        : null,
      last_blocked_reason: scheduler.decision === "blocked" ? scheduler.reasons : [],
    },
    gateway_adapter: summarizeGatewayAdapter(routerSnapshot, projectKey),
    incidents: incidentReasons,
    generated_at: new Date().toISOString(),
  };
}

export async function readProjectTimeline({
  sharedBase,
  workspaceKey,
  projectKey,
  limit = 50,
}) {
  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  const routerSnapshot = await readWorkspaceRouter(sharedBase, workspaceKey);
  const [snapshot, inflight, collections] = await Promise.all([
    readProjectSnapshot(paths),
    readInFlightDelivery(paths),
    readProjectCollections(paths),
  ]);

  const entries = [];
  const scheduler = normalizeSchedulerDecision(snapshot);
  if (scheduler.recorded_at || scheduler.decision !== "unknown") {
    entries.push(
      buildTimelineEntry(
        "scheduler_decision",
        scheduler.recorded_at ?? new Date().toISOString(),
        path.join(paths.runtimeDir, "scheduler_runtime.json"),
        `${scheduler.decision}${scheduler.reasons.length ? `: ${scheduler.reasons.join(", ")}` : ""}`,
        { reasons: scheduler.reasons },
      ),
    );
  }

  if (snapshot.coordinator_status?.observed_at) {
    entries.push(
      buildTimelineEntry(
        "coordinator_status",
        snapshot.coordinator_status.observed_at,
        path.join(paths.stateDir, "coordinator_status.json"),
        normalizeStatusType(snapshot),
        { status: snapshot.coordinator_status },
      ),
    );
  }

  if (routerSnapshot.gateway_adapter_state?.observed_at) {
    entries.push(
      buildTimelineEntry(
        "gateway_adapter_state",
        routerSnapshot.gateway_adapter_state.observed_at,
        routerSnapshot.paths.gatewayAdapterStatePath,
        routerSnapshot.gateway_adapter_state.last_event_type ?? "gateway_state",
        { state: routerSnapshot.gateway_adapter_state },
      ),
    );
  }

  for (const event of routerSnapshot.gateway_adapter_events.filter((item) => item.project_key === projectKey)) {
    entries.push(
      buildTimelineEntry(
        "gateway_interaction",
        event.observed_at ?? event.emitted_at ?? new Date().toISOString(),
        routerSnapshot.paths.gatewayAdapterEventsPath,
        `${event.command_class ?? "interaction"} ${event.delivery_decision ?? "-"}`.trim(),
        { event },
      ),
    );
  }

  if (inflight) {
    entries.push(
      buildTimelineEntry(
        "inflight_delivery",
        extractTimestamp(inflight) ?? new Date().toISOString(),
        path.join(paths.runtimeDir, "inflight_delivery.json"),
        inflight.correlation_key ?? inflight.source_ref ?? "inflight",
        { inflight },
      ),
    );
  }

  for (const entry of collections.processed) {
    entries.push(
      buildTimelineEntry(
        `processed:${entry.record.disposition ?? "unknown"}`,
        entry.record.processed_at ?? entry.timestamp,
        entry.file_path,
        `${entry.record.disposition ?? "processed"} ${entry.record.correlation_key ?? entry.record.source_ref ?? ""}`.trim(),
        { record: entry.record },
      ),
    );
  }

  for (const entry of collections.humanGate) {
    entries.push(
      buildTimelineEntry(
        "human_gate_candidate",
        entry.record.received_at ?? entry.timestamp,
        entry.file_path,
        entry.record.source_ref ?? entry.record.correlation_key ?? "human_gate_candidate",
        { record: entry.record },
      ),
    );
  }

  for (const entry of routerSnapshot.outbox.filter((item) => item.record.project_key === projectKey)) {
    entries.push(
      buildTimelineEntry(
        `outbox:${entry.record.type ?? "unknown"}`,
        entry.record.emitted_at ?? entry.timestamp,
        entry.file_path,
        entry.record.type ?? "outbox",
        { record: entry.record },
      ),
    );
  }

  return {
    workspace_key: workspaceKey,
    project_key: projectKey,
    entries: sortByTimestampDesc(entries).slice(0, limit),
    generated_at: new Date().toISOString(),
  };
}

export async function readHumanGateView({
  sharedBase,
  workspaceKey,
}) {
  const routerSnapshot = await readWorkspaceRouter(sharedBase, workspaceKey);
  const projectKeys = await listProjectKeys(sharedBase, workspaceKey);
  const entries = [];

  for (const projectKey of projectKeys) {
    const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
    const snapshot = await readProjectSnapshot(paths);
    const humanGateRecords = await readJsonRecords(paths.humanGateDir, 100);
    for (const record of humanGateRecords) {
      entries.push({
        workspace_key: workspaceKey,
        project_key: projectKey,
        ...summarizeHumanGateRecord(record, snapshot.coordinator_status?.active_approval_source_ref ?? null),
      });
    }
    for (const approval of approvalsByProject(routerSnapshot, projectKey)) {
      entries.push({
        workspace_key: workspaceKey,
        project_key: projectKey,
        source_ref: approval.source_ref ?? null,
        correlation_key: approval.source_ref ?? null,
        method: approval.method ?? null,
        thread_id: approval.thread_id ?? null,
        observed_at: approval.observed_at ?? null,
        active_approval_source_ref: snapshot.coordinator_status?.active_approval_source_ref ?? null,
        foreground_required: true,
        file_path: routerSnapshot.paths.pendingApprovalsPath,
      });
    }
  }

  return {
    workspace_key: workspaceKey,
    entries: sortByTimestampDesc(
      uniqueByKey(entries, (entry) => `${entry.project_key}:${entry.source_ref}:${entry.method}`),
    ),
    generated_at: new Date().toISOString(),
  };
}

export async function readIncidentView({
  sharedBase,
  workspaceKey,
  staleInFlightMs = DEFAULT_STALE_INFLIGHT_MS,
}) {
  const portfolio = await readPortfolioOverview({ sharedBase, workspaceKey, staleInFlightMs });
  const entries = [];

  for (const project of portfolio.projects) {
    for (const reason of project.incidents) {
      entries.push({
        workspace_key: workspaceKey,
        project_key: project.project_key,
        reason,
        coordinator_status: project.coordinator_status,
        scheduler_decision: project.scheduler_decision,
        blocked_reasons: project.blocked_reasons,
        updated_at: project.updated_at,
      });
    }
  }

  return {
    workspace_key: workspaceKey,
    entries: sortByTimestampDesc(entries.map((entry) => ({ ...entry, timestamp: entry.updated_at }))).map(
      ({ timestamp, ...entry }) => entry,
    ),
    generated_at: new Date().toISOString(),
  };
}
