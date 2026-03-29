import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildDiscordCommandManifest } from "../scripts/lib/discord_command_manifest.mjs";

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function validateUrl(value, expectedProtocols) {
  try {
    const url = new URL(value);
    if (!expectedProtocols.includes(url.protocol)) {
      return { ok: false, reason: `unexpected_protocol:${url.protocol}` };
    }
    return { ok: true, href: url.href };
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
}

async function loadBotToken(env) {
  if (env.REMODEX_DISCORD_BOT_TOKEN?.trim()) {
    return { token: env.REMODEX_DISCORD_BOT_TOKEN.trim(), source: "env" };
  }
  if (env.REMODEX_DISCORD_BOT_TOKEN_PATH?.trim()) {
    const token = (await fs.readFile(env.REMODEX_DISCORD_BOT_TOKEN_PATH, "utf8")).trim();
    return { token, source: "path" };
  }
  throw new Error("missing_bot_token");
}

function looksLikeSnowflake(value) {
  return /^\d{17,20}$/.test(String(value ?? ""));
}

export async function runDiscordGatewayLivePreflight({
  env = process.env,
  networkChecks = parseBoolean(process.env.REMODEX_DISCORD_PREFLIGHT_NETWORK, false),
} = {}) {
  const blockers = [];
  const warnings = [];
  const details = {};

  const gatewayUrl = env.REMODEX_DISCORD_GATEWAY_URL ?? "wss://gateway.discord.gg/?v=10&encoding=json";
  const apiBaseUrl = env.REMODEX_DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
  const appServerWsUrl = env.CODEX_APP_SERVER_WS_URL ?? env.REMODEX_APP_SERVER_WS_URL ?? null;
  const operatorHost = env.REMODEX_OPERATOR_HTTP_HOST ?? "127.0.0.1";
  const dashboardHost = env.REMODEX_DASHBOARD_HTTP_HOST ?? "127.0.0.1";
  const applicationId = env.REMODEX_DISCORD_APPLICATION_ID ?? null;
  const guildId = env.REMODEX_DISCORD_GUILD_ID ?? null;

  const gatewayCheck = validateUrl(gatewayUrl, ["wss:"]);
  const apiCheck = validateUrl(apiBaseUrl, ["https:"]);
  const appServerCheck = appServerWsUrl ? validateUrl(appServerWsUrl, ["ws:", "wss:"]) : null;

  details.gateway_url = gatewayCheck.ok ? gatewayCheck.href : gatewayUrl;
  details.api_base_url = apiCheck.ok ? apiCheck.href : apiBaseUrl;
  details.app_server_ws_url = appServerWsUrl;
  details.operator_host = operatorHost;
  details.dashboard_host = dashboardHost;
  details.application_id = applicationId;
  details.guild_id = guildId;
  details.network_checks = Boolean(networkChecks);
  details.command_names = buildDiscordCommandManifest().map((command) => command.name);

  if (!gatewayCheck.ok) blockers.push(`gateway_url:${gatewayCheck.reason}`);
  if (!apiCheck.ok) blockers.push(`api_base_url:${apiCheck.reason}`);
  if (!appServerWsUrl) blockers.push("missing_app_server_ws_url");
  if (appServerWsUrl && !appServerCheck?.ok) blockers.push(`app_server_ws_url:${appServerCheck.reason}`);
  if (!isLoopbackHost(operatorHost)) blockers.push("raw_bridge_host_not_loopback");
  if (!isLoopbackHost(dashboardHost)) blockers.push("dashboard_host_not_loopback");

  if (!applicationId) {
    blockers.push("missing_application_id");
  } else if (!looksLikeSnowflake(applicationId)) {
    blockers.push("application_id_not_snowflake");
  }

  if (!guildId) {
    warnings.push("missing_guild_id_live_sync_will_be_global_and_slow");
  } else if (!looksLikeSnowflake(guildId)) {
    blockers.push("guild_id_not_snowflake");
  }

  try {
    const { token, source } = await loadBotToken(env);
    if (!token) {
      blockers.push("empty_bot_token");
    } else {
      details.bot_token_source = source;
      details.bot_token_length = token.length;
    }
  } catch (error) {
    blockers.push(error.message === "missing_bot_token" ? "missing_bot_token" : "bot_token_unreadable");
  }

  if (networkChecks && blockers.length === 0) {
    try {
      const token =
        env.REMODEX_DISCORD_BOT_TOKEN?.trim() ??
        (env.REMODEX_DISCORD_BOT_TOKEN_PATH
          ? (await fs.readFile(env.REMODEX_DISCORD_BOT_TOKEN_PATH, "utf8")).trim()
          : null);
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/gateway/bot`, {
        headers: {
          authorization: `Bot ${token}`,
        },
      });
      details.gateway_bot_status = response.status;
      if (!response.ok) {
        blockers.push(`gateway_bot_http_${response.status}`);
      }
    } catch (error) {
      blockers.push(`gateway_bot_network:${error.code ?? error.name ?? "failed"}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    details,
    next_step:
      blockers.length === 0
        ? "ready_for_live_ingress_proof"
        : "fix_blockers_before_live_ingress_proof",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runDiscordGatewayLivePreflight();
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
