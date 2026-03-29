import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspace = path.resolve(moduleDir, "../..");

export const DEFAULT_SCHEDULER_KIND = "launchd_launchagent";
export const SUPPORTED_SCHEDULER_KINDS = [DEFAULT_SCHEDULER_KIND, "windows_task_scheduler"];

export async function loadEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parsed[key] = value;
    }
    return parsed;
  } catch {
    return {};
  }
}

function plistEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(key, value) {
  return `  <key>${plistEscape(key)}</key>\n  <string>${plistEscape(value)}</string>`;
}

function plistInteger(key, value) {
  return `  <key>${plistEscape(key)}</key>\n  <integer>${value}</integer>`;
}

function plistBool(key, value) {
  return `  <key>${plistEscape(key)}</key>\n  <${value ? "true" : "false"}/>`;
}

function plistArray(key, values) {
  const body = values.map((value) => `    <string>${plistEscape(value)}</string>`).join("\n");
  return `  <key>${plistEscape(key)}</key>\n  <array>\n${body}\n  </array>`;
}

function plistEnv(env) {
  const lines = Object.entries(env).map(
    ([key, value]) => `    <key>${plistEscape(key)}</key>\n    <string>${plistEscape(value)}</string>`,
  );
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${lines.join("\n")}\n  </dict>`;
}

function buildPlist(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...entries,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export async function resolveSchedulerRenderContext() {
  const initialWorkspace = process.env.REMODEX_WORKSPACE ?? defaultWorkspace;
  const envFile = process.env.REMODEX_ENV_FILE ?? path.join(initialWorkspace, "ops", "remodex.env");
  const envFromFile = await loadEnvFile(envFile);
  const workspace = process.env.REMODEX_WORKSPACE ?? envFromFile.REMODEX_WORKSPACE ?? initialWorkspace;
  const nodeBin = process.env.REMODEX_NODE_BIN ?? envFromFile.REMODEX_NODE_BIN ?? "node";
  const schedulerKind =
    process.env.REMODEX_SCHEDULER_KIND ?? envFromFile.REMODEX_SCHEDULER_KIND ?? DEFAULT_SCHEDULER_KIND;
  const labelPrefix =
    process.env.REMODEX_LAUNCHD_LABEL_PREFIX ?? envFromFile.REMODEX_LAUNCHD_LABEL_PREFIX ?? "com.remodex";
  const schedulerInterval = Number.parseInt(
    process.env.REMODEX_SCHEDULER_INTERVAL_SECONDS ?? envFromFile.REMODEX_SCHEDULER_INTERVAL_SECONDS ?? "60",
    10,
  );
  const enableDiscordGatewayAdapter =
    (process.env.REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER ??
      envFromFile.REMODEX_ENABLE_DISCORD_GATEWAY_ADAPTER ??
      "false") === "true";
  const enableDashboardServer =
    (process.env.REMODEX_ENABLE_DASHBOARD_SERVER ??
      envFromFile.REMODEX_ENABLE_DASHBOARD_SERVER ??
      "false") === "true";
  return {
    envFile,
    envFromFile,
    workspace,
    nodeBin,
    schedulerKind,
    labelPrefix,
    schedulerInterval,
    enableDiscordGatewayAdapter,
    enableDashboardServer,
  };
}

export function assertSupportedSchedulerKind(kind) {
  if (SUPPORTED_SCHEDULER_KINDS.includes(kind)) return;
  throw new Error(
    `Unsupported REMODEX_SCHEDULER_KIND=${kind}. Supported kinds: ${SUPPORTED_SCHEDULER_KINDS.join(", ")}`,
  );
}

async function renderLaunchdArtifacts(context) {
  const outputDir = path.join(context.workspace, "ops", "launchd", "generated");
  const logDir = path.join(context.workspace, "runtime", "launchd");
  const bridgeScript = path.join(context.workspace, "ops", "run_bridge_daemon.sh");
  const schedulerScript = path.join(context.workspace, "ops", "run_scheduler_tick.sh");
  const gatewayAdapterScript = path.join(context.workspace, "ops", "run_discord_gateway_adapter.sh");
  const dashboardScript = path.join(context.workspace, "ops", "run_dashboard_server.sh");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });

  const sharedEnv = {
    REMODEX_ENV_FILE: context.envFile,
    REMODEX_NODE_BIN: context.nodeBin,
    REMODEX_SCHEDULER_KIND: context.schedulerKind,
  };

  const bridgeLabel = `${context.labelPrefix}.bridge-daemon`;
  const schedulerLabel = `${context.labelPrefix}.scheduler-tick`;
  const gatewayAdapterLabel = `${context.labelPrefix}.discord-gateway-adapter`;
  const dashboardLabel = `${context.labelPrefix}.dashboard-server`;

  const bridgePlist = buildPlist([
    plistString("Label", bridgeLabel),
    plistArray("ProgramArguments", ["/bin/zsh", bridgeScript]),
    plistString("WorkingDirectory", context.workspace),
    plistBool("RunAtLoad", true),
    plistBool("KeepAlive", true),
    plistEnv(sharedEnv),
    plistString("StandardOutPath", path.join(logDir, "bridge-daemon.stdout.log")),
    plistString("StandardErrorPath", path.join(logDir, "bridge-daemon.stderr.log")),
  ]);

  const schedulerPlist = buildPlist([
    plistString("Label", schedulerLabel),
    plistArray("ProgramArguments", ["/bin/zsh", schedulerScript]),
    plistString("WorkingDirectory", context.workspace),
    plistBool("RunAtLoad", true),
    plistInteger("StartInterval", context.schedulerInterval),
    plistEnv(sharedEnv),
    plistString("StandardOutPath", path.join(logDir, "scheduler-tick.stdout.log")),
    plistString("StandardErrorPath", path.join(logDir, "scheduler-tick.stderr.log")),
  ]);

  const gatewayAdapterPlist = buildPlist([
    plistString("Label", gatewayAdapterLabel),
    plistArray("ProgramArguments", ["/bin/zsh", gatewayAdapterScript]),
    plistString("WorkingDirectory", context.workspace),
    plistBool("RunAtLoad", true),
    plistBool("KeepAlive", true),
    plistEnv(sharedEnv),
    plistString("StandardOutPath", path.join(logDir, "discord-gateway-adapter.stdout.log")),
    plistString("StandardErrorPath", path.join(logDir, "discord-gateway-adapter.stderr.log")),
  ]);
  const dashboardPlist = buildPlist([
    plistString("Label", dashboardLabel),
    plistArray("ProgramArguments", ["/bin/zsh", dashboardScript]),
    plistString("WorkingDirectory", context.workspace),
    plistBool("RunAtLoad", true),
    plistBool("KeepAlive", true),
    plistEnv(sharedEnv),
    plistString("StandardOutPath", path.join(logDir, "dashboard-server.stdout.log")),
    plistString("StandardErrorPath", path.join(logDir, "dashboard-server.stderr.log")),
  ]);

  const bridgeArtifact = path.join(outputDir, `${bridgeLabel}.plist`);
  const schedulerArtifact = path.join(outputDir, `${schedulerLabel}.plist`);
  const gatewayAdapterArtifact = path.join(outputDir, `${gatewayAdapterLabel}.plist`);
  const dashboardArtifact = path.join(outputDir, `${dashboardLabel}.plist`);

  await fs.writeFile(bridgeArtifact, bridgePlist);
  await fs.writeFile(schedulerArtifact, schedulerPlist);
  if (context.enableDiscordGatewayAdapter) {
    await fs.writeFile(gatewayAdapterArtifact, gatewayAdapterPlist);
  } else {
    await fs.rm(gatewayAdapterArtifact, { force: true });
  }
  if (context.enableDashboardServer) {
    await fs.writeFile(dashboardArtifact, dashboardPlist);
  } else {
    await fs.rm(dashboardArtifact, { force: true });
  }

  return {
    scheduler_kind: context.schedulerKind,
    workspace: context.workspace,
    output_dir: outputDir,
    log_dir: logDir,
    scheduler_interval_seconds: context.schedulerInterval,
    artifacts: {
      bridge: bridgeArtifact,
      scheduler: schedulerArtifact,
      ...(context.enableDiscordGatewayAdapter ? { discord_gateway_adapter: gatewayAdapterArtifact } : {}),
      ...(context.enableDashboardServer ? { dashboard_server: dashboardArtifact } : {}),
    },
    features: {
      discord_gateway_adapter: context.enableDiscordGatewayAdapter,
      dashboard_server: context.enableDashboardServer,
    },
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildWindowsTaskXml({
  description,
  command,
  argumentsValue,
  workingDirectory,
  startBoundary,
  repetitionInterval,
  logonTrigger,
}) {
  const triggerBlock = logonTrigger
    ? [
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        "    </LogonTrigger>",
        "  </Triggers>",
      ].join("\n")
    : [
        "  <Triggers>",
        "    <TimeTrigger>",
        `      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>`,
        "      <Enabled>true</Enabled>",
        "      <Repetition>",
        `        <Interval>${xmlEscape(repetitionInterval)}</Interval>`,
        "        <Duration>P1D</Duration>",
        "        <StopAtDurationEnd>false</StopAtDurationEnd>",
        "      </Repetition>",
        "    </TimeTrigger>",
        "  </Triggers>",
      ].join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(description)}</Description>`,
    "  </RegistrationInfo>",
    triggerBlock,
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xmlEscape(command)}</Command>`,
    `      <Arguments>${xmlEscape(argumentsValue)}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(workingDirectory)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

