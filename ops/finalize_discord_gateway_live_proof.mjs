import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  listFilesSafe,
  readJsonIfExists,
  readTextIfExists,
  writeAtomicJson,
} from "../scripts/lib/shared_memory_runtime.mjs";

function parseTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function atOrAfter(value, thresholdMs) {
  if (thresholdMs == null) return true;
  const parsed = parseTimestamp(value);
  if (parsed == null) return false;
  return parsed >= thresholdMs;
}

function recordTimestamp(record, fallback = null) {
  return (
    record?.emitted_at ??
    record?.observed_at ??
    record?.processed_at ??
    record?.recorded_at ??
    record?.received_at ??
    record?.updated_at ??
    fallback
  );
}

async function readJsonRecords(dirPath) {
  const names = await listFilesSafe(dirPath, ".json");
  const records = [];
  for (const name of names) {
    const filePath = path.join(dirPath, name);
    const record = await readJsonIfExists(filePath);
    if (!record) continue;
    records.push({
      filename: name,
      file_path: filePath,
      record,
      timestamp: recordTimestamp(record, name.split("_")[0] ?? null),
    });
  }
  return records.sort((left, right) => (right.timestamp ?? "").localeCompare(left.timestamp ?? ""));
}

async function readJsonlEvents(filePath) {
  const raw = await readTextIfExists(filePath);
  if (!raw) return [];
  const events = [];
  for (const line of raw.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return events;
}

function summarizeEvent(event) {
  return {
    type: event.type ?? null,
    observed_at: event.observed_at ?? null,
    interaction_id: event.interaction_id ?? null,
    command_class: event.command_class ?? null,
    project_key: event.project_key ?? null,
    response_plan: event.response_plan ?? null,
    delivery_decision: event.delivery_decision ?? null,
  };
}

function summarizeOutbox(entry) {
  return {
    type: entry.record.type ?? null,
    emitted_at: entry.record.emitted_at ?? entry.timestamp ?? null,
    source_ref: entry.record.source_ref ?? null,
    correlation_key: entry.record.correlation_key ?? null,
    summary: entry.record.summary ?? null,
    file_path: entry.file_path,
  };
}

function summarizeQuarantine(entry) {
  return {
    type: entry.record.type ?? null,
    received_at: entry.record.received_at ?? entry.timestamp ?? null,
    reason: entry.record.reason ?? null,
    source_ref: entry.record.source_ref ?? null,
    correlation_key: entry.record.correlation_key ?? null,
    file_path: entry.file_path,
  };
}

export async function finalizeDiscordGatewayLiveProof({
  workspace = process.env.REMODEX_WORKSPACE ?? process.cwd(),
  proofDir = process.env.REMODEX_DISCORD_LIVE_PROOF_DIR ?? path.join(workspace, "runtime", "live-discord-proof"),
  sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory"),
  workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex",
} = {}) {
  const bundlePath = path.join(proofDir, "live-proof-bundle.json");
  const outputPath = path.join(proofDir, "live-proof-final-summary.json");
  const routerRoot = path.join(sharedBase, workspaceKey, "router");
  const statePath = path.join(routerRoot, "discord_gateway_adapter_state.json");
  const eventsLogPath = path.join(routerRoot, "discord_gateway_events.jsonl");
  const outboxDir = path.join(routerRoot, "outbox");
  const quarantineDir = path.join(routerRoot, "quarantine");

  const blockers = [];
  const warnings = [];

  const bundle = await readJsonIfExists(bundlePath);
  if (!bundle) {
    blockers.push("missing_live_proof_bundle");
  }

  const startedAtMs = parseTimestamp(bundle?.started_at ?? null);
  if (bundle && startedAtMs == null) {
    warnings.push("bundle_started_at_unparseable");
  }

  const state = await readJsonIfExists(statePath);
  const events = await readJsonlEvents(eventsLogPath);
  const outboxRecords = await readJsonRecords(outboxDir);
  const quarantineRecords = await readJsonRecords(quarantineDir);

  const interactionEvents = events.filter(
    (event) => event.type === "interaction_create" && atOrAfter(event.observed_at ?? null, startedAtMs),
  );
  const readyEvents = events.filter(
    (event) =>
      (event.type === "ready" || event.type === "resumed") &&
      atOrAfter(event.observed_at ?? null, startedAtMs),
  );
  const filteredOutbox = outboxRecords.filter((entry) =>
    atOrAfter(entry.record.emitted_at ?? entry.timestamp ?? null, startedAtMs),
  );
  const filteredQuarantine = quarantineRecords.filter((entry) =>
    atOrAfter(entry.record.received_at ?? entry.timestamp ?? null, startedAtMs),
  );

  const expectInteraction = bundle?.expect_interaction === true;
  const bundleReadySeen = bundle?.proof?.ready_seen === true;
  const bundleInteractionSeen = bundle?.proof?.interaction_observed === true;
  const stateReadySeen = state?.snapshot?.ready_seen === true;

  if (bundle?.preflight?.ok !== true) blockers.push("preflight_not_ok");
  if (bundle?.register_commands_result && !["completed", "skipped"].includes(bundle.register_commands_result)) {
    blockers.push("register_commands_not_completed");
  }
  if (bundle?.ok !== true) blockers.push("live_proof_bundle_not_ok");
  if (!bundleReadySeen && !stateReadySeen) blockers.push("gateway_ready_not_observed");
  if (expectInteraction && !bundleInteractionSeen && interactionEvents.length === 0) {
    blockers.push("interaction_not_observed");
  }
  if (expectInteraction && interactionEvents.length === 0) {
    warnings.push("no_router_interaction_event_since_start");
  }
  if (filteredOutbox.length === 0) warnings.push("no_outbox_record_since_start");
  if (filteredQuarantine.length > 0) warnings.push("quarantine_record_observed_since_start");
  if (!state) warnings.push("missing_gateway_adapter_state");
  if (readyEvents.length === 0) warnings.push("no_ready_or_resumed_event_since_start");

  const summary = {
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    workspace_key: workspaceKey,
    proof_dir: proofDir,
    bundle_path: bundlePath,
    state_path: statePath,
    events_log_path: eventsLogPath,
    blockers,
    warnings,
    bundle: bundle
      ? {
          started_at: bundle.started_at ?? null,
          completed_at: bundle.completed_at ?? null,
          phase: bundle.phase ?? null,
          ok: bundle.ok === true,
          register_commands_result: bundle.register_commands_result ?? null,
          expect_interaction: expectInteraction,
          proof: {
            ready_seen: bundleReadySeen,
            interaction_observed: bundleInteractionSeen,
            timed_out: bundle?.proof?.timed_out === true,
          },
        }
      : null,
    gateway_state: state
      ? {
          observed_at: state.observed_at ?? null,
          last_event_type: state.last_event_type ?? null,
          event_type: state.event_type ?? null,
          seq: state.seq ?? null,
          ready_seen: stateReadySeen,
        }
      : null,
    counters: {
      interaction_events_since_start: interactionEvents.length,
      ready_events_since_start: readyEvents.length,
      outbox_records_since_start: filteredOutbox.length,
      quarantine_records_since_start: filteredQuarantine.length,
    },
    recent_interactions: interactionEvents.slice(-5).map(summarizeEvent),
    recent_outbox: filteredOutbox.slice(0, 5).map(summarizeOutbox),
    recent_quarantine: filteredQuarantine.slice(0, 5).map(summarizeQuarantine),
    next_step:
      blockers.length === 0
        ? "discord_live_ingress_proof_verified"
        : "inspect_blockers_and_repeat_live_proof",
  };

  await writeAtomicJson(outputPath, summary);
  return {
    output_path: outputPath,
    ...summary,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await finalizeDiscordGatewayLiveProof();
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
