import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_STATE_BASENAMES = [
  "project_identity",
  "coordinator_binding",
  "coordinator_lease",
  "coordinator_status",
  "prompt_contract_binding",
  "strategy_binding",
  "roadmap_status",
  "autonomy_policy",
  "background_trigger_toggle",
  "stop_conditions",
  "current_goal",
  "current_plan",
  "current_focus",
  "active_owner",
  "progress_axes",
  "deferred_queue",
  "pending_artifacts",
  "operator_acl",
];

export function isoSafe(value) {
  return String(value).replaceAll(":", "-").replaceAll("/", "-");
}

export function safeFileFragment(value) {
  return String(value ?? "unknown")
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

export function buildProjectPaths({ sharedBase, workspaceKey, projectKey, projectRoot }) {
  const root = projectRoot ?? path.join(sharedBase, workspaceKey, "projects", projectKey);
  const projectsRoot = path.dirname(root);
  const workspaceRoot = path.dirname(projectsRoot);
  return {
    root,
    workspaceRoot,
    projectsRoot,
    stateDir: path.join(root, "state"),
    runtimeDir: path.join(root, "runtime"),
    inboxDir: path.join(root, "inbox"),
    dispatchQueueDir: path.join(root, "dispatch_queue"),
    processedDir: path.join(root, "processed"),
    humanGateDir: path.join(root, "human_gate_candidates"),
    pulsesDir: path.join(root, "pulses"),
    evidenceDir: path.join(root, "evidence"),
    routerRoot: path.join(workspaceRoot, "router"),
    quarantineDir: path.join(workspaceRoot, "router", "quarantine"),
    outboxDir: path.join(workspaceRoot, "router", "outbox"),
  };
}

export async function ensureProjectDirs(paths) {
  await Promise.all([
    fs.mkdir(paths.root, { recursive: true }),
    fs.mkdir(paths.stateDir, { recursive: true }),
    fs.mkdir(paths.runtimeDir, { recursive: true }),
    fs.mkdir(paths.inboxDir, { recursive: true }),
    fs.mkdir(paths.dispatchQueueDir, { recursive: true }),
    fs.mkdir(paths.processedDir, { recursive: true }),
    fs.mkdir(paths.humanGateDir, { recursive: true }),
    fs.mkdir(paths.pulsesDir, { recursive: true }),
    fs.mkdir(paths.evidenceDir, { recursive: true }),
    fs.mkdir(paths.quarantineDir, { recursive: true }),
    fs.mkdir(paths.outboxDir, { recursive: true }),
  ]);
}

export async function listFilesSafe(dirPath, extensionFilter = null) {
  try {
    const names = await fs.readdir(dirPath);
    return names
      .filter((name) => !extensionFilter || name.endsWith(extensionFilter))
      .sort();
  } catch {
    return [];
  }
}

export async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  return JSON.parse(text);
}

function coerceValue(rawValue) {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

export function parseKeyValueMarkdown(text) {
  const result = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("```")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    result[key] = coerceValue(value);
  }
  return result;
}

export function parseStructuredText(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const fencedJson = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedJson) {
    return JSON.parse(fencedJson[1]);
  }

  return parseKeyValueMarkdown(trimmed);
}

export async function readStructuredFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  if (filePath.endsWith(".json")) {
    return JSON.parse(text);
  }
  return parseStructuredText(text);
}

export async function readStructuredIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (text === null) return null;
  if (filePath.endsWith(".json")) {
    return JSON.parse(text);
  }
  return parseStructuredText(text);
}