async function renderWindowsTaskSchedulerArtifacts(context) {
  const outputDir = path.join(context.workspace, "ops", "windows-task-scheduler", "generated");
  await fs.mkdir(outputDir, { recursive: true });

  const taskPrefix = process.env.REMODEX_WINDOWS_TASK_PREFIX ?? context.envFromFile.REMODEX_WINDOWS_TASK_PREFIX ?? "Remodex";
  const bridgeTaskName = `${taskPrefix}-BridgeDaemon`;
  const schedulerTaskName = `${taskPrefix}-SchedulerTick`;
  const gatewayAdapterTaskName = `${taskPrefix}-DiscordGatewayAdapter`;
  const dashboardTaskName = `${taskPrefix}-DashboardServer`;
  const bridgeScript = path.join(context.workspace, "ops", "run_bridge_daemon.ps1");
  const schedulerScript = path.join(context.workspace, "ops", "run_scheduler_tick.ps1");
  const gatewayAdapterScript = path.join(context.workspace, "ops", "run_discord_gateway_adapter.ps1");
  const dashboardScript = path.join(context.workspace, "ops", "run_dashboard_server.ps1");
  const command = "powershell.exe";
  const bridgeArguments = `-NoProfile -ExecutionPolicy Bypass -File "${bridgeScript}"`;
  const schedulerArguments = `-NoProfile -ExecutionPolicy Bypass -File "${schedulerScript}"`;
  const gatewayAdapterArguments = `-NoProfile -ExecutionPolicy Bypass -File "${gatewayAdapterScript}"`;
  const dashboardArguments = `-NoProfile -ExecutionPolicy Bypass -File "${dashboardScript}"`;
  const now = new Date();
  const startBoundary = new Date(now.getTime() + 60_000).toISOString().replace(/\.\d{3}Z$/, "");
  const intervalMinutes = Math.max(1, Math.floor(context.schedulerInterval / 60) || 1);
  const repetitionInterval = `PT${intervalMinutes}M`;

  const bridgeXml = buildWindowsTaskXml({
    description: "Remodex bridge daemon",
    command,
    argumentsValue: bridgeArguments,
    workingDirectory: context.workspace,
    startBoundary,
    repetitionInterval,
    logonTrigger: true,
  });
  const schedulerXml = buildWindowsTaskXml({
    description: "Remodex scheduler tick",
    command,
    argumentsValue: schedulerArguments,
    workingDirectory: context.workspace,
    startBoundary,
    repetitionInterval,
    logonTrigger: false,
  });
  const gatewayAdapterXml = buildWindowsTaskXml({
    description: "Remodex Discord Gateway adapter",
    command,
    argumentsValue: gatewayAdapterArguments,
    workingDirectory: context.workspace,
    startBoundary,
    repetitionInterval,
    logonTrigger: true,
  });
  const dashboardXml = buildWindowsTaskXml({
    description: "Remodex dashboard server",
    command,
    argumentsValue: dashboardArguments,
    workingDirectory: context.workspace,
    startBoundary,
    repetitionInterval,
    logonTrigger: true,
  });

  const bridgeArtifact = path.join(outputDir, `${bridgeTaskName}.xml`);
  const schedulerArtifact = path.join(outputDir, `${schedulerTaskName}.xml`);
  const gatewayAdapterArtifact = path.join(outputDir, `${gatewayAdapterTaskName}.xml`);
  const dashboardArtifact = path.join(outputDir, `${dashboardTaskName}.xml`);

  await fs.writeFile(bridgeArtifact, bridgeXml, "utf8");
  await fs.writeFile(schedulerArtifact, schedulerXml, "utf8");
  if (context.enableDiscordGatewayAdapter) {
    await fs.writeFile(gatewayAdapterArtifact, gatewayAdapterXml, "utf8");
  } else {
    await fs.rm(gatewayAdapterArtifact, { force: true });
  }
  if (context.enableDashboardServer) {
    await fs.writeFile(dashboardArtifact, dashboardXml, "utf8");
  } else {
    await fs.rm(dashboardArtifact, { force: true });
  }

  return {
    scheduler_kind: context.schedulerKind,
    workspace: context.workspace,
    output_dir: outputDir,
    scheduler_interval_seconds: context.schedulerInterval,
    artifacts: {
      bridge: bridgeArtifact,
      scheduler: schedulerArtifact,
      ...(context.enableDiscordGatewayAdapter ? { discord_gateway_adapter: gatewayAdapterArtifact } : {}),
      ...(context.enableDashboardServer ? { dashboard_server: dashboardArtifact } : {}),
    },
    task_names: {
      bridge: bridgeTaskName,
      scheduler: schedulerTaskName,
      ...(context.enableDiscordGatewayAdapter ? { discord_gateway_adapter: gatewayAdapterTaskName } : {}),
      ...(context.enableDashboardServer ? { dashboard_server: dashboardTaskName } : {}),
    },
    features: {
      discord_gateway_adapter: context.enableDiscordGatewayAdapter,
      dashboard_server: context.enableDashboardServer,
    },
  };
}

export async function renderSchedulerArtifacts(context) {
  const resolvedContext = context ?? await resolveSchedulerRenderContext();
  assertSupportedSchedulerKind(resolvedContext.schedulerKind);
  switch (resolvedContext.schedulerKind) {
    case DEFAULT_SCHEDULER_KIND:
      return await renderLaunchdArtifacts(resolvedContext);
    case "windows_task_scheduler":
      return await renderWindowsTaskSchedulerArtifacts(resolvedContext);
    default:
      throw new Error(`Unhandled scheduler kind: ${resolvedContext.schedulerKind}`);
  }
}
