import fs from "node:fs/promises";
import path from "node:path";
import {
  JsonRpcWsClient,
  readTurnCount,
  runTurnAndRead,
} from "./lib/app_server_jsonrpc.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "conversation_bridge_thread_probe");
const projectRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects", "project-alpha");
const stateDir = path.join(projectRoot, "state");
const inboxDir = path.join(projectRoot, "inbox");
const summaryPath = path.join(verificationDir, "conversation_bridge_thread_probe_summary.json");
const eventsLogPath = path.join(verificationDir, "conversation_bridge_thread_probe_events.jsonl");
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";

const currentGoalRel = "verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/state/current_goal.md";
const roadmapStatusRel = "verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/state/roadmap_status.md";
const progressAxesRel = "verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/state/progress_axes.md";
const bindingRel = "verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/state/coordinator_binding.json";
const inboxFileName = "2026-03-26T23-50-00+09-00_bridge_intent.json";
const inboxRel = `verification/conversation_bridge_thread_probe/external-shared-memory/remodex/projects/project-alpha/inbox/${inboxFileName}`;

await fs.mkdir(verificationDir, { recursive: true });

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text);
}

async function readText(filePath) {
  return await fs.readFile(filePath, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```json\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : text.trim();
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  return JSON.parse(objectMatch[0]);
}

const summary = {
  wsUrl,
  startedAt: new Date().toISOString(),
  mainThreadId: null,
  bridgeThreadId: null,
  mainBefore: null,
  mainAfter: null,
  bridgeStatusTurn: null,
  bridgeIntentTurn: null,
  bridgeConfirmTurn: null,
  bridgeTurnCount: null,
};

let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.writeFile(eventsLogPath, "");

  await writeText(path.join(stateDir, "current_goal.md"), "goal: Fix login bug\n");
  await writeText(path.join(stateDir, "roadmap_status.md"), "current_point: integration-tests\n");
  await writeText(path.join(stateDir, "progress_axes.md"), "next_smallest_batch: run integration tests first\n");

  client = new JsonRpcWsClient(wsUrl, eventsLogPath);
  await client.connect();
  await client.initialize("conversation_bridge_thread_probe");

  const mainThreadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "conversation_bridge_main_probe",
  });
  const mainThreadId = mainThreadStart?.thread?.id ?? null;
  if (!mainThreadId) throw new Error("main thread id missing");
  summary.mainThreadId = mainThreadId;

  const mainSeed = await runTurnAndRead(
    client,
    mainThreadId,
    "Reply with exact text main-ready. Do not create or modify any files.",
  );
  await writeText(path.join(stateDir, "coordinator_status.md"), "type: idle\n");
  await writeText(path.join(stateDir, "operator_acl.md"), "approval_allow: ops-admin\nintent_allow: operator\n");
  await writeText(
    path.join(stateDir, "coordinator_binding.json"),
    `${JSON.stringify({ projectKey: "project-alpha", threadId: mainThreadId }, null, 2)}\n`,
  );
  summary.mainBefore = {
    turnCount: (mainSeed.threadRead?.thread?.turns ?? []).length,
    lastText: mainSeed.text,
  };

  const bridgeThreadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "conversation_bridge_operator_probe",
  });
  const bridgeThreadId = bridgeThreadStart?.thread?.id ?? null;
  if (!bridgeThreadId) throw new Error("bridge thread id missing");
  summary.bridgeThreadId = bridgeThreadId;

  const statusTurn = await runTurnAndRead(
    client,
    bridgeThreadId,
    `You are an operator-facing bridge thread for project-alpha. ` +
      `Read only ${currentGoalRel}, ${roadmapStatusRel}, and ${progressAxesRel}. ` +
      `Answer only with minified JSON having keys goal, roadmap_current_point, next_smallest_batch. ` +
      `Do not modify files and do not contact any other thread.`,
  );
  summary.bridgeStatusTurn = {
    turnId: statusTurn.turnId,
    text: statusTurn.text,
    parsed: extractJson(statusTurn.text),
  };

  const intentTurn = await runTurnAndRead(
    client,
    bridgeThreadId,
    `Record an operator intent for project-alpha. ` +
      `Create only ${inboxRel} with exact JSON {"workspace_key":"remodex","project_key":"project-alpha","route_decision":"inbox","correlation_key":"bridge-thread-intent-001","request":"prioritize integration tests first","source":"bridge_thread","target_thread":"${mainThreadId}"}. ` +
      `Do not modify any other file. Do not contact the main thread.`,
  );
  summary.bridgeIntentTurn = {
    turnId: intentTurn.turnId,
    text: intentTurn.text,
  };

  const confirmTurn = await runTurnAndRead(
    client,
    bridgeThreadId,
    `Read only ${inboxRel} and ${bindingRel}. ` +
      `Answer only with minified JSON having keys queued, route, target_thread, bridge_mode. ` +
      `If the inbox file exists, queued must be true and route must be "inbox". Do not modify files.`,
  );
  summary.bridgeConfirmTurn = {
    turnId: confirmTurn.turnId,
    text: confirmTurn.text,
    parsed: extractJson(confirmTurn.text),
  };

  const mainAfter = await readTurnCount(client, mainThreadId);
  const bridgeAfter = await readTurnCount(client, bridgeThreadId);
  const inboxRecord = await readJson(path.join(inboxDir, inboxFileName));

  summary.mainAfter = {
    turnCount: mainAfter.count,
  };
  summary.bridgeTurnCount = bridgeAfter.count;
  summary.inboxRecord = inboxRecord;
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.mainBefore.turnCount === 1 &&
    summary.mainAfter.turnCount === 1 &&
    summary.mainBefore.lastText?.trim() === "main-ready" &&
    summary.bridgeTurnCount === 3 &&
    summary.bridgeStatusTurn?.parsed?.goal === "Fix login bug" &&
    summary.bridgeStatusTurn?.parsed?.roadmap_current_point === "integration-tests" &&
    summary.bridgeStatusTurn?.parsed?.next_smallest_batch === "run integration tests first" &&
    inboxRecord?.correlation_key === "bridge-thread-intent-001" &&
    inboxRecord?.target_thread === mainThreadId &&
    summary.bridgeConfirmTurn?.parsed?.queued === true &&
    summary.bridgeConfirmTurn?.parsed?.route === "inbox" &&
    summary.bridgeConfirmTurn?.parsed?.target_thread === mainThreadId
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  summary.eventCounts = Object.fromEntries([...(client?.eventCounts ?? new Map()).entries()].sort());
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  client?.clearAllWaiters();
  client?.close();
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "conversation bridge thread probe failed");
}
