import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "launchd_human_gate_probe");
const projectDir = path.join(probeDir, "project_alpha");
const stateDir = path.join(projectDir, "state");
const runtimeDir = path.join(probeDir, "runtime");
const plistPath = path.join(verificationDir, "com.remodex.launchd-human-gate.plist");
const summaryPath = path.join(verificationDir, "launchd_human_gate_probe_summary.json");
const previousSummaryPath = path.join(verificationDir, "thread_resume_probe_summary.json");
const lastRunPath = path.join(runtimeDir, "last_run.json");
const wakeFilePath = path.join(probeDir, "from_human_gate_wake.txt");
const workerScriptPath = path.join(workspace, "scripts", "launchd_human_gate_worker.mjs");
const nodePath = "/opt/homebrew/bin/node";
const label = "com.remodex.launchd-human-gate";
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const guiDomain = `gui/${process.getuid()}`;

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
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

async function waitFor(predicate, timeoutMs = 30_000, intervalMs = 500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

async function writeToggleStatusAndStop({ mustHumanCheck }) {
  await writeText(
    path.join(stateDir, "background_trigger_toggle.md"),
    "background_trigger_enabled: true\nforeground_session_active: false\nforeground_lock_enabled: false\n",
  );
  await writeText(path.join(stateDir, "coordinator_status.md"), "type: checkpoint_open\n");
  await writeText(
    path.join(stateDir, "stop_conditions.md"),
    mustHumanCheck
      ? "must_human_check: true\npending_human_gate: MUST_HUMAN_CHECK\nreason: artifact-777 requires review\n"
      : "must_human_check: false\npending_human_gate: none\nreason: none\n",
  );
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
  <key>StandardOutPath</key>
  <string>${path.join(runtimeDir, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(runtimeDir, "stderr.log")}</string>
</dict>
</plist>
`;
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(plistPath, plist);
}

const summary = {
  wsUrl,
  label,
  guiDomain,
  startedAt: new Date().toISOString(),
  threadId: null,
  blockedCase: null,
  wakeCase: null,
};

try {
  await fs.rm(probeDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(runtimeDir, { recursive: true });

  const previousSummary = JSON.parse(await fs.readFile(previousSummaryPath, "utf8"));
  const threadId = previousSummary?.sourceThreadId ?? previousSummary?.threadId;
  if (!threadId) throw new Error("thread_resume_probe_summary.json does not contain thread id");
  summary.threadId = threadId;

  await writeText(
    path.join(runtimeDir, "input.json"),
    JSON.stringify({ wsUrl, threadId, wakeFilePath }, null, 2),
  );
  await installPlist();

  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // ignore if not loaded
  }

  await writeToggleStatusAndStop({ mustHumanCheck: true });
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  const blockedRun = await waitFor(async () => {
    const run = await readJsonIfExists(lastRunPath);
    return run?.decision === "blocked" ? run : null;
  }, 20_000);
  summary.blockedCase = {
    run: blockedRun,
    wakeFileExists: (await readTextIfExists(wakeFilePath)) !== null,
  };
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  await writeToggleStatusAndStop({ mustHumanCheck: false });
  await fs.rm(lastRunPath, { force: true });
  await fs.rm(wakeFilePath, { force: true });
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  const wakeRun = await waitFor(async () => {
    const wakeText = await readTextIfExists(wakeFilePath);
    const run = await readJsonIfExists(lastRunPath);
    if (run?.decision === "wake" && wakeText !== null) return { run, wakeText };
    if (wakeText !== null) return { run, wakeText };
    return null;
  }, 30_000);
  if (wakeRun && !wakeRun.run) {
    await sleep(2_000);
    wakeRun.run = await readJsonIfExists(lastRunPath);
  }
  summary.wakeCase = wakeRun;
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);

  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
}
