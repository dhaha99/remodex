import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildProjectPaths,
  readJsonIfExists,
  writeAtomicJson,
} from "../scripts/lib/shared_memory_runtime.mjs";

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const stackDir = process.env.REMODEX_CHURN_STACK_DIR ?? path.join(workspace, "runtime", "churn");
const host = process.env.REMODEX_OPERATOR_HTTP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.REMODEX_OPERATOR_HTTP_PORT ?? "8787", 10);

function nowIso() {
  return new Date().toISOString();
}

function currentEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isoSafe(value) {
  return String(value).replaceAll(":", "-");
}

function interactionId(prefix, cycle) {
  return `${prefix}-${cycle}-${Date.now()}`;
}

function buildInteraction({
  id,
  commandName,
  projectKey,
  request = null,
  sourceRef = null,
  operatorId,
  roles,
}) {
  const options = [{ name: "project", value: projectKey }];
  if (request !== null) options.push({ name: "request", value: request });
  if (sourceRef !== null) options.push({ name: "source_ref", value: sourceRef });
  return {
    id,
    type: 2,
    guild_id: "remodex-guild",
    channel_id: "remodex-ops",
    timestamp: nowIso(),
    member: {
      user: { id: operatorId },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

function signInteraction(privateKey, timestamp, body) {
  return crypto.sign(null, Buffer.from(`${timestamp}${body}`, "utf8"), privateKey).toString("hex");
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function postInteraction(privateKey, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(currentEpochSeconds());
  const signature = signInteraction(privateKey, timestamp, body);
  const response = await fetch(`http://${host}:${port}/discord/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body,
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

async function updateProjectState(paths, { status, toggle, progressAxes }) {
  if (status) {
    const current = (await readJsonIfExists(path.join(paths.stateDir, "coordinator_status.json"))) ?? {};
    await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
      ...current,
      ...status,
      observed_at: nowIso(),
    });
  }
  if (toggle) {
    const current = (await readJsonIfExists(path.join(paths.stateDir, "background_trigger_toggle.json"))) ?? {};
    await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
      ...current,
      ...toggle,
    });
  }
  if (progressAxes) {
    const current = (await readJsonIfExists(path.join(paths.stateDir, "progress_axes.json"))) ?? {};
    await writeAtomicJson(path.join(paths.stateDir, "progress_axes.json"), {
      ...current,
      ...progressAxes,
    });
  }
}

const fixture = JSON.parse(await fs.readFile(path.join(stackDir, "churn_fixture.json"), "utf8"));
const driverStatePath = path.join(stackDir, "churn_driver_state.json");
const driverLogPath = path.join(stackDir, "driver_events.jsonl");
const state = JSON.parse(await fs.readFile(driverStatePath, "utf8"));
const privateKey = crypto.createPrivateKey(await fs.readFile(fixture.discord_keys.private_key_path, "utf8"));

const alphaPaths = buildProjectPaths({
  sharedBase,
  workspaceKey,
  projectKey: fixture.projects.alpha.project_key,
});
const betaPaths = buildProjectPaths({
  sharedBase,
  workspaceKey,
  projectKey: fixture.projects.beta.project_key,
});

const cycle = state.next_cycle ?? 0;
const phase = cycle % 4;
const phaseName =
  phase === 0
    ? "alpha_foreground_queue"
    : phase === 1
      ? "alpha_background_drain"
      : phase === 2
        ? "alpha_background_direct"
        : "beta_unauthorized_approval";

const actions = [];

if (!state.beta_candidate_seeded) {
  await updateProjectState(betaPaths, {
    status: {
      type: "waiting_on_approval",
      active_approval_source_ref: fixture.projects.beta.approval_source_ref,
      last_approval_method: "item/fileChange/requestApproval",
    },
    toggle: {
      background_trigger_enabled: true,
      foreground_lock_enabled: false,
      foreground_session_active: false,
    },
  });
  const seedPayload = buildInteraction({
    id: interactionId("beta-seed-approve", cycle),
    commandName: "approve",
    projectKey: fixture.projects.beta.project_key,
    sourceRef: fixture.projects.beta.approval_source_ref,
    operatorId: "ops-admin-1",
    roles: ["ops-admin"],
  });
  const seedResponse = await postInteraction(privateKey, seedPayload);
  actions.push({
    type: "beta_seed_human_gate_candidate",
    payload: seedPayload,
    response: seedResponse,
  });
  state.beta_candidate_seeded = true;
}

if (phaseName === "alpha_foreground_queue") {
  await updateProjectState(alphaPaths, {
    status: {
      type: "checkpoint_open",
      activeFlags: [],
    },
    toggle: {
      background_trigger_enabled: false,
      foreground_lock_enabled: true,
      foreground_session_active: true,
    },
    progressAxes: {
      next_smallest_batch: "queue alpha intent under foreground",
    },
  });
  const payload = buildInteraction({
    id: interactionId("alpha-fg-intent", cycle),
    commandName: "intent",
    projectKey: fixture.projects.alpha.project_key,
    request: `Append exactly one line "alpha-queued-${String(cycle).padStart(4, "0")}" to ${fixture.projects.alpha.target_file}. If the file does not exist, create it. Do not touch any other file.`,
    operatorId: "operator-1",
    roles: ["operator"],
  });
  actions.push({
    type: "alpha_foreground_intent",
    payload,
    response: await postInteraction(privateKey, payload),
  });
}

if (phaseName === "alpha_background_drain") {
  await updateProjectState(alphaPaths, {
    status: {
      type: "idle",
      activeFlags: [],
    },
    toggle: {
      background_trigger_enabled: true,
      foreground_lock_enabled: false,
      foreground_session_active: false,
    },
    progressAxes: {
      next_smallest_batch: "drain queued alpha work",
    },
  });
  const payload = buildInteraction({
    id: interactionId("alpha-status", cycle),
    commandName: "status",
    projectKey: fixture.projects.alpha.project_key,
    operatorId: "operator-1",
    roles: ["operator"],
  });
  actions.push({
    type: "alpha_status_refresh",
    payload,
    response: await postInteraction(privateKey, payload),
  });
}

if (phaseName === "alpha_background_direct") {
  await updateProjectState(alphaPaths, {
    status: {
      type: "idle",
      activeFlags: [],
    },
    toggle: {
      background_trigger_enabled: true,
      foreground_lock_enabled: false,
      foreground_session_active: false,
    },
    progressAxes: {
      next_smallest_batch: "direct alpha delivery",
    },
  });
  const payload = buildInteraction({
    id: interactionId("alpha-bg-intent", cycle),
    commandName: "intent",
    projectKey: fixture.projects.alpha.project_key,
    request: `Append exactly one line "alpha-direct-${String(cycle).padStart(4, "0")}" to ${fixture.projects.alpha.target_file}. If the file does not exist, create it. Do not touch any other file.`,
    operatorId: "operator-1",
    roles: ["operator"],
  });
  actions.push({
    type: "alpha_background_intent",
    payload,
    response: await postInteraction(privateKey, payload),
  });
}

if (phaseName === "beta_unauthorized_approval") {
  await updateProjectState(betaPaths, {
    status: {
      type: "waiting_on_approval",
      active_approval_source_ref: fixture.projects.beta.approval_source_ref,
      last_approval_method: "item/fileChange/requestApproval",
    },
  });
  const payload = buildInteraction({
    id: interactionId("beta-viewer-approve", cycle),
    commandName: "approve",
    projectKey: fixture.projects.beta.project_key,
    sourceRef: fixture.projects.beta.approval_source_ref,
    operatorId: "viewer-1",
    roles: ["viewer"],
  });
  actions.push({
    type: "beta_unauthorized_approval",
    payload,
    response: await postInteraction(privateKey, payload),
  });
}

const event = {
  recorded_at: nowIso(),
  cycle,
  phase: phaseName,
  actions,
};
await appendJsonl(driverLogPath, event);

await writeAtomicJson(driverStatePath, {
  next_cycle: cycle + 1,
  beta_candidate_seeded: state.beta_candidate_seeded,
  last_phase: phaseName,
  last_recorded_at: event.recorded_at,
});

console.log(JSON.stringify({
  ok: true,
  cycle,
  phase: phaseName,
  action_count: actions.length,
  driver_state_path: driverStatePath,
}, null, 2));
