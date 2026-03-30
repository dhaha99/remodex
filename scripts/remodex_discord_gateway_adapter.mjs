import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordGatewaySession } from "./lib/discord_gateway_session.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { DiscordBotChannelTransport } from "./lib/discord_bot_channel_transport.mjs";
import { DiscordConversationService } from "./lib/discord_conversation_service.mjs";
import { DiscordBridgeThreadService } from "./lib/discord_bridge_thread_service.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import { acquireProcessSingletonLock } from "./lib/process_singleton_lock.mjs";
import { writeAtomicJson } from "./lib/shared_memory_runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase =
  process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const wsUrl =
  process.env.CODEX_APP_SERVER_WS_URL ??
  process.env.REMODEX_APP_SERVER_WS_URL ??
  "ws://127.0.0.1:4517";
const gatewayUrl =
  process.env.REMODEX_DISCORD_GATEWAY_URL ?? "wss://gateway.discord.gg/?v=10&encoding=json";
const intents = Number.parseInt(process.env.REMODEX_DISCORD_GATEWAY_INTENTS ?? "0", 10);
const apiBaseUrl = process.env.REMODEX_DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
const reconnectDelayMs = Number.parseInt(
  process.env.REMODEX_DISCORD_GATEWAY_RECONNECT_DELAY_MS ?? "2500",
  10,
);
const outboxPollIntervalMs = Number.parseInt(
  process.env.REMODEX_DISCORD_OUTBOX_POLL_INTERVAL_MS ?? "2000",
  10,
);
const eventsLogPath =
  process.env.REMODEX_DISCORD_GATEWAY_EVENTS_LOG_PATH ??
  path.join(sharedBase, workspaceKey, "router", "discord_gateway_events.jsonl");
const appServerLogPath =
  process.env.REMODEX_DISCORD_GATEWAY_APP_SERVER_LOG_PATH ??
  path.join(sharedBase, workspaceKey, "router", "discord_gateway_app_server.jsonl");
const statePath = path.join(sharedBase, workspaceKey, "router", "discord_gateway_adapter_state.json");
const lockPath = path.join(sharedBase, workspaceKey, "router", "discord_gateway_adapter.lock.json");
const MESSAGE_CONTENT_INTENT = 1 << 15;

function appendLine(filePath, line) {
  return fs.appendFile(filePath, `${line}\n`);
}

async function loadBotToken() {
  if (process.env.REMODEX_DISCORD_BOT_TOKEN) {
    return process.env.REMODEX_DISCORD_BOT_TOKEN;
  }
  if (process.env.REMODEX_DISCORD_BOT_TOKEN_PATH) {
    return (await fs.readFile(process.env.REMODEX_DISCORD_BOT_TOKEN_PATH, "utf8")).trim();
  }
  throw new Error("Discord bot token is not configured");
}

