import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_live_proof_assets_probe_summary.json",
);

await fs.mkdir(verificationDir, { recursive: true });

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-live-proof-"));
const sharedBase = path.join(tempDir, "shared");
const proofDir = path.join(tempDir, "proof");
const tokenPath = path.join(tempDir, "discord-bot-token.txt");
const fakeAdapterPath = path.join(tempDir, "fake-gateway-adapter.mjs");
const fakeRegistrarPath = path.join(tempDir, "fake-register-commands.mjs");

await fs.mkdir(path.join(sharedBase, "remodex", "router"), { recursive: true });
await fs.writeFile(tokenPath, "discord-bot-token-placeholder\n");
await fs.writeFile(
  fakeRegistrarPath,
  `
    console.log(JSON.stringify({ ok: true, scope: "guild", command_count: 4 }));
  `.trim(),
);
await fs.writeFile(
  fakeAdapterPath,
  `
    import fs from "node:fs/promises";
    import path from "node:path";
    const sharedBase = process.env.REMODEX_SHARED_BASE;
    const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
    const routerRoot = path.join(sharedBase, workspaceKey, "router");
    await fs.mkdir(routerRoot, { recursive: true });
    await fs.writeFile(path.join(routerRoot, "discord_gateway_adapter_state.json"), JSON.stringify({
      observed_at: new Date().toISOString(),
      last_event_type: "ready",
      snapshot: { ready_seen: true, session_id: "fake-session-1", seq: 3 }
    }, null, 2));
    await fs.appendFile(path.join(routerRoot, "discord_gateway_events.jsonl"), JSON.stringify({
      type: "interaction_create",
      interaction_id: "fake-interaction-1"
    }) + "\\n");
    setTimeout(() => process.exit(0), 200);
  `.trim(),
);

const child = spawn("node", ["ops/run_discord_gateway_live_proof.mjs"], {
  cwd: workspace,
  env: {
    ...process.env,
    REMODEX_WORKSPACE: workspace,
    REMODEX_SHARED_BASE: sharedBase,
    REMODEX_WORKSPACE_KEY: "remodex",
    CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1:4517",
    REMODEX_OPERATOR_HTTP_HOST: "127.0.0.1",
    REMODEX_DASHBOARD_HTTP_HOST: "127.0.0.1",
    REMODEX_DISCORD_GATEWAY_URL: "wss://gateway.discord.gg/?v=10&encoding=json",
    REMODEX_DISCORD_API_BASE_URL: "https://discord.com/api/v10",
    REMODEX_DISCORD_APPLICATION_ID: "123456789012345678",
    REMODEX_DISCORD_GUILD_ID: "234567890123456789",
    REMODEX_DISCORD_BOT_TOKEN_PATH: tokenPath,
    REMODEX_DISCORD_LIVE_PROOF_DIR: proofDir,
    REMODEX_DISCORD_GATEWAY_ADAPTER_ENTRY: fakeAdapterPath,
    REMODEX_DISCORD_COMMAND_REGISTRAR_ENTRY: fakeRegistrarPath,
    REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION: "true",
    REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS: "5000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const exit = await new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

const bundlePath = path.join(proofDir, "live-proof-bundle.json");
const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));

const summary = {
  ok: exit.code === 0 && bundle.ok === true,
  exit,
  proof_dir: proofDir,
  bundle_path: bundlePath,
  bundle,
  stdout: stdout.trim() || null,
  stderr: stderr.trim() || null,
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
