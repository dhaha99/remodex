import fs from "node:fs/promises";
import path from "node:path";

async function loadEnvFile(filePath) {
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

const initialWorkspace = process.env.REMODEX_WORKSPACE ?? "/Users/mymac/my dev/remodex";
const envFile = process.env.REMODEX_ENV_FILE ?? path.join(initialWorkspace, "ops", "remodex.env");
const envFromFile = await loadEnvFile(envFile);
const workspace = process.env.REMODEX_WORKSPACE ?? envFromFile.REMODEX_WORKSPACE ?? initialWorkspace;
const nodeBin = process.env.REMODEX_NODE_BIN ?? envFromFile.REMODEX_NODE_BIN ?? "/opt/homebrew/bin/node";
const labelPrefix = process.env.REMODEX_LAUNCHD_LABEL_PREFIX ?? envFromFile.REMODEX_LAUNCHD_LABEL_PREFIX ?? "com.remodex";
const schedulerInterval = Number.parseInt(
  process.env.REMODEX_SCHEDULER_INTERVAL_SECONDS ?? envFromFile.REMODEX_SCHEDULER_INTERVAL_SECONDS ?? "60",
  10,
);
const outputDir = path.join(workspace, "ops", "launchd", "generated");
const logDir = path.join(workspace, "runtime", "launchd");
const bridgeScript = path.join(workspace, "ops", "run_bridge_daemon.sh");
const schedulerScript = path.join(workspace, "ops", "run_scheduler_tick.sh");

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(logDir, { recursive: true });

const sharedEnv = {
  REMODEX_ENV_FILE: envFile,
  REMODEX_NODE_BIN: nodeBin,
};

const bridgeLabel = `${labelPrefix}.bridge-daemon`;
const schedulerLabel = `${labelPrefix}.scheduler-tick`;

const bridgePlist = buildPlist([
  plistString("Label", bridgeLabel),
  plistArray("ProgramArguments", ["/bin/zsh", bridgeScript]),
  plistString("WorkingDirectory", workspace),
  plistBool("RunAtLoad", true),
  plistBool("KeepAlive", true),
  plistEnv(sharedEnv),
  plistString("StandardOutPath", path.join(logDir, "bridge-daemon.stdout.log")),
  plistString("StandardErrorPath", path.join(logDir, "bridge-daemon.stderr.log")),
]);

const schedulerPlist = buildPlist([
  plistString("Label", schedulerLabel),
  plistArray("ProgramArguments", ["/bin/zsh", schedulerScript]),
  plistString("WorkingDirectory", workspace),
  plistBool("RunAtLoad", true),
  plistInteger("StartInterval", schedulerInterval),
  plistEnv(sharedEnv),
  plistString("StandardOutPath", path.join(logDir, "scheduler-tick.stdout.log")),
  plistString("StandardErrorPath", path.join(logDir, "scheduler-tick.stderr.log")),
]);

const bridgePlistPath = path.join(outputDir, `${bridgeLabel}.plist`);
const schedulerPlistPath = path.join(outputDir, `${schedulerLabel}.plist`);

await fs.writeFile(bridgePlistPath, bridgePlist);
await fs.writeFile(schedulerPlistPath, schedulerPlist);

console.log(JSON.stringify({
  workspace,
  output_dir: outputDir,
  bridge_plist: bridgePlistPath,
  scheduler_plist: schedulerPlistPath,
  log_dir: logDir,
  scheduler_interval_seconds: schedulerInterval,
}, null, 2));
