import fs from "node:fs/promises";
import path from "node:path";

function toNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function listFiles(dirPath, matcher = () => true) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter(matcher).sort();
  } catch {
    return [];
  }
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parsePsSnapshot(text) {
  const lines = text.split("\n").slice(2).filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)\s+(.*)$/);
    if (!match) return { raw: line };
    return {
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      rss_kb: Number.parseInt(match[3], 10),
      cpu_pct: toNumber(match[4]),
      etime: match[5],
      command: match[6],
    };
  });
}

async function latestJson(dirPath, prefix) {
  const files = await listFiles(dirPath, (name) => name.startsWith(prefix) && name.endsWith(".json"));
  for (const fileName of files.slice().reverse()) {
    try {
      return await readJson(path.join(dirPath, fileName));
    } catch {
      continue;
    }
  }
  return null;
}

async function countJsonFiles(dirPath) {
  return (await listFiles(dirPath, (name) => name.endsWith(".json"))).length;
}

function incrementCount(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const stackDir = process.env.REMODEX_CHURN_STACK_DIR ?? path.join(workspace, "runtime", "churn");
const metricsDir = process.env.REMODEX_METRICS_DIR ?? path.join(workspace, "runtime", "metrics");

const fixture = await readJson(path.join(stackDir, "churn_fixture.json"));
const stackSummary = await readJson(path.join(stackDir, "summary.json"));
const psFiles = await listFiles(path.join(metricsDir, "ps-snapshots"), (name) => name.endsWith(".txt"));
const portFiles = await listFiles(path.join(metricsDir, "ports"), (name) => name.endsWith(".txt"));
const schedulerFiles = await listFiles(stackDir, (name) => name.startsWith("scheduler-") && name.endsWith(".json"));

let peakRssKb = 0;
let peakCpuPct = 0;
let psPermissionDeniedCount = 0;
let nonLoopbackBindCount = 0;

for (const fileName of psFiles) {
  const text = await fs.readFile(path.join(metricsDir, "ps-snapshots", fileName), "utf8");
  if (text.includes("operation not permitted: ps")) psPermissionDeniedCount += 1;
  for (const row of parsePsSnapshot(text)) {
    if (row.rss_kb) peakRssKb = Math.max(peakRssKb, row.rss_kb);
    if (row.cpu_pct) peakCpuPct = Math.max(peakCpuPct, row.cpu_pct);
  }
}

for (const fileName of portFiles) {
  const text = await fs.readFile(path.join(metricsDir, "ports", fileName), "utf8");
  for (const line of text.split("\n")) {
    if (!line.includes("TCP")) continue;
    if (line.includes("127.0.0.1:") || line.includes("localhost:")) continue;
    if (line.includes("TCP *:")) nonLoopbackBindCount += 1;
  }
}

const decisionCounts = new Map();
const blockedReasonCounts = new Map();
for (const fileName of schedulerFiles) {
  let payload;
  try {
    payload = await readJson(path.join(stackDir, fileName));
  } catch {
    continue;
  }
  for (const result of payload.results ?? []) {
    incrementCount(decisionCounts, result.decision ?? "unknown");
    for (const reason of result.reasons ?? []) {
      incrementCount(blockedReasonCounts, reason);
    }
    for (const reason of result.result?.reasons ?? []) {
      incrementCount(blockedReasonCounts, reason);
    }
  }
}

const alphaProjectRoot = path.join(fixture.shared_base, fixture.workspace_key, "projects", fixture.projects.alpha.project_key);
const betaProjectRoot = path.join(fixture.shared_base, fixture.workspace_key, "projects", fixture.projects.beta.project_key);
const alphaProcessedDir = path.join(alphaProjectRoot, "processed");
const betaProcessedDir = path.join(betaProjectRoot, "processed");
const betaHumanGateDir = path.join(betaProjectRoot, "human_gate_candidates");
const workspaceRouterQuarantineDir = path.join(fixture.shared_base, fixture.workspace_key, "router", "quarantine");

const alphaProcessedCount = await countJsonFiles(alphaProcessedDir);
const betaProcessedCount = await countJsonFiles(betaProcessedDir);
const betaHumanGateCount = await countJsonFiles(betaHumanGateDir);
const quarantineCount = await countJsonFiles(workspaceRouterQuarantineDir);
const alphaTargetText = await readText(fixture.projects.alpha.target_file);
const alphaTargetLineCount = alphaTargetText ? alphaTargetText.trim().split("\n").filter(Boolean).length : 0;

const latestBridgeHealth = await latestJson(stackDir, "bridge-health-");
const latestDashboardHealth = await latestJson(stackDir, "dashboard-health-");
const latestPortfolio = await latestJson(stackDir, "portfolio-");
const shutdownDrainSummary = await readText(path.join(stackDir, "shutdown_drain_summary.json"))
  .then((text) => (text ? JSON.parse(text) : null))
  .catch(() => null);

const summary = {
  mode: "macos_churn_stack_verdict",
  generated_at: new Date().toISOString(),
  stack_dir: stackDir,
  metrics_dir: metricsDir,
  sample_count: stackSummary.sample_count,
  peak_rss_kb: peakRssKb || null,
  peak_cpu_pct: peakCpuPct || null,
  ps_permission_denied_count: psPermissionDeniedCount,
  non_loopback_bind_count: nonLoopbackBindCount,
  latest_bridge_health: latestBridgeHealth,
  latest_dashboard_health: latestDashboardHealth,
  latest_portfolio: latestPortfolio,
  scheduler_decisions: Object.fromEntries(decisionCounts),
  blocked_reasons: Object.fromEntries(blockedReasonCounts),
  alpha_processed_count: alphaProcessedCount,
  beta_processed_count: betaProcessedCount,
  beta_human_gate_count: betaHumanGateCount,
  quarantine_count: quarantineCount,
  alpha_target_line_count: alphaTargetLineCount,
  shutdown_drain: shutdownDrainSummary,
};

summary.verdict =
  latestBridgeHealth?.ok === true &&
  latestDashboardHealth?.ok === true &&
  nonLoopbackBindCount === 0 &&
  alphaTargetLineCount > 0 &&
  betaHumanGateCount > 0 &&
  quarantineCount > 0 &&
  (!shutdownDrainSummary || shutdownDrainSummary.verdict === "drained") &&
  (blockedReasonCounts.get("foreground_session_active") ?? 0) > 0 &&
  (blockedReasonCounts.get("pending_human_gate") ?? 0) > 0
    ? "pass"
    : "conditional_pass";

const outputPath = path.join(stackDir, "verdict.json");
await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, verdict: summary.verdict }, null, 2));
