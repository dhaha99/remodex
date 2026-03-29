import fs from "node:fs/promises";
import { buildDiscordCommandManifest } from "../scripts/lib/discord_command_manifest.mjs";

async function loadBotToken() {
  if (process.env.REMODEX_DISCORD_BOT_TOKEN) {
    return process.env.REMODEX_DISCORD_BOT_TOKEN;
  }
  if (process.env.REMODEX_DISCORD_BOT_TOKEN_PATH) {
    return (await fs.readFile(process.env.REMODEX_DISCORD_BOT_TOKEN_PATH, "utf8")).trim();
  }
  throw new Error("REMODEX_DISCORD_BOT_TOKEN or REMODEX_DISCORD_BOT_TOKEN_PATH is required");
}

function commandEndpoint({ apiBaseUrl, applicationId, guildId = null }) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  if (guildId) {
    return `${base}/applications/${applicationId}/guilds/${guildId}/commands`;
  }
  return `${base}/applications/${applicationId}/commands`;
}

async function main() {
  const apiBaseUrl = process.env.REMODEX_DISCORD_API_BASE_URL ?? "https://discord.com/api/v10";
  const applicationId = process.env.REMODEX_DISCORD_APPLICATION_ID ?? null;
  const guildId = process.env.REMODEX_DISCORD_GUILD_ID ?? null;
  if (!applicationId) {
    throw new Error("REMODEX_DISCORD_APPLICATION_ID is required");
  }

  const token = await loadBotToken();
  const manifest = buildDiscordCommandManifest();
  const endpoint = commandEndpoint({
    apiBaseUrl,
    applicationId,
    guildId,
  });

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(manifest),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`command registration failed with ${response.status}${body ? `: ${body}` : ""}`);
  }

  const payload = await response.json().catch(() => null);
  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint,
        scope: guildId ? "guild" : "global",
        command_count: manifest.length,
        response_count: Array.isArray(payload) ? payload.length : null,
      },
      null,
      2,
    ),
  );
}

await main();
