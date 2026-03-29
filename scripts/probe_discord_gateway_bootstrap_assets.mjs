import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_bootstrap_assets_probe_summary.json",
);

await fs.mkdir(verificationDir, { recursive: true });

function runNode(scriptPath, env) {
  return new Promise((resolve) => {
    const child = spawn("node", [scriptPath], {
      cwd: workspace,
      env,
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
    child.once("exit", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-gateway-bootstrap-"));
  const workspaceClone = path.join(tempRoot, "workspace");
  await fs.cp(workspace, workspaceClone, {
    recursive: true,
    filter(source) {
      return !source.includes(`${path.sep}.git${path.sep}`);
    },
  });

  const envBase = {
    ...process.env,
    REMODEX_WORKSPACE: workspaceClone,
    REMODEX_SCHEDULER_KIND: "launchd_launchagent",
    REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER: "true",
  };

  const launchdResult = await runNode("ops/render_scheduler_artifacts.mjs", envBase);
  const launchdJson = JSON.parse(launchdResult.stdout);
  const launchdGatewayArtifact = launchdJson.artifacts?.discord_gateway_adapter ?? null;

  const windowsResult = await runNode("ops/render_scheduler_artifacts.mjs", {
    ...envBase,
    REMODEX_SCHEDULER_KIND: "windows_task_scheduler",
  });
  const windowsJson = JSON.parse(windowsResult.stdout);
  const windowsGatewayArtifact = windowsJson.artifacts?.discord_gateway_adapter ?? null;

  const installLaunchdText = await fs.readFile(
    path.join(workspace, "ops", "install_launchd_services.sh"),
    "utf8",
  );
  const uninstallLaunchdText = await fs.readFile(
    path.join(workspace, "ops", "uninstall_launchd_services.sh"),
    "utf8",
  );
  const installWindowsText = await fs.readFile(
    path.join(workspace, "ops", "install_windows_scheduled_tasks.ps1"),
    "utf8",
  );
  const uninstallWindowsText = await fs.readFile(
    path.join(workspace, "ops", "uninstall_windows_scheduled_tasks.ps1"),
    "utf8",
  );
  const envExampleText = await fs.readFile(
    path.join(workspace, "ops", "remodex.env.example"),
    "utf8",
  );
  const bootstrapText = await fs.readFile(
    path.join(workspace, "PRODUCTION_BOOTSTRAP.md"),
    "utf8",
  );
  const windowsBootstrapText = await fs.readFile(
    path.join(workspace, "WINDOWS_BOOTSTRAP.md"),
    "utf8",
  );

  const summary = {
    ok:
      launchdResult.code === 0 &&
      windowsResult.code === 0 &&
      Boolean(launchdGatewayArtifact) &&
      Boolean(windowsGatewayArtifact) &&
      installLaunchdText.includes("discord-gateway-adapter") &&
      uninstallLaunchdText.includes("discord-gateway-adapter") &&
      installWindowsText.includes("DiscordGatewayAdapter") &&
      uninstallWindowsText.includes("DiscordGatewayAdapter") &&
      envExampleText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER") &&
      bootstrapText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER") &&
      windowsBootstrapText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER"),
    launchd: {
      exit_code: launchdResult.code,
      gateway_artifact: launchdGatewayArtifact,
      features: launchdJson.features ?? null,
    },
    windows: {
      exit_code: windowsResult.code,
      gateway_artifact: windowsGatewayArtifact,
      features: windowsJson.features ?? null,
      task_name: windowsJson.task_names?.discord_gateway_adapter ?? null,
    },
    checks: {
      install_launchd_mentions_gateway: installLaunchdText.includes("discord-gateway-adapter"),
      uninstall_launchd_mentions_gateway: uninstallLaunchdText.includes("discord-gateway-adapter"),
      install_windows_mentions_gateway: installWindowsText.includes("DiscordGatewayAdapter"),
      uninstall_windows_mentions_gateway: uninstallWindowsText.includes("DiscordGatewayAdapter"),
      env_mentions_toggle: envExampleText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER"),
      production_bootstrap_mentions_toggle: bootstrapText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER"),
      windows_bootstrap_mentions_toggle: windowsBootstrapText.includes("REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER"),
    },
  };

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
