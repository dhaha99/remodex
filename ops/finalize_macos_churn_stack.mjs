import fs from "node:fs/promises";
import path from "node:path";
import {
  buildProjectPaths,
  readInFlightDelivery,
  readProjectSnapshot,
  writeAtomicJson,
} from "../scripts/lib/shared_memory_runtime.mjs";

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const stackDir = process.env.REMODEX_CHURN_STACK_DIR ?? path.join(workspace, "runtime", "churn");
const metricsDir = process.env.REMODEX_METRICS_DIR ?? path.join(workspace, "runtime", "metrics");

function matchTimestamp(fileName, prefix) {
  const match = fileName.match(new RegExp(`^${prefix}(\\d{8}T\\d{6})`));
  return match ? match[1] : null;
}

function timestampToIso(value) {
  if (!value || !/^\d{8}T\d{6}$/.test(value)) return null;
  const year = value.slice(0, 4);
  const month = value.slice(4, 6);
  const day = value.slice(6, 8);
  const hour = value.slice(9, 11);
  const minute = value.slice(11, 13);
  const second = value.slice(13, 15);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
}

async function listFilesSafe(dirPath) {
  try {
    return (await fs.readdir(dirPath)).sort();
  } catch {
    return [];
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function countNonEmptyLines(text) {
  if (!text) return 0;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean).length;
}

async function ensureSummary(fixture) {
  const summaryPath = path.join(stackDir, "summary.json");
  try {
    const summary = await readJson(summaryPath);
    return { summaryPath, summary, generated: false };
  } catch {
    const stackFiles = await listFilesSafe(stackDir);
    const driverTimestamps = stackFiles
      .map((name) => matchTimestamp(name, "driver-"))
      .filter(Boolean);
    const schedulerTimestamps = stackFiles
      .map((name) => matchTimestamp(name, "scheduler-"))
      .filter(Boolean);
    const timestamps = [...driverTimestamps, ...schedulerTimestamps].sort();
    const startedAt = timestampToIso(timestamps[0]) ?? fixture.generated_at ?? new Date().toISOString();
    const completedAt =
      timestampToIso(timestamps[timestamps.length - 1]) ?? fixture.generated_at ?? new Date().toISOString();
    const intervalSeconds = fixture.churn_interval_seconds ?? 300;
    const sampleCount = schedulerTimestamps.length || driverTimestamps.length || 0;
    const durationSeconds =
      sampleCount > 1 ? intervalSeconds * (sampleCount - 1) : fixture.churn_duration_seconds ?? intervalSeconds;
    const summary = {
      mode: "macos_churn_stack",
      started_at: startedAt,
      completed_at: completedAt,
      duration_seconds: durationSeconds,
      interval_seconds: intervalSeconds,
      sample_count: sampleCount,
      stack_dir: stackDir,
      metrics_dir: metricsDir,
      status: "completed",
      origin: "offline_finalize",
    };
    await writeAtomicJson(summaryPath, summary);
    return { summaryPath, summary, generated: true };
  }
}

async function ensureShutdownDrain(fixture) {
  const outputPath = path.join(stackDir, "shutdown_drain_summary.json");
  try {
    const summary = await readJson(outputPath);
    return { outputPath, summary, generated: false };
  } catch {
    const alphaProjectKey = fixture.projects.alpha.project_key;
    const alphaPaths = buildProjectPaths({
      sharedBase: fixture.shared_base,
      workspaceKey: fixture.workspace_key,
      projectKey: alphaProjectKey,
    });
    const snapshot = await readProjectSnapshot(alphaPaths);
    const inflight = await readInFlightDelivery(alphaPaths);
    const final = {
      coordinator_status:
        snapshot.coordinator_status?.type ??
        snapshot.coordinator_status?.status?.type ??
        snapshot.coordinator_status?.status ??
        "unknown",
      inbox_count: snapshot.counts?.inbox ?? 0,
      dispatch_queue_count: snapshot.counts?.dispatch_queue ?? 0,
      processed_count: snapshot.counts?.processed ?? 0,
      has_inflight: Boolean(inflight),
    };
    const summary = {
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      project_key: alphaProjectKey,
      attempts: [],
      verdict:
        final.inbox_count === 0 && final.dispatch_queue_count === 0 && !final.has_inflight
          ? "drained"
          : "residual_pending",
      final,
      origin: "offline_truth",
    };
    await writeAtomicJson(outputPath, summary);
    return { outputPath, summary, generated: true };
  }
}

const fixture = await readJson(path.join(stackDir, "churn_fixture.json"));
const { summaryPath, summary, generated: generatedSummary } = await ensureSummary(fixture);
const {
  outputPath: shutdownDrainPath,
  summary: shutdownDrain,
  generated: generatedShutdownDrain,
} = await ensureShutdownDrain(fixture);

const alphaTargetText = await readTextIfExists(fixture.projects.alpha.target_file);
const result = {
  ok: true,
  stack_dir: stackDir,
  metrics_dir: metricsDir,
  summary_path: summaryPath,
  shutdown_drain_path: shutdownDrainPath,
  generated_summary: generatedSummary,
  generated_shutdown_drain: generatedShutdownDrain,
  sample_count: summary.sample_count,
  duration_seconds: summary.duration_seconds,
  alpha_target_line_count: countNonEmptyLines(alphaTargetText),
  shutdown_drain_verdict: shutdownDrain.verdict,
};

console.log(JSON.stringify(result, null, 2));
