import fs from "node:fs/promises";
import path from "node:path";
import { BridgeRuntime } from "./lib/bridge_runtime.mjs";
import {
  JsonRpcWsClient,
  readTurnCount,
  runTurnAndRead,
} from "./lib/app_server_jsonrpc.mjs";
import {
  readInFlightDelivery,
  readJsonIfExists,
  writeInFlightDelivery,
  writeInboxEvent,
  writeAtomicJson,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "bridge_runtime_inflight_recovery_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const eventsLogPath = path.join(verificationDir, "bridge_runtime_inflight_recovery_probe_events.jsonl");
const summaryPath = path.join(verificationDir, "bridge_runtime_inflight_recovery_probe_summary.json");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const projectKey = "project-alpha";

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  threadId: null,
  seededTurn: null,
  inflightBefore: null,
  recoveryResult: null,
  inflightAfter: null,
  turnCountBefore: null,
  turnCountAfter: null,
  receipt: null,
  inboxExistsAfter: null,
};

let client = null;
let runtime = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");

  runtime = await BridgeRuntime.forProject({
    sharedBase,
    workspaceKey: "remodex",
    projectKey,
    wsUrl,
    logPath: eventsLogPath,
    serviceName: "bridge_runtime_inflight_recovery_probe",
    processedBy: "bridge_runtime_inflight_recovery_probe",
  });

  await writeAtomicJson(path.join(runtime.paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
    foreground_lock_enabled: false,
  });
  await writeAtomicJson(path.join(runtime.paths.stateDir, "coordinator_status.json"), {
    type: "checkpoint_open",
  });
  await fs.writeFile(
    path.join(runtime.paths.stateDir, "operator_acl.md"),
    "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n",
  );

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("bridge_runtime_inflight_recovery_probe_owner");

  const threadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    serviceName: "bridge_runtime_inflight_recovery_probe_owner",
  });
  const threadId = threadStart?.thread?.id ?? null;
  if (!threadId) throw new Error("thread id missing");
  summary.threadId = threadId;

  await writeAtomicJson(path.join(runtime.paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId,
  });

  const eventRecord = {
    workspace_key: "remodex",
    project_key: projectKey,
    command_class: "reply",
    type: "operator_reply",
    source_ref: "inflight-recovery-source-001",
    correlation_key: "inflight-recovery-correlation-001",
    operator_answer: "Reply with exact text inflight-recovery-ok and do nothing else.",
    received_at: new Date().toISOString(),
  };
  const inboxWrite = await writeInboxEvent(runtime.paths, eventRecord);

  const seededTurn = await runTurnAndRead(client, threadId, eventRecord.operator_answer, 120_000);
  summary.seededTurn = {
    turnId: seededTurn.turnId,
    finalText: seededTurn.text,
    turnStartAttempts: seededTurn.turnStartAttempts,
  };

  summary.turnCountBefore = await readTurnCount(client, threadId);
  await writeInFlightDelivery(runtime.paths, {
    workspace_key: "remodex",
    project_key: projectKey,
    source_ref: eventRecord.source_ref,
    correlation_key: eventRecord.correlation_key,
    command_class: eventRecord.command_class,
    source_path: inboxWrite.filePath,
    operator_answer: eventRecord.operator_answer,
    thread_id: threadId,
    turn_id: seededTurn.turnId,
    origin: "direct_delivery",
    started_at: new Date().toISOString(),
    turn_start_attempts: seededTurn.turnStartAttempts,
    record: eventRecord,
  });
  summary.inflightBefore = await readInFlightDelivery(runtime.paths);

  summary.recoveryResult = await runtime.deliverNextInbox();
  summary.turnCountAfter = await readTurnCount(client, threadId);
  summary.inflightAfter = await readInFlightDelivery(runtime.paths);
  summary.inboxExistsAfter = Boolean(await readJsonIfExists(inboxWrite.filePath));

  const processedFiles = (await fs.readdir(runtime.paths.processedDir)).sort();
  if (processedFiles.length > 0) {
    const receiptPath = path.join(runtime.paths.processedDir, processedFiles[0]);
    summary.receipt = {
      filePath: receiptPath,
      record: await readJsonIfExists(receiptPath),
    };
  }

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.seededTurn?.finalText === "inflight-recovery-ok" &&
    summary.inflightBefore?.turn_id === seededTurn.turnId &&
    summary.recoveryResult?.delivery_decision === "completed_inflight" &&
    summary.turnCountBefore?.count === summary.turnCountAfter?.count &&
    summary.inflightAfter === null &&
    summary.inboxExistsAfter === false &&
    summary.receipt?.record?.recovered_from_inflight === true &&
    summary.receipt?.record?.turn_id === seededTurn.turnId
      ? "PASS"
      : "FAIL";

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
} finally {
  await runtime?.close();
  client?.clearAllWaiters();
  client?.close();
}
