import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runDiscordGatewayLivePreflight } from "../ops/check_discord_gateway_live_preflight.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_live_preflight_probe_summary.json",
);

await fs.mkdir(verificationDir, { recursive: true });

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-discord-preflight-"));
const tokenPath = path.join(tempDir, "discord-bot-token.txt");
await fs.writeFile(tokenPath, "discord-bot-token-placeholder\n");

const result = await runDiscordGatewayLivePreflight({
  env: {
    REMODEX_DISCORD_GATEWAY_URL: "wss://gateway.discord.gg/?v=10&encoding=json",
    REMODEX_DISCORD_API_BASE_URL: "https://discord.com/api/v10",
    CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1:4517",
    REMODEX_OPERATOR_HTTP_HOST: "127.0.0.1",
    REMODEX_DASHBOARD_HTTP_HOST: "127.0.0.1",
    REMODEX_DISCORD_APPLICATION_ID: "123456789012345678",
    REMODEX_DISCORD_GUILD_ID: "234567890123456789",
    REMODEX_DISCORD_BOT_TOKEN_PATH: tokenPath,
  },
  networkChecks: false,
});

const summary = {
  ok: result.ok,
  blockers: result.blockers,
  warnings: result.warnings,
  details: result.details,
  next_step: result.next_step,
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
