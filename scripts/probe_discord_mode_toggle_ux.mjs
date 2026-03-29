import fs from "node:fs/promises";
import path from "node:path";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_mode_toggle_ux_probe");
const summaryPath = path.join(verificationDir, "discord_mode_toggle_ux_probe_summary.json");

function baseInteraction({ id, type, guildId = "guild-mode", channelId = "channel-mode" }) {
  return {
    id,
    application_id: "app-mode",
    token: `token-${id}`,
    type,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-mode" },
      roles: ["operator"],
    },
  };
}

function commandInteraction({ id, commandName, project = null }) {
  const options = [];
  if (project !== null) {
    options.push({ name: "project", value: project, type: 3 });
  }
  return {
    ...baseInteraction({ id, type: 2 }),
    data: {
      name: commandName,
      options,
    },
  };
}

function componentButtonInteraction({ id, customId }) {
  return {
    ...baseInteraction({ id, type: 3 }),
    data: {
      component_type: 2,
      custom_id: customId,
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

async function seedProject(paths) {
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    display_name: "Alpha",
    aliases: ["alpha"],
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
    threadId: "thread-alpha-mode",
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: true,
    foreground_lock_enabled: true,
    mode: "foreground",
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), "current_goal: 로그인 안정화\n");
  await writeAtomicText(path.join(paths.stateDir, "current_focus.md"), "current_focus: api contract\n");
  await writeAtomicText(path.join(paths.stateDir, "progress_axes.md"), "next_smallest_batch: integration-tests\n");
}

const summary = {
  startedAt: new Date().toISOString(),
};

let runtime = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const alphaPaths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-alpha",
  });
  await seedProject(alphaPaths);

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: null,
  });
  await runtime.writeChannelBinding({
    guildId: "guild-mode",
    channelId: "channel-mode",
    projectKey: "project-alpha",
    operatorId: "operator-mode",
  });

  const collector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: collector.fetchImpl,
  });

  const projectsOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "mode-projects-001",
      commandName: "projects",
    }),
    runtime,
    callbackTransport,
  });

  const statusOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "mode-status-001",
      commandName: "status",
    }),
    runtime,
    callbackTransport,
  });

  const backgroundOutcome = await processGatewayInteraction({
    interaction: componentButtonInteraction({
      id: "mode-background-001",
      customId: "projects:background:project-alpha",
    }),
    runtime,
    callbackTransport,
  });

  const backgroundToggle = await readJsonIfExists(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"));

  const foregroundOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "mode-foreground-001",
      commandName: "foreground-on",
    }),
    runtime,
    callbackTransport,
  });

  const foregroundToggle = await readJsonIfExists(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"));

  summary.projects_operator_message = projectsOutcome.operator_message;
  summary.status_operator_message = statusOutcome.operator_message;
  summary.background_operator_message = backgroundOutcome.operator_message;
  summary.foreground_operator_message = foregroundOutcome.operator_message;
  summary.background_toggle = backgroundToggle;
  summary.foreground_toggle = foregroundToggle;
  summary.callback_requests = collector.requests;
  summary.finishedAt = new Date().toISOString();

  const projectCard = collector.requests.find((request) =>
    request.method === "PATCH" &&
    request.body?.components?.some((row) =>
      row.components?.some((component) => component.custom_id === "projects:background:project-alpha"),
    ),
  ) ?? null;

  const backgroundUpdated =
    backgroundOutcome.result.route === "project_mode_updated" &&
    backgroundToggle?.background_trigger_enabled === true &&
    backgroundToggle?.foreground_session_active === false &&
    backgroundToggle?.foreground_lock_enabled === false &&
    backgroundToggle?.mode === "background" &&
    String(backgroundOutcome.operator_message ?? "").includes("scheduler: armed");

  const foregroundUpdated =
    foregroundOutcome.result.route === "project_mode_updated" &&
    foregroundToggle?.background_trigger_enabled === false &&
    foregroundToggle?.foreground_session_active === true &&
    foregroundToggle?.foreground_lock_enabled === true &&
    foregroundToggle?.mode === "foreground" &&
    String(foregroundOutcome.operator_message ?? "").includes("scheduler: blocked_expected");

  summary.project_card = projectCard;
  summary.status =
    projectCard &&
    backgroundUpdated &&
    foregroundUpdated
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
  throw new Error(summary.error ?? "discord mode toggle ux probe failed");
}