async function main() {
  await fs.mkdir(path.dirname(eventsLogPath), { recursive: true });
  const lock = await acquireProcessSingletonLock(lockPath, {
    ownerLabel: "discord-gateway-adapter",
  });
  if (!lock.acquired) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: "already_running",
          existing_pid: lock.existingPid ?? null,
          existing_label: lock.existingLabel ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  const token = await loadBotToken();
  let activeIntents = intents;
  let conversationMode = (activeIntents & MESSAGE_CONTENT_INTENT) !== 0 ? "full" : "mention_only";
  let conversationBlocker =
    conversationMode === "full" ? null : "message_content_intent_disabled_or_unconfigured";
  let messageContentFallbackApplied = false;
  const runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath: eventsLogPath,
    appServerLogPath,
  });
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl,
  });
  const channelTransport = new DiscordBotChannelTransport({
    apiBaseUrl,
    token,
  });
  const bridgeThreadService = new DiscordBridgeThreadService({
    runtime,
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath: appServerLogPath,
    workspaceCwd: workspace,
  });
  const conversationService = new DiscordConversationService({
    runtime,
    channelTransport,
    bridgeThreadService,
    sharedBase,
    workspaceKey,
    outboxPollIntervalMs,
    messageContentMode: conversationMode,
    onEvent: async (event) => {
      await appendLine(
        eventsLogPath,
        JSON.stringify({
          observed_at: new Date().toISOString(),
          ...event,
        }),
      );
    },
  });
  let botUser = null;

  const session = new DiscordGatewaySession({
    gatewayUrl,
    token,
    intents: activeIntents,
    reconnectDelayMs,
    onInteractionCreate: async (interaction, payload) => {
      const result = await processGatewayInteraction({
        interaction,
        runtime,
        callbackTransport,
        conversationState: {
          mode: conversationMode,
          blocker: conversationBlocker,
          botUsername: botUser?.username ?? null,
        },
      });
      await appendLine(
        eventsLogPath,
        JSON.stringify({
          observed_at: new Date().toISOString(),
          type: result.interaction_kind === "autocomplete" ? "interaction_autocomplete" : "interaction_create",
          interaction_id: interaction.id,
          event_seq: payload.s ?? null,
          command_class: result.normalized.command_class,
          project_key: result.normalized.project_key,
          response_plan: result.response_plan,
          delivery_decision: result.result.delivery_decision,
          operator_message: result.operator_message,
          choices_count: result.result.choices?.length ?? null,
        }),
      );
    },
    onReady: async (readyData) => {
      botUser = readyData?.user ?? null;
      conversationService.setBotIdentity(botUser);
      await conversationService.start();
      await appendLine(
        eventsLogPath,
        JSON.stringify({
          observed_at: new Date().toISOString(),
          type: "gateway_ready",
          bot_user_id: botUser?.id ?? null,
          bot_username: botUser?.username ?? null,
        }),
      );
    },
    onDispatch: async (eventType, eventData, payload) => {
      if (eventType !== "MESSAGE_CREATE") return;
      try {
        const result = await conversationService.handleDispatch(eventType, eventData);
        await appendLine(
          eventsLogPath,
          JSON.stringify({
            observed_at: new Date().toISOString(),
            type: "message_create",
            event_seq: payload?.s ?? null,
            message_id: eventData?.id ?? null,
            channel_id: eventData?.channel_id ?? null,
            guild_id: eventData?.guild_id ?? null,
            ignored: result?.ignored ?? false,
            reason: result?.reason ?? null,
            command_class: result?.normalized?.command_class ?? null,
            route: result?.result?.route ?? null,
            project_key: result?.result?.project_key ?? result?.normalized?.project_key ?? null,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[discord-gateway-adapter] MESSAGE_CREATE dispatch failed: ${message}`);
        await appendLine(
          eventsLogPath,
          JSON.stringify({
            observed_at: new Date().toISOString(),
            type: "message_dispatch_error",
            event_seq: payload?.s ?? null,
            message_id: eventData?.id ?? null,
            channel_id: eventData?.channel_id ?? null,
            guild_id: eventData?.guild_id ?? null,
            error: message,
          }),
        );
      }
    },
    onStateChange: async (event) => {
      if (
        event.type === "socket_close" &&
        event.close?.code === 4014 &&
        (activeIntents & MESSAGE_CONTENT_INTENT) !== 0 &&
        !messageContentFallbackApplied
      ) {
        messageContentFallbackApplied = true;
        activeIntents &= ~MESSAGE_CONTENT_INTENT;
        session.intents = activeIntents;
        conversationMode = "mention_only";
        conversationBlocker = "message_content_intent_disabled_or_unconfigured";
        conversationService.setMessageContentMode(conversationMode);
        await appendLine(
          eventsLogPath,
          JSON.stringify({
            observed_at: new Date().toISOString(),
            type: "gateway_intents_fallback",
            reason: conversationBlocker,
            active_intents: activeIntents,
          }),
        );
      } else if ((activeIntents & MESSAGE_CONTENT_INTENT) !== 0) {
        conversationMode = "full";
        conversationBlocker = null;
        conversationService.setMessageContentMode(conversationMode);
      }
      await writeAtomicJson(statePath, {
        observed_at: new Date().toISOString(),
        gateway_url: gatewayUrl,
        api_base_url: apiBaseUrl,
        workspace_key: workspaceKey,
        ws_url: wsUrl,
        active_intents: activeIntents,
        conversation_mode: conversationMode,
        conversation_blocker: conversationBlocker,
        app_server_log_path: appServerLogPath,
        bot_user_id: botUser?.id ?? null,
        bot_username: botUser?.username ?? null,
        last_event_type: event.type,
        event_type: event.event_type ?? null,
        seq: event.seq ?? null,
        snapshot: event.snapshot,
      });
    },
  });

  await session.start();

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace_key: workspaceKey,
        shared_base: sharedBase,
        gateway_url: gatewayUrl,
        api_base_url: apiBaseUrl,
        intents: activeIntents,
        conversation_mode: conversationMode,
      },
      null,
      2,
    ),
  );

  const shutdown = async () => {
    await session.stop();
    await conversationService.stop();
    await runtime.close();
    await lock.release();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
