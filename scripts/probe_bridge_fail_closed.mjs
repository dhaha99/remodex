import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "bridge_fail_closed_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const quarantineDir = path.join(probeRoot, "router", "quarantine");
const summaryPath = path.join(verificationDir, "bridge_fail_closed_probe_summary.json");

await fs.mkdir(verificationDir, { recursive: true });

async function ensureDirs() {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(quarantineDir, { recursive: true });
}

async function failClosedDispatch() {
  const inboxFiles = (await fs.readdir(inboxDir)).filter((name) => name.endsWith(".json")).sort();
  if (inboxFiles.length === 0) {
    return { dispatched: false, reason: "no_inbox_files" };
  }

  const inboxFile = inboxFiles[0];
  const inboxPath = path.join(inboxDir, inboxFile);
  const event = JSON.parse(await fs.readFile(inboxPath, "utf8"));

  let binding = null;
  try {
    binding = JSON.parse(await fs.readFile(path.join(stateDir, "coordinator_binding.json"), "utf8"));
  } catch {
    binding = null;
  }

  if (!binding?.projectKey || !binding?.threadId) {
    const quarantinePath = path.join(quarantineDir, inboxFile);
    await fs.rename(inboxPath, quarantinePath);
    return { dispatched: false, reason: "missing_binding", quarantinePath };
  }

  if (binding.projectKey !== event.project_key) {
    const quarantinePath = path.join(quarantineDir, inboxFile);
    await fs.rename(inboxPath, quarantinePath);
    return { dispatched: false, reason: "binding_project_mismatch", quarantinePath };
  }

  return { dispatched: true, reason: "would_dispatch" };
}

const summary = {
  startedAt: new Date().toISOString(),
  missingBindingCase: null,
  mismatchedBindingCase: null,
};

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await ensureDirs();

  const firstInboxFile = "2026-03-25T13-30-00+09-00_missing_binding.json";
  await fs.writeFile(
    path.join(inboxDir, firstInboxFile),
    `${JSON.stringify({
      workspace_key: "remodex",
      project_key: "project-alpha",
      correlation_key: "fail-closed-001",
      operator_answer: "Answer for missing binding case",
    }, null, 2)}\n`,
  );
  summary.missingBindingCase = await failClosedDispatch();

  await ensureDirs();
  const secondInboxFile = "2026-03-25T13-31-00+09-00_project_mismatch.json";
  await fs.writeFile(
    path.join(stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ projectKey: "project-beta", threadId: "thread-beta-001" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(inboxDir, secondInboxFile),
    `${JSON.stringify({
      workspace_key: "remodex",
      project_key: "project-alpha",
      correlation_key: "fail-closed-002",
      operator_answer: "Answer for mismatched project case",
    }, null, 2)}\n`,
  );
  summary.mismatchedBindingCase = await failClosedDispatch();

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.missingBindingCase?.dispatched === false &&
    summary.missingBindingCase?.reason === "missing_binding" &&
    summary.mismatchedBindingCase?.dispatched === false &&
    summary.mismatchedBindingCase?.reason === "binding_project_mismatch"
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.status = "FAIL";
  summary.error = String(error);
  summary.finishedAt = new Date().toISOString();
  throw error;
} finally {
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
