import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "dashboard_bootstrap_assets_probe_summary.json",
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-dashboard-bootstrap-"));
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
    REMODEX_ENABLE_DASHBOARD_SERVER: "true",
  };

  const launchdResult = await runNode("ops/render_scheduler_artifacts.mjs", {
    ...envBase,
    REMODEX_SCHEDULER_KIND: "launchd_launchagent",
  });
  const launchdJson = JSON.parse(launchdResult.stdout);
  const launchdDashboardArtifact = launchdJson.artifacts?.dashboard_server ?? null;

  const windowsResult = await runNode("ops/render_scheduler_artifacts.mjs", {
    ...envBase,
    REMODEX_SCHEDULER_KIND: "windows_task_scheduler",
  });
  const windowsJson = JSON.parse(windowsResult.stdout);
  const windowsDashboardArtifact = windowsJson.artifacts?.dashboard_server ?? null;

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
      Boolean(launchdDashboardArtifact) &&
      Boolean(windowsDashboardArtifact) &&
      installLaunchdText.includes("dashboard-server") &&
      uninstallLaunchdText.includes("dashboard-server") &&
      installWindowsText.includes("DashboardServer") &&
      uninstallWindowsText.includes("DashboardServer") &&
      envExampleText.includes("REMODEX_ENABLE_DASHBOARD_SERVER") &&
      bootstrapText.includes("REMODEX_ENABLE_DASHBOARD_SERVER") &&
      windowsBootstrapText.includes("REMODEX_ENABLE_DASHBOARD_SERVER"),
    launchd: {
      exit_code: launchdResult.code,
      dashboard_artifact: launchdDashboardArtifact,
      features: launchdJson.features ?? null,
    },
    windows: {
      exit_code: windowsResult.code,
      dashboard_artifact: windowsDashboardArtifact,
      features: windowsJson.features ?? null,
      task_name: windowsJson.task_names?.dashboard_server ?? null,
    },
    checks: {
      install_launchd_mentions_dashboard: installLaunchdText.includes("dashboard-server"),
      uninstall_launchd_mentions_dashboard: uninstallLaunchdText.includes("dashboard-server"),
      install_windows_mentions_dashboard: installWindowsText.includes("DashboardServer"),
      uninstall_windows_mentions_dashboard: uninstallWindowsText.includes("DashboardServer"),
      env_mentions_toggle: envExampleText.includes("REMODEX_ENABLE_DASHBOARD_SERVER"),
      production_bootstrap_mentions_toggle: bootstrapText.includes("REMODEX_ENABLE_DASHBOARD_SERVER"),
      windows_bootstrap_mentions_toggle: windowsBootstrapText.includes("REMODEX_ENABLE_DASHBOARD_SERVER"),
    },
  };

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
