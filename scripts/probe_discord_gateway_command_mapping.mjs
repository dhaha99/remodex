import fs from "node:fs/promises";
import path from "node:path";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_gateway_command_mapping_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const workspaceKey = "remodex";
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_command_mapping_probe_summary.json",
);

function interaction({
  id,
  commandName,
  project,
  request = null,
  sourceRef = null,
  roles = ["operator"],
}) {
  const options = [{ name: "project", value: project }];
  if (request) options.push({ name: "request", value: request });
  if (sourceRef) options.push({ name: "source_ref", value: sourceRef });
  return {
    id,
    application_id: "app-123",
    token: `token-${id}`,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: {
      user: { id: "operator-1" },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

function makeFetchCollector() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      return new Response(null, { status: 204 });
    },
  };
}

const summary = {
  startedAt: new Date().toISOString(),
};

let runtime = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const replyPaths = buildProjectPaths({
    sharedBase,
    workspaceKey,
    projectKey: "project-alpha",
  });
  const approvalPaths = buildProjectPaths({
    sharedBase,
    workspaceKey,
    projectKey: "project-beta",
  });
  await ensureProjectDirs(replyPaths);
  await ensureProjectDirs(approvalPaths);

  await fs.writeFile(path.join(replyPaths.stateDir, "project_identity.md"), "workspace_key: remodex\nproject_key: project-alpha\n");
  await fs.writeFile(path.join(replyPaths.stateDir, "coordinator_status.md"), "type: idle\n");
  await fs.writeFile(path.join(replyPaths.stateDir, "background_trigger_toggle.md"), "background_trigger_enabled: true\nforeground_session_active: false\n");
  await fs.writeFile(path.join(replyPaths.stateDir, "operator_acl.md"), "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n");

  await fs.writeFile(path.join(approvalPaths.stateDir, "project_identity.md"), "workspace_key: remodex\nproject_key: project-beta\n");
  await fs.writeFile(path.join(approvalPaths.stateDir, "coordinator_status.md"), "type: waiting_on_approval\nactive_approval_source_ref: approval-live-001\n");
  await fs.writeFile(path.join(approvalPaths.stateDir, "background_trigger_toggle.md"), "background_trigger_enabled: true\nforeground_session_active: false\n");
  await fs.writeFile(path.join(approvalPaths.stateDir, "operator_acl.md"), "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n");

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl: null,
  });

  const fetchCollector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: fetchCollector.fetchImpl,
  });

  const replyOutcome = await processGatewayInteraction({
    interaction: interaction({
      id: "reply-interaction-001",
      commandName: "reply",
      project: "project-alpha",
      request: "pick option B",
      sourceRef: "question-001",
    }),
    runtime,
    callbackTransport,
  });

  const approvalOutcome = await processGatewayInteraction({
    interaction: interaction({
      id: "approval-interaction-001",
      commandName: "approve-candidate",
      project: "project-beta",
      sourceRef: "approval-live-001",
      roles: ["ops-admin"],
    }),
    runtime,
    callbackTransport,
  });

  const approvalDeniedOutcome = await processGatewayInteraction({
    interaction: interaction({
      id: "approval-interaction-002",
      commandName: "approve-candidate",
      project: "project-beta",
      sourceRef: "approval-live-001",
      roles: ["operator"],
    }),
    runtime,
    callbackTransport,
  });

  const replyInboxFiles = await fs.readdir(replyPaths.inboxDir);
  const replyDispatchFiles = await fs.readdir(replyPaths.dispatchQueueDir);
  const approvalHumanGateFiles = await fs.readdir(approvalPaths.humanGateDir);
  const approvalQuarantineFiles = await fs.readdir(approvalPaths.quarantineDir);

  summary.replyOutcome = {
    route: replyOutcome.result.route,
    delivery_decision: replyOutcome.result.delivery_decision,
    operator_message: replyOutcome.operator_message,
  };
  summary.replyInboxRecord = await readJsonIfExists(path.join(replyPaths.inboxDir, replyInboxFiles[0]));
  summary.replyDispatchCount = replyDispatchFiles.length;

  summary.approvalOutcome = {
    route: approvalOutcome.result.route,
    delivery_decision: approvalOutcome.result.delivery_decision,
    operator_message: approvalOutcome.operator_message,
  };
  summary.humanGateRecord = await readJsonIfExists(path.join(approvalPaths.humanGateDir, approvalHumanGateFiles[0]));
  summary.approvalDeniedOutcome = {
    route: approvalDeniedOutcome.result.route,
    delivery_decision: approvalDeniedOutcome.result.delivery_decision,
    operator_message: approvalDeniedOutcome.operator_message,
  };
  summary.quarantineRecord = await readJsonIfExists(path.join(approvalPaths.quarantineDir, approvalQuarantineFiles[0]));
  summary.callbackRequests = fetchCollector.requests;
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.replyInboxRecord?.type === "operator_reply" &&
    summary.replyInboxRecord?.source_ref === "question-001" &&
    summary.replyDispatchCount === 1 &&
    summary.approvalOutcome.route === "human_gate_candidate" &&
    summary.humanGateRecord?.approval_source_ref === "approval-live-001" &&
    summary.approvalDeniedOutcome.route === "quarantine" &&
    summary.quarantineRecord?.quarantine_reason === "missing_role:ops-admin" &&
    summary.callbackRequests.length === 6
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await runtime?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord gateway command mapping probe failed");
}
