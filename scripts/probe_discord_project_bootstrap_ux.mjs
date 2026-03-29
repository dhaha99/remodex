import fs from "node:fs/promises";
import path from "node:path";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import { readJsonIfExists, readTextIfExists } from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_project_bootstrap_ux_probe");
const summaryPath = path.join(verificationDir, "discord_project_bootstrap_ux_probe_summary.json");

function commandInteraction({
  id,
  commandName,
  guildId = "guild-bootstrap",
  channelId = "channel-bootstrap",
  roles = ["operator"],
  name = null,
  key = null,
  goal = null,
}) {
  const options = [];
  if (name !== null) options.push({ name: "name", value: name, type: 3 });
  if (key !== null) options.push({ name: "key", value: key, type: 3 });
  if (goal !== null) options.push({ name: "goal", value: goal, type: 3 });
  return {
    id,
    application_id: "app-bootstrap",
    token: `token-${id}`,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-bootstrap" },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

function componentInteraction({
  id,
  customId,
  guildId = "guild-bootstrap",
  channelId = "channel-bootstrap",
  roles = ["operator"],
}) {
  return {
    id,
    application_id: "app-bootstrap",
    token: `token-${id}`,
    type: 3,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-bootstrap" },
      roles,
    },
    data: {
      component_type: 2,
      custom_id: customId,
    },
  };
}

function modalSubmitInteraction({
  id,
  customId,
  displayName,
  projectKey,
  goal,
  guildId = "guild-bootstrap",
  channelId = "channel-bootstrap",
  roles = ["operator"],
}) {
  return {
    id,
    application_id: "app-bootstrap",
    token: `token-${id}`,
    type: 5,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-bootstrap" },
      roles,
    },
    data: {
      custom_id: customId,
      components: [
        { type: 18, component: { type: 4, custom_id: "display_name", value: displayName } },
        { type: 18, component: { type: 4, custom_id: "project_key", value: projectKey } },
        { type: 18, component: { type: 4, custom_id: "goal", value: goal } },
      ],
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

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: null,
  });
  const fetchCollector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: fetchCollector.fetchImpl,
  });

  const projectsOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "bootstrap-projects-001",
      commandName: "projects",
    }),
    runtime,
    callbackTransport,
  });
  summary.projects_none = {
    route: projectsOutcome.result.route,
    operator_message: projectsOutcome.operator_message,
    patch_body: fetchCollector.requests.at(-1)?.body ?? null,
  };

  const createSlashOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "bootstrap-create-001",
      commandName: "create-project",
      name: "Login Stability",
      goal: "로그인 흐름 안정화",
    }),
    runtime,
    callbackTransport,
  });
  summary.create_slash = {
    route: createSlashOutcome.result.route,
    project_key: createSlashOutcome.result.project_key,
    operator_message: createSlashOutcome.operator_message,
  };

  const createdProjectKey = createSlashOutcome.result.project_key;
  const identityPath = path.join(
    sharedBase,
    "remodex",
    "projects",
    createdProjectKey,
    "state",
    "project_identity.json",
  );
  const goalPath = path.join(
    sharedBase,
    "remodex",
    "projects",
    createdProjectKey,
    "state",
    "current_goal.md",
  );
  const bindingPath = path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json");
  summary.created_identity = await readJsonIfExists(identityPath);
  summary.created_goal = await readTextIfExists(goalPath);
  summary.channel_bindings = await readJsonIfExists(bindingPath);

  const createButtonOutcome = await processGatewayInteraction({
    interaction: componentInteraction({
      id: "bootstrap-create-button-001",
      customId: "projects:create",
    }),
    runtime,
    callbackTransport,
  });
  summary.create_button = {
    route: createButtonOutcome.result.route,
    modal: fetchCollector.requests.at(-1)?.body ?? null,
  };

  const createModalOutcome = await processGatewayInteraction({
    interaction: modalSubmitInteraction({
      id: "bootstrap-create-modal-submit-001",
      customId: "projects:create_modal",
      displayName: "UI Polish",
      projectKey: "ui-polish",
      goal: "설정 화면 정리",
    }),
    runtime,
    callbackTransport,
  });
  summary.create_modal_submit = {
    route: createModalOutcome.result.route,
    project_key: createModalOutcome.result.project_key,
    operator_message: createModalOutcome.operator_message,
  };

  const catalog = await runtime.listProjectCatalog();
  summary.catalog = catalog;
  summary.callback_request_count = fetchCollector.requests.length;
  summary.finishedAt = new Date().toISOString();
  summary.status = "PASS";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = {
    message: error.message,
    stack: error.stack,
  };
} finally {
  if (runtime) {
    await runtime.close();
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "PASS") {
    process.exitCode = 1;
  }
}
