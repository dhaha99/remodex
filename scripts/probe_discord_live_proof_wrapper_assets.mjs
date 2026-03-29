import fs from "node:fs/promises";
import path from "node:path";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_live_proof_wrapper_assets_probe_summary.json",
);

await fs.mkdir(verificationDir, { recursive: true });

async function readText(filePath) {
  return await fs.readFile(filePath, "utf8");
}

const shWrapper = await readText(path.join(workspace, "ops", "run_discord_gateway_live_proof.sh"));
const psWrapper = await readText(path.join(workspace, "ops", "run_discord_gateway_live_proof.ps1"));
const runbook = await readText(path.join(workspace, "DISCORD_LIVE_PROOF_RUNBOOK.md"));
const bootstrap = await readText(path.join(workspace, "PRODUCTION_BOOTSTRAP.md"));

const summary = {
  ok: true,
  shell_wrapper_mentions: {
    proof_dir: shWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_DIR"),
    expect_interaction: shWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION"),
    timeout: shWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS"),
  },
  powershell_wrapper_mentions: {
    proof_dir: psWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_DIR"),
    expect_interaction: psWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION"),
    timeout: psWrapper.includes("REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS"),
  },
  runbook_mentions: {
    preflight: runbook.includes("check_discord_gateway_live_preflight.mjs"),
    proof_runner: runbook.includes("run_discord_gateway_live_proof"),
    proof_bundle: runbook.includes("live-proof-bundle.json"),
    expect_interaction: runbook.includes("EXPECT_INTERACTION=true"),
  },
  bootstrap_mentions: {
    live_proof_runner: bootstrap.includes("run_discord_gateway_live_proof"),
  },
};

summary.ok =
  Object.values(summary.shell_wrapper_mentions).every(Boolean) &&
  Object.values(summary.powershell_wrapper_mentions).every(Boolean) &&
  Object.values(summary.runbook_mentions).every(Boolean) &&
  Object.values(summary.bootstrap_mentions).every(Boolean);

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
