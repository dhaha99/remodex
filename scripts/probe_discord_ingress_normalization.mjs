import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "discord_ingress_probe");
const alphaInboxDir = path.join(probeDir, "external-shared-memory", "remodex", "projects", "project-alpha", "inbox");
const betaInboxDir = path.join(probeDir, "external-shared-memory", "remodex", "projects", "project-beta", "inbox");
const quarantineDir = path.join(probeDir, "router", "quarantine");
const summaryPath = path.join(verificationDir, "discord_ingress_probe_summary.json");

await fs.mkdir(verificationDir, { recursive: true });

function isoSafe(ts) {
  return ts.replaceAll(":", "-");
}

function correlationKey(payload) {
  return `${payload.guild_id}:${payload.channel_id}:${payload.id}`;
}

function normalizeIntentPayload(payload) {
  const projectOption = payload.data.options?.find((option) => option.name === "project")?.value ?? null;
  const requestOption = payload.data.options?.find((option) => option.name === "request")?.value ?? null;
  const artifactOption = payload.data.options?.find((option) => option.name === "artifact")?.value ?? null;
  return {
    source: "discord",
    operator_id: payload.member.user.id,
    operator_roles: payload.member.roles,
    command_name: payload.data.name,
    workspace_key: "remodex",
    project_key: projectOption,
    request: requestOption,
    artifact: artifactOption,
    source_ref: `${payload.id}`,
    correlation_key: correlationKey(payload),
    received_at: payload.timestamp,
  };
}

function evaluateAcl(intent) {
  const operatorRoles = new Set(intent.operator_roles);
  if (intent.command_name === "approve" && !operatorRoles.has("ops-admin")) {
    return { decision: "quarantine", reason: "unauthorized_approval" };
  }
  if (!intent.project_key) {
    return { decision: "quarantine", reason: "missing_project" };
  }
  if (!["project-alpha", "project-beta"].includes(intent.project_key)) {
    return { decision: "quarantine", reason: "unknown_project" };
  }
  return { decision: "route", reason: null };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function processPayload(payload) {
  const intent = normalizeIntentPayload(payload);
  const acl = evaluateAcl(intent);
  const filename = `${isoSafe(payload.timestamp)}_${intent.command_name}_${intent.source_ref}.json`;
  if (acl.decision === "route") {
    const targetDir = intent.project_key === "project-alpha" ? alphaInboxDir : betaInboxDir;
    const record = {
      ...intent,
      type: intent.command_name === "approve" ? "approval_intent" : "operator_intent",
      command_class: intent.command_name,
      route_decision: "route",
    };
    const filePath = path.join(targetDir, filename);
    await writeJson(filePath, record);
    return { route: "inbox", filePath, record };
  }

  const filePath = path.join(quarantineDir, filename);
  const record = {
    ...intent,
    route_decision: "quarantine",
    quarantine_reason: acl.reason,
  };
  await writeJson(filePath, record);
  return { route: "quarantine", filePath, record };
}

const payloads = [
  {
    id: "discord-msg-001",
    guild_id: "guild-1",
    channel_id: "alpha-ops",
    timestamp: "2026-03-25T11:20:00+09:00",
    member: {
      user: { id: "user-ops-1" },
      roles: ["ops-admin", "operator"],
    },
    data: {
      name: "intent",
      options: [
        { name: "project", value: "project-alpha" },
        { name: "request", value: "backend bug first" },
      ],
    },
  },
  {
    id: "discord-msg-002",
    guild_id: "guild-1",
    channel_id: "shared-ops",
    timestamp: "2026-03-25T11:21:00+09:00",
    member: {
      user: { id: "user-viewer-2" },
      roles: ["viewer"],
    },
    data: {
      name: "approve",
      options: [
        { name: "project", value: "project-alpha" },
        { name: "artifact", value: "artifact-204" },
      ],
    },
  },
  {
    id: "discord-msg-003",
    guild_id: "guild-1",
    channel_id: "shared-ops",
    timestamp: "2026-03-25T11:22:00+09:00",
    member: {
      user: { id: "user-ops-3" },
      roles: ["ops-admin", "operator"],
    },
    data: {
      name: "intent",
      options: [{ name: "request", value: "frontend spacing check" }],
    },
  },
];

const summary = {
  startedAt: new Date().toISOString(),
  processed: [],
};

try {
  await fs.rm(probeDir, { recursive: true, force: true });

  for (const payload of payloads) {
    const result = await processPayload(payload);
    summary.processed.push({
      payload_id: payload.id,
      route: result.route,
      filePath: result.filePath,
      record: result.record,
    });
  }

  summary.alphaInboxFiles = await fs.readdir(alphaInboxDir).catch(() => []);
  summary.betaInboxFiles = await fs.readdir(betaInboxDir).catch(() => []);
  summary.quarantineFiles = await fs.readdir(quarantineDir).catch(() => []);
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
}
