import fs from "node:fs/promises";
import path from "node:path";
import {
  createInitializedWsClient,
  readTurnCount,
  runTurnAndRead,
} from "./lib/app_server_jsonrpc.mjs";
import { DiscordConversationService } from "./lib/discord_conversation_service.mjs";
import { DiscordBridgeThreadService } from "./lib/discord_bridge_thread_service.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
  writeOutboxRecord,
} from "./lib/shared_memory_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_bridge_thread_conversation_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const workspaceKey = "remodex";
const projectKey = "project-bridge-chat";
const guildId = "guild-bridge-chat";
const channelId = "channel-bridge-chat";
const operatorId = "operator-bridge-chat";
const wsUrl = process.env.CODEX_APP_SERVER_WS_URL ?? "ws://127.0.0.1:4517";
const summaryPath = path.join(verificationDir, "discord_bridge_thread_conversation_probe_summary.json");
const appServerLogPath = path.join(verificationDir, "discord_bridge_thread_conversation_probe_events.jsonl");

function nowIso() {
  return new Date().toISOString();
}

function buildMessagePayload({ id, content }) {
  return {
    id,
    guild_id: guildId,
    channel_id: channelId,
    timestamp: nowIso(),
    type: 0,
    content,
    author: {
      id: operatorId,
      username: "operator",
      bot: false,
    },
    member: {
      user: {
        id: operatorId,
      },
      roles: [],
    },
    mentions: [],
  };
}

function countInboxRecords(paths) {
  return fs.readdir(paths.inboxDir).then((names) => names.filter((name) => name.endsWith(".json")).length);
}

class FakeChannelTransport {
  constructor() {
    this.messages = [];
  }

  async createChannelMessage(payload) {
    this.messages.push({
      observed_at: nowIso(),
      ...payload,
    });
    return { id: `fake-${this.messages.length}` };
  }
}

function isNaturalMessage(text) {
  const value = String(text ?? "");
  return Boolean(value) && !/route:|\/Users\/|router\/outbox|processed_receipt|turn:|correlation_key|json/i.test(value);
}

const summary = {
  wsUrl,
  startedAt: nowIso(),
};
const expectedMainThreadName = "너는 실제 실행을 담당하는 메인 스레드다";

let client = null;

