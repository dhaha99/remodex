import fs from "node:fs/promises";
import path from "node:path";

function toNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function listFiles(dirPath, matcher = () => true) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter(matcher).sort();
  } catch {
    return [];
  }
}

function parsePsSnapshot(text) {
  const lines = text.split("\n").slice(2).filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(\S+)\s+(.*)$/);
    if (!match) {
      return { raw: line };
    }
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
  if (files.length === 0) return null;
  return await readJson(path.join(dirPath, files.at(-1)));
}

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const stackDir = process.env.REMODEX_SMOKE_STACK_DIR ?? path.join(workspace, "runtime", "smoke");
const metricsDir = process.env.REMODEX_METRICS_DIR ?? path.join(workspace, "runtime", "metrics");

const stackSummary = await readJson(path.join(stackDir, "summary.json"));
const psFiles = await listFiles(path.join(metricsDir, "ps-snapshots"), (name) => name.endsWith(".txt"));
const portFiles = await listFiles(path.join(metricsDir, "ports"), (name) => name.endsWith(".txt"));
const healthFiles = await listFiles(path.join(metricsDir, "health"), (name) => name.endsWith(".txt"));

let peakRssKb = 0;
let peakCpuPct = 0;
let psPermissionDeniedCount = 0;
let nonLoopbackBindCount = 0;

for (const fileName of psFiles) {
  const text = await fs.readFile(path.join(metricsDir, "ps-snapshots", fileName), "utf8");
  if (text.includes("operation not permitted: ps")) {
    psPermissionDeniedCount += 1;
  }
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

const latestBridgeHealth = await latestJson(stackDir, "bridge-health-");
const latestDashboardHealth = await latestJson(stackDir, "dashboard-health-");
const latestScheduler = await latestJson(stackDir, "scheduler-");
const latestPortfolio = await latestJson(stackDir, "portfolio-");

const summary = {
  mode: "macos_smoke_stack_verdict",
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
  latest_scheduler: latestScheduler,
  latest_portfolio: latestPortfolio,
  latest_health_samples: healthFiles.length,
  verdict:
    latestBridgeHealth?.ok === true &&
    latestDashboardHealth?.ok === true &&
    nonLoopbackBindCount === 0
      ? "pass"
      : "conditional_pass",
};

const outputPath = path.join(stackDir, "verdict.json");
await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, verdict: summary.verdict }, null, 2));
