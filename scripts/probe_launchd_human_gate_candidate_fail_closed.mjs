import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeDir = path.join(verificationDir, "launchd_human_gate_candidate_fail_closed_probe");
const projectDir = path.join(probeDir, "project_alpha");
const stateDir = path.join(projectDir, "state");
const humanGateDir = path.join(projectDir, "human_gate_candidates");
const processedDir = path.join(projectDir, "processed");
const runtimeDir = path.join(probeDir, "runtime");
const plistPath = path.join(verificationDir, "com.remodex.launchd-human-gate-candidate-fail-closed.plist");
const summaryPath = path.join(verificationDir, "launchd_human_gate_candidate_fail_closed_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "launchd_human_gate_candidate_fail_closed_probe_events.jsonl");
const lastRunPath = path.join(runtimeDir, "last_run.json");
const wakeFilePath = path.join(probeDir, "should_not_exist.txt");
const inputPath = path.join(runtimeDir, "input.json");
const candidatePath = path.join(humanGateDir, "2026-03-26T20-00-00+09-00_approve_candidate-001.json");
const workerScriptPath = path.join(workspace, "scripts", "launchd_human_gate_worker.mjs");
const nodePath = "/opt/homebrew/bin/node";
const label = "com.remodex.launchd-human-gate-candidate-fail-closed";
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const guiDomain = `gui/${process.getuid()}`;

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class JsonRpcWsClient {
  constructor(url, logPath) {
    this.url = url;
    this.logPath = logPath;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(new Error(`websocket connect failed: ${event.message ?? "unknown error"}`));
      };
      const cleanup = () => {
        this.ws.removeEventListener("open", onOpen);
        this.ws.removeEventListener("error", onError);
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });

    this.ws.addEventListener("message", async (event) => {
      const text = String(event.data);
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      await fs.appendFile(this.logPath, `${JSON.stringify(msg)}\n`);
      if (msg.id === undefined || msg.method !== undefined) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code ?? "no-code"})`));
      else pending.resolve(msg.result);
    });
  }

  async initialize(name) {
    await this.request("initialize", {
      clientInfo: { name, title: name, version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const payload = { method, id, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  notify(method, params = {}) {
    this.ws.send(JSON.stringify({ method, params }));
  }

  close() {
    this.ws?.close();
  }
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

async function readTurnCount(client, threadId) {
  try {
    const result = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    return (result?.thread?.turns ?? []).length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not materialized yet")) return 0;
    throw error;
  }
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
  <key>EnvironmentVariables</key>
  <dict>
    <key>REMODEX_LAUNCHD_HUMAN_GATE_PROBE_DIR</key>
    <string>${probeDir}</string>
  </dict>
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
  candidate: null,
  blockedRun: null,
  finalState: null,
};

let client = null;

try {
  await fs.rm(probeDir, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(humanGateDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");
  await fs.rm(wakeFilePath, { force: true });
  await fs.rm(plistPath, { force: true });

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("launchd_human_gate_candidate_fail_closed_probe");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "launchd_human_gate_candidate_fail_closed_probe",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeText(
    path.join(stateDir, "background_trigger_toggle.md"),
    "background_trigger_enabled: true\nforeground_session_active: false\nforeground_lock_enabled: false\n",
  );
  await writeText(
    path.join(stateDir, "coordinator_status.md"),
    "type: active\nactiveFlags: waitingOnApproval\n",
  );
  await writeText(
    path.join(stateDir, "stop_conditions.md"),
    "must_human_check: true\npending_human_gate: MUST_HUMAN_CHECK\nreason: approval candidate still open\n",
  );
  await writeJson(inputPath, { wsUrl, threadId, wakeFilePath });
  await writeJson(candidatePath, {
    source: "discord",
    operator_id: "ops-user-background",
    operator_roles: ["ops-admin", "operator"],
    command_name: "approve",
    auth_class: "approval",
    workspace_key: "remodex",
    project_key: "project-alpha",
    source_ref: "item/commandExecution/requestApproval:999",
    correlation_key: "guild-1:alpha-ops:fail-closed-candidate-001",
    route_decision: "human_gate_candidate",
    approval_source_ref: "item/commandExecution/requestApproval:999",
  });
  summary.candidate = await readJsonIfExists(candidatePath);
  await installPlist();

  const beforeTurnCount = await readTurnCount(client, threadId);
  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // ignore
  }
  await execFileAsync("launchctl", ["bootstrap", guiDomain, plistPath]);
  const blockedRun = await waitFor(async () => {
    const run = await readJsonIfExists(lastRunPath);
    return run?.decision === "blocked" ? run : null;
  }, 20_000);
  await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  const afterTurnCount = await readTurnCount(client, threadId);

  summary.blockedRun = blockedRun;
  summary.finalState = {
    beforeTurnCount,
    afterTurnCount,
    wakeFile: await readTextIfExists(wakeFilePath),
    candidateStillPresent: (await readJsonIfExists(candidatePath)) !== null,
    candidateAfter: await readJsonIfExists(candidatePath),
    processedFiles: await fs.readdir(processedDir).catch(() => []),
  };
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.blockedRun?.decision === "blocked" &&
    Array.isArray(summary.blockedRun.blockedReasons) &&
    summary.blockedRun.blockedReasons.includes("must_human_check") &&
    summary.blockedRun.blockedReasons.includes("pending_human_gate") &&
    summary.finalState.beforeTurnCount === summary.finalState.afterTurnCount &&
    summary.finalState.wakeFile === null &&
    summary.finalState.candidateStillPresent === true &&
    summary.finalState.processedFiles.length === 0
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  try {
    await execFileAsync("launchctl", ["bootout", `${guiDomain}/${label}`]);
  } catch {
    // ignore
  }
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "launchd human gate candidate fail-closed probe failed");
}