try {
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.rm(probeRoot, { recursive: true, force: true });

  const projectPaths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  await ensureProjectDirs(projectPaths);

  client = await createInitializedWsClient(wsUrl, appServerLogPath, "probe_discord_bridge_thread_conversation");

  const mainThreadStart = await client.request("thread/start", {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "probe_discord_bridge_main",
  });
  const mainThreadId = mainThreadStart?.thread?.id ?? null;
  if (!mainThreadId) {
    throw new Error("main thread id missing");
  }
  summary.mainThreadId = mainThreadId;

  const mainSeed = await runTurnAndRead(
    client,
    mainThreadId,
    [
      "너는 실제 실행을 담당하는 메인 스레드다.",
      "이번 probe에서는 저장소를 수정하지 말고, 요청이 오면 아주 짧게만 응답해라.",
      "응답은 정확히 `main-ready` 한 줄만 출력해라.",
    ].join("\n"),
  );
  summary.mainSeed = {
    turnId: mainSeed.turnId,
    text: mainSeed.text,
  };

  await writeAtomicJson(path.join(projectPaths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: projectKey,
    display_name: "Quality Demo Bridge",
    aliases: ["quality-demo-bridge"],
    source_kind: "codex_thread_attach",
    attached_thread_id: mainThreadId,
    attached_thread_display_name: expectedMainThreadName,
    attached_workspace_label: path.basename(workspace),
    cwd: workspace,
  });
  await writeAtomicJson(path.join(projectPaths.stateDir, "coordinator_binding.json"), {
    workspace_key: workspaceKey,
    project_key: projectKey,
    threadId: mainThreadId,
  });
  await writeAtomicJson(path.join(projectPaths.stateDir, "coordinator_status.json"), {
    type: "idle",
  });
  await writeAtomicJson(path.join(projectPaths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: false,
  });
  await writeAtomicJson(path.join(projectPaths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(path.join(projectPaths.stateDir, "current_goal.md"), "현재 목표: 로그인 경로 확인\n");
  await writeAtomicText(path.join(projectPaths.stateDir, "progress_axes.md"), "next_smallest_batch: 로그인 테스트 우선\n");

  const runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath: appServerLogPath,
    appServerLogPath,
    workspaceCwd: workspace,
  });
  await runtime.writeChannelBinding({
    guildId,
    channelId,
    projectKey,
    operatorId,
  });

  const channelTransport = new FakeChannelTransport();
  const bridgeThreadService = new DiscordBridgeThreadService({
    runtime,
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath: appServerLogPath,
    workspaceCwd: workspace,
  });
  const conversationService = new DiscordConversationService({
    runtime,
    channelTransport,
    bridgeThreadService,
    sharedBase,
    workspaceKey,
    outboxPollIntervalMs: 60_000,
  });

  const statusBefore = await readTurnCount(client, mainThreadId);
  const statusOutcome = await conversationService.handleMessageCreate(
    buildMessagePayload({
      id: "msg-status-1",
      content: "지금 어디까지 했어?",
    }),
  );
  const bindingsAfterStatus = await runtime.readChannelBindings();
  const bindingKey = `${guildId}:${channelId}`;
  const bindingAfterStatus = bindingsAfterStatus[bindingKey] ?? null;
  if (!bindingAfterStatus?.bridge_thread_id) {
    throw new Error("bridge thread id missing after status conversation");
  }
  const bridgeAfterStatus = await readTurnCount(client, bindingAfterStatus.bridge_thread_id);
  const mainAfterStatus = await readTurnCount(client, mainThreadId);

  await runtime.patchChannelBinding({
    guildId,
    channelId,
    patch: {
      bridge_thread_id: "019ddead-dead-7bad-8bad-deadbeef0000",
      bridge_thread_status: "ready",
    },
  });

  const staleRecoveryOutcome = await conversationService.handleMessageCreate(
    buildMessagePayload({
      id: "msg-stale-recovery-1",
      content: "연결 상태 다시 알려줘",
    }),
  );
  const bindingsAfterRecovery = await runtime.readChannelBindings();
  const bindingAfterRecovery = bindingsAfterRecovery[bindingKey] ?? null;
  if (!bindingAfterRecovery?.bridge_thread_id) {
    throw new Error("bridge thread id missing after stale recovery");
  }
  if (bindingAfterRecovery.bridge_thread_id === "019ddead-dead-7bad-8bad-deadbeef0000") {
    throw new Error("stale bridge thread was not replaced");
  }
  const bridgeAfterRecovery = await readTurnCount(client, bindingAfterRecovery.bridge_thread_id);
  const mainAfterRecovery = await readTurnCount(client, mainThreadId);

  const identityOutcome = await conversationService.handleMessageCreate(
    buildMessagePayload({
      id: "msg-identity-1",
      content: "넌 지금 어느 메인 스레드랑 연결돼 있어?",
    }),
  );
  const bridgeAfterIdentity = await readTurnCount(client, bindingAfterStatus.bridge_thread_id);
  const mainAfterIdentity = await readTurnCount(client, mainThreadId);

  const intentOutcome = await conversationService.handleMessageCreate(
    buildMessagePayload({
      id: "msg-intent-1",
      content: "로그인 테스트부터 진행해",
    }),
  );
  const inboxFiles = (await fs.readdir(projectPaths.inboxDir)).filter((name) => name.endsWith(".json"));
  const inboxRecord =
    inboxFiles.length > 0
      ? await readJsonIfExists(path.join(projectPaths.inboxDir, inboxFiles.sort().at(-1)))
      : null;
  const bridgeAfterIntent = await readTurnCount(client, bindingAfterStatus.bridge_thread_id);
  const mainAfterIntent = await readTurnCount(client, mainThreadId);

  const processedRecord = {
    workspace_key: workspaceKey,
    project_key: projectKey,
    project_display_name: "Quality Demo Bridge",
    source_command_class: "intent",
    source_ref: "probe-processed-1",
    disposition: "consumed",
    final_text:
      "로그인 검토가 끝났습니다. /Users/example/path 는 숨겨져야 하고 router/outbox 링크도 보이면 안 됩니다. 다음은 버튼 정리입니다.",
  };
  await writeAtomicJson(
    path.join(projectPaths.processedDir, "2026-03-30T10-00-00.000Z_probe_processed.json"),
    processedRecord,
  );
  const processedDelivery = await conversationService.deliverProcessedReceipt(processedRecord, bindingsAfterStatus);

  const humanGateRecord = {
    workspace_key: workspaceKey,
    project_key: projectKey,
    type: "human_gate_notification",
    source_ref: "probe-human-gate-1",
    summary: {
      project_display_name: "Quality Demo Bridge",
      coordinator_status: "waiting_on_approval",
    },
    thread_id: mainThreadId,
  };
  const humanGateOutbox = await writeOutboxRecord(projectPaths, humanGateRecord);
  const humanGateDelivery = await conversationService.deliverOutboxRecord(humanGateRecord);
  const bridgeAfterNotifications = await readTurnCount(client, bindingAfterStatus.bridge_thread_id);

  const sentMessages = channelTransport.messages.map((entry) => entry.content);
  summary.statusOutcome = statusOutcome;
  summary.identityOutcome = identityOutcome;
  summary.intentOutcome = intentOutcome;
  summary.bindingAfterStatus = bindingAfterStatus;
  summary.staleRecoveryOutcome = staleRecoveryOutcome;
  summary.bindingAfterRecovery = bindingAfterRecovery;
  summary.processedDelivery = processedDelivery;
  summary.humanGateDelivery = humanGateDelivery;
  summary.humanGateOutbox = humanGateOutbox;
  summary.sentMessages = sentMessages;
  summary.inboxRecord = inboxRecord;
  summary.turnCounts = {
    main_before: statusBefore.count,
    main_after_status: mainAfterStatus.count,
    main_after_recovery: mainAfterRecovery.count,
    main_after_identity: mainAfterIdentity.count,
    main_after_intent: mainAfterIntent.count,
    bridge_after_status: bridgeAfterStatus.count,
    bridge_after_recovery: bridgeAfterRecovery.count,
    bridge_after_identity: bridgeAfterIdentity.count,
    bridge_after_intent: bridgeAfterIntent.count,
    bridge_after_notifications: bridgeAfterNotifications.count,
  };
  summary.finishedAt = nowIso();

  const passed =
    statusOutcome?.ignored === false &&
    identityOutcome?.ignored === false &&
    intentOutcome?.ignored === false &&
    bindingAfterStatus?.bridge_thread_id &&
    staleRecoveryOutcome?.ignored === false &&
    bindingAfterRecovery?.bridge_thread_id &&
    bridgeAfterStatus.count >= 2 &&
    bridgeAfterRecovery.count >= 2 &&
    mainAfterStatus.count === statusBefore.count &&
    mainAfterRecovery.count === statusBefore.count &&
    mainAfterIdentity.count === statusBefore.count &&
    mainAfterIntent.count === statusBefore.count &&
    inboxRecord?.project_key === projectKey &&
    /로그인 테스트/.test(String(inboxRecord?.request ?? "")) &&
    sentMessages.length >= 4 &&
    sentMessages.every((message) => isNaturalMessage(message)) &&
    sentMessages.some((message) => /현재 상태|로그인|대기열|전달/.test(message)) &&
    /현재|상태|대기|로그인/.test(String(statusOutcome?.response_text ?? "")) &&
    /연결|상태|메인/.test(String(staleRecoveryOutcome?.response_text ?? "")) &&
    String(identityOutcome?.response_text ?? "").includes(expectedMainThreadName) &&
    String(identityOutcome?.response_text ?? "").includes(String(mainThreadId).slice(0, 12)) &&
    String(identityOutcome?.response_text ?? "").includes(path.basename(workspace)) &&
    identityOutcome?.result?.bridge_thread_id === bindingAfterRecovery?.bridge_thread_id &&
    intentOutcome?.result?.bridge_thread_id === bindingAfterRecovery?.bridge_thread_id &&
    bridgeAfterNotifications.count >= 2 &&
    processedDelivery?.disposition === "delivered" &&
    humanGateDelivery?.disposition === "delivered";

  summary.status = passed ? "PASS" : "FAIL";

  await conversationService.stop();
  await runtime.close();
} catch (error) {
  summary.finishedAt = nowIso();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  client?.clearAllWaiters();
  client?.close();
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord bridge thread conversation probe failed");
}
