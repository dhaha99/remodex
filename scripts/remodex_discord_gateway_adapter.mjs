import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordGatewaySession } from "./lib/discord_gateway_session.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import { writeAtomicJson } from "./lib/shared_memory_runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase =
  process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? process.env.REMODEX_APP_SERVER_WS_URL ?? null;
const gatewayUrl =
  process.env.REMODEX_DISCORD_GATEWAY_URL ?? "wss://gateway.discord.gg/?v=10&encoding=json";
const intents = Number.parseInt(process.env.REMODEX_DISCORD_GATEWAY_INTENTS ?? "0", 10);
const apiBaseUrl = process.env.REMODEX_DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
const reconnectDelayMs = Number.parseInt(
  process.env.REMODEX_DISCORD_GATEWAY_RECONNECT_DELAY_MS ?? "2500",
  10,
);
const eventsLogPath =
  process.env.REMODEX_DISCORD_GATEWAY_EVENTS_LOG_PATH ??
  path.join(sharedBase, workspaceKey, "router", "discord_gateway_events.jsonl");
const statePath = path.join(sharedBase, workspaceKey, "router", "discord_gateway_adapter_state.json");

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
  const token = await loadBotToken();
  const runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath: eventsLogPath,
  });
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl,
  });

  const session = new DiscordGatewaySession({
    gatewayUrl,
    token,
    intents,
    reconnectDelayMs,
    onInteractionCreate: async (interaction, payload) => {
      const result = await processGatewayInteraction({
        interaction,
        runtime,
        callbackTransport,
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
    onStateChange: async (event) => {
      await writeAtomicJson(statePath, {
        observed_at: new Date().toISOString(),
        gateway_url: gatewayUrl,
        api_base_url: apiBaseUrl,
        workspace_key: workspaceKey,
        ws_url: wsUrl,
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
        intents,
      },
      null,
      2,
    ),
  );

  const shutdown = async () => {
    await session.stop();
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();
