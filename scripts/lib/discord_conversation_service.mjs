import path from "node:path";
import {
  discordMessageMentionsBot,
  normalizeDiscordMessageCreate,
} from "./discord_transport.mjs";
import {
  buildProjectPaths,
  listProjectKeys,
  listFilesSafe,
  readJsonIfExists,
  writeAtomicJson,
} from "./shared_memory_runtime.mjs";
import { renderGatewayOperatorMessage } from "./discord_gateway_operator_responder.mjs";

const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 2000;
const SUPPORTED_MESSAGE_TYPES = new Set([0, 19]);

function nowIso() {
  return new Date().toISOString();
}

function channelBindingKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function uniqueChannels(bindings, projectKey) {
  const seen = new Set();
  return Object.values(bindings)
    .filter((binding) => binding?.project_key === projectKey)
    .filter((binding) => {
      const key = channelBindingKey(binding.guild_id, binding.channel_id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function uniqueProjectKeys(bindings) {
  return [...new Set(Object.values(bindings).map((binding) => binding?.project_key).filter(Boolean))];
}

function isIgnorableConversationText(content) {
  const text = String(content ?? "").trim();
  if (!text) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s!?.,~]+$/u.test(text)) return true;
  const lower = text.toLowerCase();
  return [
    "고마워",
    "감사",
    "감사합니다",
    "thanks",
    "thank you",
    "thx",
    "ok",
    "okay",
    "ㅇㅋ",
    "오케이",
    "좋아",
    "굿",
  ].includes(lower);
}

function renderConversationHelp() {
  return [
    "이 채널은 아직 프로젝트에 연결되지 않았습니다.",
    "먼저 `/projects`로 프로젝트를 고르거나 `/attach-thread`로 기존 Codex 스레드를 연결하세요.",
  ].join("\n");
}

function renderHumanGateNotification(record) {
  const projectLabel = record.summary?.project_display_name ?? record.project_key ?? "현재 프로젝트";
  const lines = [`${projectLabel}에서 승인 확인이 필요합니다.`];
  lines.push(`상태: ${record.summary?.coordinator_status ?? "waiting_on_approval"}`);
  if (record.thread_id) {
    lines.push(`thread: ${String(record.thread_id).slice(0, 12)}`);
  }
  lines.push("이 채널에서 `지금 어디까지 했어?`라고 물어보거나 앱에서 foreground 승인 흐름을 이어가면 됩니다.");
  return lines.join("\n");
}

function renderStatusLabel(status) {
  const value = String(status ?? "unknown").trim();
  if (!value) return "unknown";
  if (value === "notLoaded") return "저장됨(notLoaded)";
  if (value === "idle") return "대기";
  if (value === "active") return "작업 중";
  if (value === "waitingOnApproval" || value === "waiting_on_approval") return "승인 대기";
  if (value === "waitingOnUserInput" || value === "waiting_on_user_input") return "입력 대기";
  return value;
}

function mapDeliveryDecision(decision) {
  if (decision === "delivered") return "바로 전달됐습니다.";
  if (decision === "scheduled_delivery") return "전달을 시작했습니다.";
  if (decision === "deferred") return "지금은 바로 못 넘겨서 대기열에 올렸습니다.";
  if (decision === "await_human_gate") return "사람 확인이 필요한 lane으로 보류했습니다.";
  if (decision === "blocked") return "현재 조건 때문에 보류됐습니다.";
  return "기록은 됐고 후속 상태를 다시 확인할 수 있습니다.";
}

function explainQuarantineReason(reason) {
  if (reason === "missing_project") return "어느 프로젝트에 붙여야 할지 아직 결정되지 않았습니다.";
  if (reason?.startsWith("missing_role:")) return "이 요청을 처리할 권한이 부족합니다.";
  if (reason === "project_mismatch") return "현재 채널과 다른 프로젝트로 해석돼 차단됐습니다.";
  return `차단 사유: ${reason ?? "unknown"}`;
}

function summarizeFinalText(finalText, maxLength = 320) {
  const raw = String(finalText ?? "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\/Users\/[^\s)]+/g, "")
    .replace(/\s+/g, " ");

  const specialCases = [
    {
      match: /아직\s*실제\s*작업\s*응답은?\s*안\s*왔습니다/,
      text: "아직 실제 작업 결과는 오지 않았습니다.",
    },
    {
      match: /승인\s*확인(이)?\s*필요/,
      text: "승인 확인이 필요한 상태입니다.",
    },
  ];
  for (const candidate of specialCases) {
    if (candidate.match.test(cleaned)) {
      return candidate.text;
    }
  }

  const sentences = cleaned
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。])\s+/))
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.length >= 6)
    .filter((line) => !/^(-|\*|\u2022)\s*/.test(line))
    .filter((line) => !/^(근거|현재 상태|즉 한 줄로 말하면|원하면)\s*:?/.test(line))
    .filter((line) => !/(router\/outbox|processed|status_response_|jsonl|\.json\b)/.test(line))
    .filter((line) => !/^thread:\s*/i.test(line));

  const first = sentences[0] ?? null;
  if (!first) return null;
  if (first.length <= maxLength) return first;
  return `${first.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderProcessedReceiptNotification(record) {
  const projectLabel = record.project_display_name ?? record.project_key ?? "현재 프로젝트";
  const lines = [`${projectLabel} 응답이 도착했습니다.`];
  const summary = summarizeFinalText(record.final_text);
  if (summary) {
    lines.push(`요약: ${summary}`);
  }
  lines.push("필요하면 이 채널에서 `지금 어디까지 했어?`라고 물어 최신 상태를 다시 확인할 수 있습니다.");
  return lines.join("\n");
}

function renderConversationMessage({ normalized, result }) {
  const projectLabel =
    result.summary?.project_display_name ??
    result.project_display_name ??
    result.project?.display_name ??
    result.project_key ??
    normalized.project_key ??
    "현재 프로젝트";

  if (result.route === "project_required" || result.route === "unknown_project") {
    return renderConversationHelp();
  }

  if (result.route === "quarantine") {
    return [
      `${projectLabel} 요청을 바로 넘기지 못했습니다.`,
      explainQuarantineReason(result.quarantine_reason),
      "필요하면 `/projects`로 프로젝트를 다시 맞추거나, 권한이 필요한 요청이면 앱에서 처리하세요.",
    ].join("\n");
  }

  if (normalized.command_class === "status" && result.route === "status") {
    const summary = result.summary ?? {};
    const lines = [`${projectLabel} 현재 상태입니다.`];
    lines.push(`상태: ${renderStatusLabel(summary.attached_thread_status ?? summary.coordinator_status)}`);
    if (summary.next_smallest_batch) {
      lines.push(`다음: ${summary.next_smallest_batch}`);
    }
    lines.push(`승인 대기: ${summary.human_gate_candidate_count ?? 0}`);
    lines.push(`대기 요청: ${summary.dispatch_queue_count ?? 0}`);
    return lines.join("\n");
  }

  if (normalized.command_class === "set-mode") {
    if (result.route === "project_mode_updated") {
      const lines = [
        `${projectLabel} 모드를 ${result.mode_target === "background" ? "백그라운드" : "foreground"}로 바꿨습니다.`,
      ];
      if (result.mode_target === "background") {
        lines.push(
          result.scheduler_gate?.ready
            ? "scheduler는 지금 동작 가능한 상태입니다."
            : `scheduler는 아직 막혀 있습니다. (${(result.scheduler_gate?.reasons ?? []).join(", ") || "이유 미확인"})`,
        );
      } else {
        lines.push("이제 이 채널의 요청은 foreground 기준으로 이어집니다.");
      }
      return lines.join("\n");
    }
    return renderGatewayOperatorMessage({ normalized, result });
  }

  if (result.route === "channel_binding") {
    return [
      `${projectLabel}에 이 채널을 연결했습니다.`,
      "이제 여기서 `지금 어디까지 했어?`, `로그인 테스트부터 진행해`처럼 자연어로 말해도 됩니다.",
    ].join("\n");
  }

  if (result.route === "human_gate_candidate") {
    return [
      `${projectLabel} 승인 후보를 기록했습니다.`,
      "foreground에서 승인 흐름을 이어가야 합니다. 필요하면 이 채널에서 현재 상태를 다시 물어보세요.",
    ].join("\n");
  }

  if (result.route === "inbox") {
    const subject = normalized.command_class === "reply" ? "답변" : "작업 요청";
    return [
      `${projectLabel}에 ${subject}을 기록했습니다.`,
      `처리 상태: ${mapDeliveryDecision(result.delivery_decision)}`,
      "필요하면 이 채널에서 `지금 어디까지 했어?`라고 물어 최신 상태를 다시 확인할 수 있습니다.",
    ].join("\n");
  }

  return renderGatewayOperatorMessage({ normalized, result });
}

export class DiscordConversationService {
  constructor({
    runtime,
    channelTransport,
    bridgeThreadService = null,
    sharedBase,
    workspaceKey,
    outboxPollIntervalMs = DEFAULT_OUTBOX_POLL_INTERVAL_MS,
    messageContentMode = "full",
    onEvent = null,
  }) {
    this.runtime = runtime;
    this.channelTransport = channelTransport;
    this.bridgeThreadService = bridgeThreadService;
    this.sharedBase = sharedBase;
    this.workspaceKey = workspaceKey;
    this.outboxPollIntervalMs = outboxPollIntervalMs;
    this.messageContentMode = messageContentMode;
    this.onEvent = onEvent;
    this.botUserId = null;
    this.outboxDir = path.join(this.sharedBase, this.workspaceKey, "router", "outbox");
    this.outboxStatePath = path.join(
      this.sharedBase,
      this.workspaceKey,
      "router",
      "discord_channel_delivery_state.json",
    );
    this.pollTimer = null;
    this.pollInFlight = false;
  }

  setBotIdentity(user) {
    this.botUserId = user?.id ? String(user.id) : null;
  }

  setMessageContentMode(mode) {
    this.messageContentMode = mode === "mention_only" ? "mention_only" : "full";
  }

  async start() {
    if (this.pollTimer) return;
    await this.seedDeliveryStateIfNeeded();
    this.pollTimer = setInterval(() => {
      void this.pollNotifications().catch(() => {});
    }, this.outboxPollIntervalMs);
    if (typeof this.pollTimer.unref === "function") {
      this.pollTimer.unref();
    }
  }

  async stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async handleDispatch(eventType, payload) {
    if (eventType !== "MESSAGE_CREATE") return null;
    return await this.handleMessageCreate(payload);
  }

  async handleMessageCreate(payload) {
    if (!payload?.guild_id || !payload?.channel_id) {
      return { ignored: true, reason: "non_guild_message" };
    }
    if (payload.author?.bot) {
      return { ignored: true, reason: "bot_message" };
    }
    if (payload.type != null && !SUPPORTED_MESSAGE_TYPES.has(payload.type)) {
      return { ignored: true, reason: "unsupported_message_type" };
    }

    const content = String(payload.content ?? "").trim();
    const mentionedBot = discordMessageMentionsBot(payload, this.botUserId);
    const bindings = await this.runtime.readChannelBindings();
    const binding = bindings[channelBindingKey(payload.guild_id, payload.channel_id)] ?? null;
    const catalog = binding ? null : await this.runtime.listProjectCatalog();
    const canUseSingleProjectDefault = !binding && (catalog?.length ?? 0) === 1;

    if (!binding && !canUseSingleProjectDefault && !mentionedBot) {
      return { ignored: true, reason: "unbound_channel_without_mention" };
    }
    if (!content && this.messageContentMode === "mention_only" && (binding || mentionedBot)) {
      const responseText = [
        "현재 Discord 앱에서 Message Content intent가 꺼져 있어 평문 메시지를 읽지 못합니다.",
        "Developer Portal에서 Message Content intent를 켜거나, 당장은 slash command와 버튼을 사용하세요.",
      ].join("\n");
      await this.channelTransport.createChannelMessage({
        channelId: payload.channel_id,
        content: responseText,
        messageReference: {
          message_id: payload.id,
          channel_id: payload.channel_id,
          guild_id: payload.guild_id,
        },
      });
      await this.emitEvent({
        type: "conversation_message_content_unavailable",
        observed_at: nowIso(),
        channel_id: payload.channel_id,
        guild_id: payload.guild_id,
        message_id: payload.id,
        project_key: binding?.project_key ?? null,
      });
      return {
        ignored: false,
        reason: "message_content_unavailable",
        response_text: responseText,
      };
    }
    if (isIgnorableConversationText(content)) {
      return { ignored: true, reason: "ignorable_text" };
    }

    const normalized = normalizeDiscordMessageCreate(payload, this.workspaceKey, {
      botUserId: this.botUserId,
    });
    if (!normalized) {
      return { ignored: true, reason: "message_not_normalized" };
    }

    let outcome = null;
    let result = null;
    let responseText = null;

    const useBridgeThread = Boolean(binding && this.bridgeThreadService);

    if (useBridgeThread) {
      try {
        const bridgeOutcome = await this.bridgeThreadService.handleBoundMessage({
          payload,
          binding,
        });
        result = {
          route: bridgeOutcome.route,
          project_key: bridgeOutcome.project_key,
          delivery_decision: bridgeOutcome.handoff_result?.delivery_decision ?? null,
          bridge_thread_id: bridgeOutcome.bridge_thread_id,
          bridge_turn_id: bridgeOutcome.bridge_turn_id,
          bridge_action: bridgeOutcome.bridge_action,
          bridge_repaired: bridgeOutcome.bridge_repaired === true,
          bridge_fallback_used: bridgeOutcome.bridge_fallback_used === true,
        };
        outcome = {
          normalized: {
            ...normalized,
            project_key: bridgeOutcome.project_key ?? normalized.project_key,
          },
          result,
        };
        responseText = bridgeOutcome.operator_response;
      } catch (error) {
        await this.emitEvent({
          type: "conversation_bridge_thread_error",
          observed_at: nowIso(),
          channel_id: payload.channel_id,
          guild_id: payload.guild_id,
          message_id: payload.id,
          project_key: binding.project_key ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        outcome = await this.runtime.handleNormalizedCommand(normalized);
        result = outcome.result ?? {};
        responseText = renderConversationMessage({
          normalized,
          result,
        });
      }
    } else {
      outcome = await this.runtime.handleNormalizedCommand(normalized);
      result = outcome.result ?? {};

      if (result.route === "project_required" || result.route === "unknown_project") {
        responseText = renderConversationHelp();
      } else {
        responseText = renderConversationMessage({
          normalized,
          result,
        });
      }
    }

    await this.channelTransport.createChannelMessage({
      channelId: payload.channel_id,
      content: responseText,
      messageReference: {
        message_id: payload.id,
        channel_id: payload.channel_id,
        guild_id: payload.guild_id,
      },
    });

    await this.emitEvent({
      type: "conversation_message_reply",
      observed_at: nowIso(),
      channel_id: payload.channel_id,
      guild_id: payload.guild_id,
      message_id: payload.id,
      command_class: normalized.command_class,
      project_key: result.project_key ?? outcome?.normalized?.project_key ?? normalized.project_key ?? null,
      route: result.route ?? null,
      delivery_decision: result.delivery_decision ?? null,
      bridge_thread_id: result.bridge_thread_id ?? null,
      bridge_turn_id: result.bridge_turn_id ?? null,
      bridge_action: result.bridge_action ?? null,
      bridge_repaired: result.bridge_repaired ?? false,
      bridge_fallback_used: result.bridge_fallback_used ?? false,
    });

    return {
      ignored: false,
      normalized,
      result,
      response_text: responseText,
    };
  }

  async seedDeliveryStateIfNeeded() {
    const existing = await readJsonIfExists(this.outboxStatePath);
    if (existing?.records && existing?.processed_records) return existing;
    const fileNames = await listFilesSafe(this.outboxDir, ".json");
    const records = {};
    const processedRecords = existing?.processed_records ?? {};
    const seededAt = nowIso();
    for (const fileName of fileNames) {
      records[fileName] = {
        disposition: "seeded_existing",
        observed_at: seededAt,
      };
    }
    const projectKeys = await listProjectKeys(this.sharedBase, this.workspaceKey);
    for (const projectKey of projectKeys) {
      const paths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey,
      });
      const processedFiles = await listFilesSafe(paths.processedDir, ".json");
      for (const fileName of processedFiles) {
        processedRecords[`${projectKey}/${fileName}`] = {
          disposition: "seeded_existing",
          observed_at: seededAt,
        };
      }
    }
    const state = { seeded_at: seededAt, records, processed_records: processedRecords };
    await writeAtomicJson(this.outboxStatePath, state);
    return state;
  }

  async pollNotifications() {
    if (this.pollInFlight) return null;
    this.pollInFlight = true;
    try {
      const state = (await readJsonIfExists(this.outboxStatePath)) ?? { records: {}, processed_records: {} };
      state.records ??= {};
      state.processed_records ??= {};
      const fileNames = await listFilesSafe(this.outboxDir, ".json");
      for (const fileName of fileNames) {
        if (state.records?.[fileName]) continue;
        const record = await readJsonIfExists(path.join(this.outboxDir, fileName));
        if (!record) {
          state.records[fileName] = {
            disposition: "missing_or_invalid",
            observed_at: nowIso(),
          };
          continue;
        }
        const delivery = await this.deliverOutboxRecord(record);
        state.records[fileName] = {
          observed_at: nowIso(),
          ...delivery,
        };
      }
      await this.pollProcessedNotifications(state);
      await writeAtomicJson(this.outboxStatePath, state);
      return state;
    } finally {
      this.pollInFlight = false;
    }
  }

  async pollProcessedNotifications(state) {
    const bindings = await this.runtime.readChannelBindings();
    const projectKeys = uniqueProjectKeys(bindings);
    for (const projectKey of projectKeys) {
      const paths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey,
      });
      const fileNames = await listFilesSafe(paths.processedDir, ".json");
      for (const fileName of fileNames) {
        const stateKey = `${projectKey}/${fileName}`;
        if (state.processed_records?.[stateKey]) continue;
        const record = await readJsonIfExists(path.join(paths.processedDir, fileName));
        if (!record) {
          state.processed_records[stateKey] = {
            disposition: "missing_or_invalid",
            observed_at: nowIso(),
          };
          continue;
        }
        const delivery = await this.deliverProcessedReceipt(record, bindings);
        state.processed_records[stateKey] = {
          observed_at: nowIso(),
          ...delivery,
        };
      }
    }
  }

  async deliverOutboxRecord(record) {
    if (record.type !== "human_gate_notification") {
      return {
        disposition: "ignored_type",
        type: record.type ?? null,
      };
    }
    const bindings = await this.runtime.readChannelBindings();
    const channels = uniqueChannels(bindings, record.project_key);
    if (!channels.length) {
      return {
        disposition: "no_bound_channels",
        project_key: record.project_key ?? null,
      };
    }
    for (const binding of channels) {
      let content = renderHumanGateNotification(record);
      if (this.bridgeThreadService) {
        try {
          const bridged = await this.bridgeThreadService.summarizeNotification({
            binding,
            kind: "human_gate",
            payloadText: content,
          });
          if (bridged?.operator_response) {
            content = bridged.operator_response;
          }
        } catch {
          // Fall back to static notification text when bridge summarization is unavailable.
        }
      }
      await this.channelTransport.createChannelMessage({
        channelId: binding.channel_id,
        content,
      });
    }
    await this.emitEvent({
      type: "outbox_notification_sent",
      observed_at: nowIso(),
      project_key: record.project_key ?? null,
      source_ref: record.source_ref ?? null,
      channel_ids: channels.map((binding) => binding.channel_id),
      outbox_type: record.type ?? null,
    });
    return {
      disposition: "delivered",
      project_key: record.project_key ?? null,
      channel_ids: channels.map((binding) => binding.channel_id),
      type: record.type ?? null,
    };
  }

  async deliverProcessedReceipt(record, bindings) {
    if (["status", "conversation-status"].includes(String(record.source_command_class ?? ""))) {
      return {
        disposition: "ignored_status_receipt",
        project_key: record.project_key ?? null,
        processed_source_ref: record.source_ref ?? null,
      };
    }
    if (!record.project_display_name && record.project_key) {
      const projectPaths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey: record.project_key,
      });
      const identity = await readJsonIfExists(path.join(projectPaths.stateDir, "project_identity.json"));
      if (identity?.display_name) {
        record = {
          ...record,
          project_display_name: identity.display_name,
        };
      }
    }
    const channels = uniqueChannels(bindings, record.project_key);
    if (!channels.length) {
      return {
        disposition: "no_bound_channels",
        project_key: record.project_key ?? null,
      };
    }
    for (const binding of channels) {
      let content = renderProcessedReceiptNotification(record);
      if (this.bridgeThreadService) {
        try {
          const bridged = await this.bridgeThreadService.summarizeNotification({
            binding,
            kind: "processed_receipt",
            payloadText: content,
          });
          if (bridged?.operator_response) {
            content = bridged.operator_response;
          }
        } catch {
          // Keep static summary when bridge summarization is unavailable.
        }
      }
      await this.channelTransport.createChannelMessage({
        channelId: binding.channel_id,
        content,
      });
    }
    await this.emitEvent({
      type: "processed_notification_sent",
      observed_at: nowIso(),
      project_key: record.project_key ?? null,
      source_ref: record.source_ref ?? null,
      channel_ids: channels.map((binding) => binding.channel_id),
      disposition: record.disposition ?? null,
    });
    return {
      disposition: "delivered",
      project_key: record.project_key ?? null,
      channel_ids: channels.map((binding) => binding.channel_id),
      processed_source_ref: record.source_ref ?? null,
    };
  }

  async emitEvent(event) {
    if (typeof this.onEvent !== "function") return;
    await this.onEvent(event);
  }
}
