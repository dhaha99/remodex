import fs from "node:fs/promises";
import path from "node:path";
import { DiscordConversationService } from "./lib/discord_conversation_service.mjs";
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

class FakeChannelTransport {
  constructor() {
    this.messages = [];
  }

  async createChannelMessage(payload) {
    this.messages.push(payload);
    return { id: `fake-${this.messages.length}` };
  }
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

  const channelTransport = new FakeChannelTransport();
  const fakeBridgeThreadService = {
    called: false,
    async handleBoundMessage({ payload, binding }) {
      this.called = true;
      const wantsBackground = /백그라운드|스케쥴러|스케줄러|background/i.test(String(payload?.content ?? ""));
      const modeTarget = wantsBackground ? "background" : "foreground";
      const outcome = await runtime.handleNormalizedCommand({
        source: "discord",
        verified_identity: "bridge_thread",
        operator_id: payload.author?.id ?? payload.member?.user?.id ?? null,
        operator_roles: ["operator"],
        command_name: `bridge-thread-set-mode-${modeTarget}`,
        command_class: "set-mode",
        auth_class: "intent",
        workspace_key: "remodex",
        project_key: binding?.project_key ?? null,
        display_name: null,
        goal: null,
        mode_target: modeTarget,
        thread_id: null,
        source_ref: payload.id,
        request: null,
        artifact: null,
        correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}:bridge`,
        received_at: payload.timestamp ?? new Date().toISOString(),
        raw_interaction_id: null,
        raw_message_id: payload.id,
        raw_guild_id: payload.guild_id ?? null,
        raw_channel_id: payload.channel_id ?? null,
      });
      return {
        operator_response:
          modeTarget === "background"
            ? "좋습니다. 이 채널 기준 프로젝트를 백그라운드 모드로 전환했습니다."
            : "좋습니다. 이 채널 기준 프로젝트를 foreground 모드로 되돌렸습니다.",
        bridge_thread_id: "bridge-mode-thread",
        bridge_turn_id: `bridge-turn-${modeTarget}`,
        bridge_action: modeTarget === "background" ? "set_mode_background" : "set_mode_foreground",
        project_key: binding?.project_key ?? null,
        handoff_result: outcome.result ?? null,
        route: outcome.result?.route ?? "bridge_reply",
      };
    },
  };
  const conversationService = new DiscordConversationService({
    runtime,
    channelTransport,
    bridgeThreadService: fakeBridgeThreadService,
    sharedBase,
    workspaceKey: "remodex",
    outboxPollIntervalMs: 60_000,
  });

  const textBackgroundOutcome = await conversationService.handleMessageCreate({
    id: "mode-text-background-001",
    guild_id: "guild-mode",
    channel_id: "channel-mode",
    timestamp: new Date().toISOString(),
    type: 0,
    content: "백그라운드 스케쥴러 활성화해봐",
    author: { id: "operator-mode", username: "operator", bot: false },
    member: { user: { id: "operator-mode" }, roles: [] },
    mentions: [],
  });

  const textBackgroundToggle = await readJsonIfExists(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"));

  const textForegroundOutcome = await conversationService.handleMessageCreate({
    id: "mode-text-foreground-001",
    guild_id: "guild-mode",
    channel_id: "channel-mode",
    timestamp: new Date().toISOString(),
    type: 0,
    content: "앱 복귀해",
    author: { id: "operator-mode", username: "operator", bot: false },
    member: { user: { id: "operator-mode" }, roles: [] },
    mentions: [],
  });

  const textForegroundToggle = await readJsonIfExists(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"));

  summary.projects_operator_message = projectsOutcome.operator_message;
  summary.status_operator_message = statusOutcome.operator_message;
  summary.background_operator_message = backgroundOutcome.operator_message;
  summary.foreground_operator_message = foregroundOutcome.operator_message;
  summary.background_toggle = backgroundToggle;
  summary.foreground_toggle = foregroundToggle;
  summary.text_background_outcome = textBackgroundOutcome;
  summary.text_foreground_outcome = textForegroundOutcome;
  summary.text_background_toggle = textBackgroundToggle;
  summary.text_foreground_toggle = textForegroundToggle;
  summary.text_messages = channelTransport.messages;
  summary.bridge_thread_called_for_text_mode_toggle = fakeBridgeThreadService.called;
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

  const textBackgroundUpdated =
    textBackgroundOutcome?.ignored === false &&
    textBackgroundOutcome?.result?.route === "project_mode_updated" &&
    textBackgroundToggle?.background_trigger_enabled === true &&
    textBackgroundToggle?.foreground_session_active === false &&
    String(textBackgroundOutcome?.response_text ?? "").includes("백그라운드");

  const textForegroundUpdated =
    textForegroundOutcome?.ignored === false &&
    textForegroundOutcome?.result?.route === "project_mode_updated" &&
    textForegroundToggle?.background_trigger_enabled === false &&
    textForegroundToggle?.foreground_session_active === true &&
    /foreground|앱|복귀/.test(String(textForegroundOutcome?.response_text ?? ""));

  summary.project_card = projectCard;
  summary.status =
    projectCard &&
    backgroundUpdated &&
    foregroundUpdated &&
    textBackgroundUpdated &&
    textForegroundUpdated &&
    fakeBridgeThreadService.called === true
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
