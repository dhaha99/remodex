import fs from "node:fs/promises";
import path from "node:path";
import { acquireProcessSingletonLock } from "./lib/process_singleton_lock.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_gateway_singleton_lock_probe");
const lockPath = path.join(probeRoot, "discord_gateway_adapter.lock.json");
const summaryPath = path.join(verificationDir, "discord_gateway_singleton_lock_probe_summary.json");

const summary = {
  startedAt: new Date().toISOString(),
  firstAcquire: null,
  secondAcquire: null,
  thirdAcquire: null,
  verdict: "fail",
  blocker: null,
};

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(probeRoot, { recursive: true });

  const first = await acquireProcessSingletonLock(lockPath, {
    ownerPid: 11111,
    ownerLabel: "first",
    isPidAlive: async (pid) => pid === 11111,
  });
  summary.firstAcquire = {
    acquired: first.acquired,
    ownerPid: first.ownerPid,
  };
  if (!first.acquired) {
    throw new Error("first acquire did not succeed");
  }

  const second = await acquireProcessSingletonLock(lockPath, {
    ownerPid: 22222,
    ownerLabel: "second",
    isPidAlive: async (pid) => pid === 11111,
  });
  summary.secondAcquire = {
    acquired: second.acquired,
    existingPid: second.existingPid ?? null,
    existingLabel: second.existingLabel ?? null,
  };
  if (second.acquired || second.existingPid !== 11111) {
    throw new Error("second acquire did not see running owner");
  }

  await first.release();

  const third = await acquireProcessSingletonLock(lockPath, {
    ownerPid: 22222,
    ownerLabel: "second",
    isPidAlive: async () => false,
  });
  summary.thirdAcquire = {
    acquired: third.acquired,
    ownerPid: third.ownerPid,
  };
  if (!third.acquired) {
    throw new Error("third acquire did not succeed after release");
  }

  await third.release();

  summary.verdict = "pass";
} catch (error) {
  summary.blocker = error instanceof Error ? error.message : String(error);
}

summary.completedAt = new Date().toISOString();
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

if (summary.verdict !== "pass") {
  process.exitCode = 1;
}
