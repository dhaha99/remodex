import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const stateDir = path.join(verificationDir, "launchd_foreground_takeover_state");
const runtimeDir = path.join(stateDir, "runtime");
const workerScriptPath = path.join(workspace, "scripts", "launchd_foreground_takeover_tick.mjs");
const plistPath = path.join(verificationDir, "com.remodex.launchd-foreground-takeover.plist");
const summaryPath = path.join(verificationDir, "launchd_foreground_takeover_probe_summary.json");
const runtimeStatePath = path.join(runtimeDir, "scheduler_runtime.json");
const tickEventsPath = path.join(stateDir, "tick_events.jsonl");
const wakeEventPath = path.join(runtimeDir, "wake_event.json");
const label = "com.remodex.launchd-foreground-takeover";
const guiDomain = `gui/${process.getuid()}`;
const nodePath = "/opt/homebrew/bin/node";

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeToggleAndStatus({ backgroundEnabled, foregroundActive, statusType, mode }) {
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(
    path.join(runtimeDir, "background_trigger_toggle.json"),
    `${JSON.stringify(
      {
        background_trigger_enabled: backgroundEnabled,
        foreground_session_active: foregroundActive,
        foreground_lock_enabled: foregroundActive,
        mode,
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(runtimeDir, "coordinator_status.json"),
    `${JSON.stringify({ type: statusType }, null, 2)}\n`,
  );
}

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

async function installPlist() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerScriptPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workspace}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${path.join(runtimeDir, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(runtimeDir, "stderr.log")}</string>
</dict>
</plist>
`;
  await fs.writeFile(plistPath, plist);
}

const summary = {
  label,
  guiDomain,
  startedAt: new Date().toISOString(),
  backgroundPhase: null,
  foregroundTakeoverPhase: null,
};

try {
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.rm(plistPath, { force: true });

  await writeToggleAndStatus({
    backgroundEnabled: true,
    foregroundActive: false,
    statusType: "checkpoint_open",
    mode: "background",
  });
  await installPlist();

  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // already unloaded
  }

  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);

  const wakePhase = await waitFor(async () => {
    const runtime = await readJsonIfExists(runtimeStatePath);
    const wake = await readJsonIfExists(wakeEventPath);
    if (runtime?.last_decision === "wake" && wake) {
      return { runtime, wake };
    }
    return null;
  }, 20_000);
  summary.backgroundPhase = wakePhase;

  if (!wakePhase) {
    throw new Error("did not observe wake phase before foreground takeover");
  }

  const wakeTickCount = Number(wakePhase.runtime.tick_count);
  const wakeEventAt = wakePhase.runtime.last_wake_event_at ?? wakePhase.wake?.created_at ?? null;

  await writeToggleAndStatus({
    backgroundEnabled: false,
    foregroundActive: true,
    statusType: "busy_non_interruptible",
    mode: "foreground",
  });

  const blockedPhase = await waitFor(async () => {
    const runtime = await readJsonIfExists(runtimeStatePath);
    if (!runtime) return null;
    if (Number(runtime.tick_count) <= wakeTickCount) return null;
    if (runtime.last_decision !== "blocked") return null;
    return runtime;
  }, 20_000);
  const finalWakeEvent = await readJsonIfExists(wakeEventPath);
  const tickEvents = await readTextIfExists(tickEventsPath);

  summary.foregroundTakeoverPhase = {
    runtime: blockedPhase,
    wakeTickCount,
    wakeEventAtBeforeForeground: wakeEventAt,
    wakeEventAtAfterForeground: finalWakeEvent?.created_at ?? null,
    tickEvents,
  };

  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.backgroundPhase?.runtime?.last_decision === "wake" &&
    summary.foregroundTakeoverPhase?.runtime?.last_decision === "blocked" &&
    Array.isArray(summary.foregroundTakeoverPhase?.runtime?.last_blocked_reasons) &&
    summary.foregroundTakeoverPhase.runtime.last_blocked_reasons.includes("foreground_session_active") &&
    summary.foregroundTakeoverPhase.runtime.last_blocked_reasons.includes("background_trigger_disabled") &&
    summary.foregroundTakeoverPhase.wakeEventAtBeforeForeground === summary.foregroundTakeoverPhase.wakeEventAtAfterForeground
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  summary.finishedAt = new Date().toISOString();
  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // ignore cleanup failure
  }
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