export async function findStructuredFile(dirPath, basename) {
  for (const extension of [".json", ".md", ".txt"]) {
    const candidate = path.join(dirPath, `${basename}${extension}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readNamedState(paths, basename) {
  const filePath = await findStructuredFile(paths.stateDir, basename);
  if (!filePath) return null;
  return await readStructuredFile(filePath);
}

export async function readNamedRuntime(paths, basename) {
  const filePath = await findStructuredFile(paths.runtimeDir, basename);
  if (!filePath) return null;
  return await readStructuredFile(filePath);
}

async function atomicWrite(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

export async function writeAtomicText(filePath, text) {
  await atomicWrite(filePath, text);
}

export async function writeAtomicJson(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function renderProcessedIndex(entries) {
  return [
    "# Processed Correlation Index",
    "",
    "```json",
    JSON.stringify({ entries }, null, 2),
    "```",
    "",
  ].join("\n");
}

export async function readProcessedIndexEntries(paths) {
  const indexPath = path.join(paths.stateDir, "processed_correlation_index.md");
  const text = await readTextIfExists(indexPath);
  if (!text) return [];
  const parsed = parseStructuredText(text);
  return parsed.entries ?? [];
}

export async function writeProcessedIndexEntries(paths, entries) {
  const indexPath = path.join(paths.stateDir, "processed_correlation_index.md");
  await writeAtomicText(indexPath, renderProcessedIndex(entries));
  return indexPath;
}

export async function findProcessedCorrelation(paths, correlationKey) {
  const entries = await readProcessedIndexEntries(paths);
  return entries.find((entry) => entry.correlation_key === correlationKey) ?? null;
}

export async function appendProcessedIndexEntry(paths, entry) {
  const entries = await readProcessedIndexEntries(paths);
  const existing = entries.find(
    (candidate) =>
      candidate.correlation_key === entry.correlation_key &&
      candidate.source_ref === entry.source_ref &&
      candidate.disposition === entry.disposition,
  );
  if (existing) {
    return { indexPath: path.join(paths.stateDir, "processed_correlation_index.md"), entry: existing };
  }
  entries.push(entry);
  const indexPath = await writeProcessedIndexEntries(paths, entries);
  return { indexPath, entry };
}

export function buildRecordFilename(prefix, sourceRef, receivedAt = new Date().toISOString()) {
  return `${isoSafe(receivedAt)}_${safeFileFragment(prefix)}_${safeFileFragment(sourceRef)}.json`;
}

async function writeRoutedRecord(dirPath, record, filename) {
  const filePath = path.join(dirPath, filename);
  await writeAtomicJson(filePath, record);
  return { filePath, filename, record };
}

export async function writeInboxEvent(paths, record, filename = null) {
  const resolvedFilename = filename ?? buildRecordFilename(record.command_class ?? record.type ?? "event", record.source_ref ?? record.correlation_key, record.received_at ?? new Date().toISOString());
  return await writeRoutedRecord(paths.inboxDir, record, resolvedFilename);
}

export async function writeDispatchTicket(paths, record, filename = null) {
  const resolvedFilename = filename ?? buildRecordFilename("dispatch", record.source_ref ?? record.correlation_key, record.received_at ?? new Date().toISOString());
  return await writeRoutedRecord(paths.dispatchQueueDir, record, resolvedFilename);
}

export async function writeHumanGateCandidate(paths, record, filename = null) {
  const resolvedFilename = filename ?? buildRecordFilename("approve", record.source_ref ?? record.correlation_key, record.received_at ?? new Date().toISOString());
  return await writeRoutedRecord(paths.humanGateDir, record, resolvedFilename);
}

export async function writeQuarantineRecord(paths, record, filename = null) {
  const resolvedFilename = filename ?? buildRecordFilename("quarantine", record.source_ref ?? record.correlation_key, record.received_at ?? new Date().toISOString());
  return await writeRoutedRecord(paths.quarantineDir, record, resolvedFilename);
}

export async function writeOutboxRecord(paths, record, filename = null) {
  const resolvedFilename = filename ?? buildRecordFilename(record.type ?? "outbox", record.source_ref ?? record.correlation_key, record.emitted_at ?? new Date().toISOString());
  return await writeRoutedRecord(paths.outboxDir, record, resolvedFilename);
}

export async function readInFlightDelivery(paths) {
  return await readJsonIfExists(path.join(paths.runtimeDir, "inflight_delivery.json"));
}

export async function writeInFlightDelivery(paths, claim) {
  const filePath = path.join(paths.runtimeDir, "inflight_delivery.json");
  await writeAtomicJson(filePath, claim);
  return filePath;
}

export async function clearInFlightDelivery(paths) {
  const filePath = path.join(paths.runtimeDir, "inflight_delivery.json");
  await removeIfExists(filePath);
  return filePath;
}

export async function readRecord(filePath) {
  return await readStructuredFile(filePath);
}

export async function removeIfExists(filePath) {
  await fs.rm(filePath, { force: true });
}

export async function removeSiblingDispatchTickets(paths, correlationKey) {
  const dispatchFiles = await listFilesSafe(paths.dispatchQueueDir, ".json");
  const removed = [];
  for (const fileName of dispatchFiles) {
    const filePath = path.join(paths.dispatchQueueDir, fileName);
    const record = await readJsonIfExists(filePath);
    if (!record || record.correlation_key !== correlationKey) continue;
    await removeIfExists(filePath);
    removed.push(filePath);
  }
  return removed;
}

export async function markProcessed(paths, {
  record,
  sourcePath,
  disposition,
  origin,
  processedBy,
  extra = {},
  removeSource = true,
}) {
  const processedAt = extra.processed_at ?? new Date().toISOString();
  const receipt = {
    workspace_key: record.workspace_key,
    project_key: record.project_key,
    namespace_ref: paths.root,
    source_ref: record.source_ref,
    correlation_key: record.correlation_key,
    source_command_class: record.command_class ?? record.type ?? null,
    source_auth_class: record.auth_class ?? null,
    source_request: record.request ?? null,
    project_display_name: record.project_display_name ?? record.display_name ?? null,
    processed_at: processedAt,
    processed_by: processedBy,
    disposition,
    origin,
    ...extra,
  };

  const receiptFilename = buildRecordFilename(
    disposition,
    record.source_ref ?? record.correlation_key,
    processedAt,
  );
  const receiptPath = path.join(paths.processedDir, receiptFilename);
  await writeAtomicJson(receiptPath, receipt);
  await appendProcessedIndexEntry(paths, {
    correlation_key: receipt.correlation_key,
    source_ref: receipt.source_ref,
    disposition: receipt.disposition,
    origin: receipt.origin,
    processed_at: receipt.processed_at,
    processed_by: receipt.processed_by,
    processed_receipt: receiptPath,
  });

  if (removeSource && sourcePath) {
    await removeIfExists(sourcePath);
  }
  await removeSiblingDispatchTickets(paths, record.correlation_key);

  return { receiptPath, receipt };
}

export async function readOperatorAcl(paths) {
  const record = await readNamedState(paths, "operator_acl");
  return {
    status_allow: record?.status_allow ?? "operator",
    intent_allow: record?.intent_allow ?? "operator",
    reply_allow: record?.reply_allow ?? "operator",
    approval_allow: record?.approval_allow ?? "ops-admin",
  };
}

function pickNextSmallestBatch(progressAxes, inboxPreview) {
  if (progressAxes?.next_smallest_batch) return progressAxes.next_smallest_batch;
  if (inboxPreview?.next_smallest_batch) return inboxPreview.next_smallest_batch;
  return null;
}

export async function readProjectSnapshot(paths) {
  const state = {};
  for (const basename of DEFAULT_STATE_BASENAMES) {
    state[basename] = await readNamedState(paths, basename);
  }
  const schedulerRuntime = await readNamedRuntime(paths, "scheduler_runtime");
  const inboxFiles = await listFilesSafe(paths.inboxDir, ".json");
  const dispatchFiles = await listFilesSafe(paths.dispatchQueueDir, ".json");
  const processedFiles = await listFilesSafe(paths.processedDir, ".json");
  const humanGateFiles = await listFilesSafe(paths.humanGateDir, ".json");
  const pulseFiles = await listFilesSafe(paths.pulsesDir);
  const evidenceFiles = await listFilesSafe(paths.evidenceDir);
  const inboxPreview = inboxFiles.length > 0 ? await readJsonIfExists(path.join(paths.inboxDir, inboxFiles[0])) : null;

  return {
    ...state,
    scheduler_runtime: schedulerRuntime,
    counts: {
      inbox: inboxFiles.length,
      dispatch_queue: dispatchFiles.length,
      processed: processedFiles.length,
      human_gate_candidates: humanGateFiles.length,
      pulses: pulseFiles.length,
      evidence: evidenceFiles.length,
    },
    file_names: {
      inbox: inboxFiles,
      dispatch_queue: dispatchFiles,
      processed: processedFiles,
      human_gate_candidates: humanGateFiles,
      pulses: pulseFiles,
      evidence: evidenceFiles,
    },
    next_smallest_batch: pickNextSmallestBatch(state.progress_axes, inboxPreview),
    inbox_preview: inboxPreview,
  };
}

export function summarizeSnapshot(paths, snapshot) {
  return {
    workspace_key:
      snapshot.project_identity?.workspace_key ??
      snapshot.coordinator_binding?.workspace_key ??
      path.basename(paths.workspaceRoot),
    project_key:
      snapshot.project_identity?.project_key ??
      snapshot.coordinator_binding?.project_key ??
      path.basename(paths.root),
    strategy_version: snapshot.strategy_binding?.strategy_version ?? null,
    roadmap_current_point: snapshot.roadmap_status?.roadmap_current_point ?? snapshot.roadmap_status?.current_point ?? null,
    current_goal: snapshot.current_goal?.current_goal ?? snapshot.current_goal?.goal ?? null,
    current_focus: snapshot.current_focus?.current_focus ?? null,
    active_owner: snapshot.active_owner?.active_owner ?? null,
    coordinator_status:
      snapshot.coordinator_status?.type ??
      snapshot.coordinator_status?.status?.type ??
      snapshot.coordinator_status?.status ??
      null,
    background_trigger_enabled: snapshot.background_trigger_toggle?.background_trigger_enabled ?? null,
    foreground_session_active: snapshot.background_trigger_toggle?.foreground_session_active ?? null,
    must_human_check: snapshot.stop_conditions?.must_human_check ?? false,
    pending_human_gate: snapshot.stop_conditions?.pending_human_gate ?? null,
    active_approval_source_ref: snapshot.coordinator_status?.active_approval_source_ref ?? null,
    latest_validated_change: snapshot.progress_axes?.latest_validated_change ?? null,
    blockers: snapshot.progress_axes?.blockers ?? null,
    next_smallest_batch: snapshot.next_smallest_batch,
    pending_artifacts: snapshot.pending_artifacts?.pending_artifacts ?? null,
    inbox_count: snapshot.counts?.inbox ?? 0,
    dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
    human_gate_candidate_count: snapshot.counts?.human_gate_candidates ?? 0,
    processed_count: snapshot.counts?.processed ?? 0,
  };
}

export async function listProjectKeys(sharedBase, workspaceKey) {
  const projectsRoot = path.join(sharedBase, workspaceKey, "projects");
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
