import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInitializedWsClient,
  readThreadWithTurns,
  runTurnAndRead,
} from "./app_server_jsonrpc.mjs";
import {
  buildProjectPaths,
  listFilesSafe,
  readJsonIfExists,
} from "./shared_memory_runtime.mjs";

function nowIso() {
  return new Date().toISOString();
}

const GUIDEBOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "DISCORD_BRIDGE_THREAD_GUIDEBOOK.md",
);

function channelBindingKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function shortId(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 12) : null;
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function visibleText(value) {
  return collapseWhitespace(
    String(value ?? "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/["']/g, ""),
  );
}

function summarizeText(value, maxLength = 220) {
  const text = collapseWhitespace(value)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\/Users\/[^\s)]+/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = String(text).match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : String(text);
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (!objectMatch) return null;
  try {
    return JSON.parse(objectMatch[0]);
  } catch {
    return null;
  }
}

const INTERNAL_LEAK_PATTERNS = [
  /\/Users\//i,
  /router\/|outbox|inbox|processed|jsonl?|correlation_key|delivery_decision|command_class|auth_class|source_ref|raw_guild_id|raw_channel_id/i,
  /\broute\s*:/i,
  /\bturn\s*:/i,
  /\bproject_key\b/i,
  /\bmain coordinator state refresh\b/i,
];

const IDENTITY_PATTERNS = [
  /어느\s*스레드/,
  /무슨\s*스레드/,
  /어디.*연결/,
  /누구랑.*연결/,
  /뭐랑.*연결/,
  /어느\s*프로젝트/,
  /지금\s*누구/,
];

const STATUS_PATTERNS = [
  /지금\s*어디까지/,
  /현재\s*상태/,
  /진행\s*상황/,
  /어디까지\s*했/,
  /왜\s*막혔/,
  /뭐\s*하고\s*있/,
];

const BACKGROUND_PATTERNS = [
  /백그라운드/,
  /스케줄러/,
  /cron/i,
  /야간\s*모드/,
];

const FOREGROUND_PATTERNS = [
  /앱\s*복귀/,
  /foreground/i,
  /포그라운드/,
  /수동\s*모드/,
];

const WORK_REQUEST_PATTERNS = [
  /진행해/,
  /확인해/,
  /조사해/,
  /검토해/,
  /수정해/,
  /고쳐/,
  /테스트해/,
  /실행해/,
  /해줘/,
  /봐줘/,
  /부탁해/,
];

function humanStatusLabel(status) {
  const value = String(status ?? "").trim();
  if (!value) return "unknown";
  if (value === "notLoaded") return "저장됨";
  if (value === "idle") return "대기";
  if (value === "active") return "작업 중";
  if (value === "waitingOnApproval" || value === "waiting_on_approval") return "승인 대기";
  if (value === "waitingOnUserInput" || value === "waiting_on_user_input") return "입력 대기";
  return value;
}

function classifyOperatorNeed(message) {
  const text = visibleText(message);
  return {
    identity: IDENTITY_PATTERNS.some((pattern) => pattern.test(text)),
    status: STATUS_PATTERNS.some((pattern) => pattern.test(text)),
    background: BACKGROUND_PATTERNS.some((pattern) => pattern.test(text)),
    foreground: FOREGROUND_PATTERNS.some((pattern) => pattern.test(text)),
    workRequest:
      WORK_REQUEST_PATTERNS.some((pattern) => pattern.test(text)) &&
      !STATUS_PATTERNS.some((pattern) => pattern.test(text)) &&
      !IDENTITY_PATTERNS.some((pattern) => pattern.test(text)) &&
      !BACKGROUND_PATTERNS.some((pattern) => pattern.test(text)) &&
      !FOREGROUND_PATTERNS.some((pattern) => pattern.test(text)),
  };
}

function describeStatusExpectation(status) {
  const label = humanStatusLabel(status);
  if (label === "unknown") return [];
  if (label === "저장됨") return ["저장", "불러", "로드"];
  if (label === "대기") return ["대기", "멈춰", "준비"];
  if (label === "작업 중") return ["작업", "진행", "처리"];
  if (label === "승인 대기") return ["승인", "대기", "확인"];
  if (label === "입력 대기") return ["입력", "대기", "답변"];
  return [label];
}

function hasInternalLeak(text) {
  const value = String(text ?? "");
  return INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(value));
}

function containsAnyKeyword(text, keywords) {
  const value = visibleText(text).toLowerCase();
  return keywords.some((keyword) => value.includes(String(keyword).toLowerCase()));
}

function buildBridgeFacts({ projectDisplayName, projectKey, summary, snapshot, bridgeThreadId }) {
  return {
    projectDisplayName,
    projectKey,
    bridgeThreadShortId: shortId(bridgeThreadId),
    mainThreadShortId: shortId(summary.attached_thread_id) ?? shortId(snapshot?.coordinator_binding?.threadId),
    mainThreadName: summary.attached_thread_name ?? null,
    workspaceLabel: summary.attached_workspace_label ?? null,
    status: summary.attached_thread_status ?? summary.coordinator_status ?? null,
    nextSmallestBatch: summary.next_smallest_batch ?? null,
    backgroundMode:
      summary.background_trigger_enabled === true && summary.foreground_session_active !== true
        ? "background"
        : summary.foreground_session_active
          ? "foreground"
          : "manual",
  };
}

function validateBridgeDecision({
  phase,
  decision,
  operatorMessage = "",
  kind = null,
  facts,
  handoffResult = null,
}) {
  const blockers = [];
  const response = visibleText(decision?.operator_response);
  const request = visibleText(decision?.request);
  const action = String(decision?.action ?? "none");

  if (!response) blockers.push("operator_response_missing");
  if (response && hasInternalLeak(response)) blockers.push("operator_response_internal_leak");
  if (response && response.length > 420) blockers.push("operator_response_too_long");

  if (phase === "planning") {
    const need = classifyOperatorNeed(operatorMessage);
    if (need.identity) {
      if (facts.projectDisplayName && !visibleText(response).includes(visibleText(facts.projectDisplayName))) {
        blockers.push("identity_missing_project_display_name");
      }
      if (facts.mainThreadName && !visibleText(response).includes(visibleText(facts.mainThreadName))) {
        blockers.push("identity_missing_main_thread_name");
      }
      if (facts.mainThreadShortId && !visibleText(response).includes(visibleText(facts.mainThreadShortId))) {
        blockers.push("identity_missing_main_thread_short_id");
      }
      if (facts.workspaceLabel && !visibleText(response).includes(visibleText(facts.workspaceLabel))) {
        blockers.push("identity_missing_workspace_label");
      }
      if (action !== "none") blockers.push("identity_should_not_handoff");
    }
    if (need.status) {
      const expectedKeywords = describeStatusExpectation(facts.status);
      if (expectedKeywords.length && !containsAnyKeyword(response, expectedKeywords)) {
        blockers.push("status_missing_current_state_hint");
      }
    }
    if (need.background && action !== "set_mode_background") {
      blockers.push("background_request_wrong_action");
    }
    if (need.foreground && action !== "set_mode_foreground") {
      blockers.push("foreground_request_wrong_action");
    }
    if (need.workRequest && action !== "handoff_intent") {
      blockers.push("work_request_not_handed_off");
    }
    if (action === "handoff_intent" || action === "handoff_reply") {
      if (!request) blockers.push("handoff_request_missing");
      if (request && hasInternalLeak(request)) blockers.push("handoff_request_internal_leak");
      if (request && request.length < 5) blockers.push("handoff_request_too_short");
    }
  }

  if (phase === "outcome") {
    if (action !== "none") blockers.push("outcome_action_must_be_none");
    if (handoffResult?.mode_target === "background" && !containsAnyKeyword(response, ["백그라운드", "스케줄러"])) {
      blockers.push("outcome_missing_background_context");
    }
    if (handoffResult?.mode_target === "foreground" && !containsAnyKeyword(response, ["앱", "foreground", "포그라운드", "복귀"])) {
      blockers.push("outcome_missing_foreground_context");
    }
    if (handoffResult?.delivery_decision && ["deferred", "scheduled_delivery", "delivered"].includes(handoffResult.delivery_decision)) {
      if (!containsAnyKeyword(response, ["전달", "기록", "넘겼", "접수", "대기"])) {
        blockers.push("outcome_missing_delivery_explanation");
      }
    }
  }

  if (phase === "notification") {
    if (action !== "none") blockers.push("notification_action_must_be_none");
    if (kind === "human_gate" && !containsAnyKeyword(response, ["승인", "확인", "대기"])) {
      blockers.push("human_gate_notification_missing_approval_words");
    }
    if (kind === "processed" && hasInternalLeak(response)) {
      blockers.push("processed_notification_internal_leak");
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
  };
}

function buildRepairPrompt({
  guidebook,
  projectDisplayName,
  projectKey,
  phase,
  previousDecision,
  blockers,
  facts,
  operatorMessage = "",
  kind = null,
  payloadText = "",
  handoffResult = null,
}) {
  const lines = [
    `You are the Discord bridge thread for project "${projectDisplayName}" (${projectKey}).`,
    "Your previous JSON reply was rejected by runtime validation.",
    "Fix every blocker below and return corrected JSON only.",
    "",
    "<guidebook>",
    guidebook,
    "</guidebook>",
    "",
    "Previous JSON:",
    JSON.stringify(previousDecision),
    "",
    "Validation blockers:",
    ...blockers.map((blocker) => `- ${blocker}`),
    "",
    "Current facts:",
    `- project_display_name: ${facts.projectDisplayName ?? "none"}`,
    `- project_key: ${facts.projectKey ?? "none"}`,
    `- bridge_thread: ${facts.bridgeThreadShortId ?? "none"}`,
    `- main_thread_name: ${facts.mainThreadName ?? "none"}`,
    `- main_thread_short_id: ${facts.mainThreadShortId ?? "none"}`,
    `- workspace_label: ${facts.workspaceLabel ?? "none"}`,
    `- main_status: ${facts.status ?? "unknown"}`,
    `- mode: ${facts.backgroundMode ?? "manual"}`,
    `- next_smallest_batch: ${facts.nextSmallestBatch ?? "none"}`,
  ];

  if (phase === "planning") {
    lines.push("", `Operator message: ${operatorMessage}`);
  } else if (phase === "notification") {
    lines.push("", `Notification kind: ${kind ?? "unknown"}`, `Payload: ${payloadText}`);
  } else if (phase === "outcome") {
    lines.push("", "Runtime result:", summarizeOutcomeFacts({
      operatorMessage,
      action: previousDecision.action,
      handoffResult,
      projectDisplayName,
      projectKey,
    }));
  }

  lines.push(
    "",
    'Return ONLY minified JSON with keys "operator_response", "action", and "request".',
  );
  if (phase !== "planning") {
    lines.push('For this repair, action must be "none" and request must be null.');
  }
  return lines.join("\n");
}

function buildSafeFallbackDecision({
  phase,
  operatorMessage = "",
  kind = null,
  facts,
  handoffResult = null,
  projectDisplayName,
}) {
  const need = classifyOperatorNeed(operatorMessage);
  if (phase === "planning") {
    if (need.identity) {
      return normalizeBridgeDecision({
        operator_response: `${facts.projectDisplayName ?? projectDisplayName}에서 메인 스레드 "${facts.mainThreadName ?? "미확인"}"(${facts.mainThreadShortId ?? "미확인"})와 연결돼 있습니다. 워크스페이스는 ${facts.workspaceLabel ?? "미확인"}입니다.`,
        action: "none",
        request: null,
      });
    }
    if (need.status) {
      return normalizeBridgeDecision({
        operator_response: `${facts.projectDisplayName ?? projectDisplayName}의 현재 상태는 ${humanStatusLabel(facts.status)}입니다.${facts.nextSmallestBatch ? ` 다음으로는 ${facts.nextSmallestBatch} 순서입니다.` : ""}`,
        action: "none",
        request: null,
      });
    }
    if (need.background) {
      return normalizeBridgeDecision({
        operator_response: "백그라운드 모드로 전환하겠습니다. 바로 진행 가능 여부도 함께 확인하겠습니다.",
        action: "set_mode_background",
        request: null,
      });
    }
    if (need.foreground) {
      return normalizeBridgeDecision({
        operator_response: "앱 기준 foreground 모드로 돌리겠습니다.",
        action: "set_mode_foreground",
        request: null,
      });
    }
    if (need.workRequest) {
      return normalizeBridgeDecision({
        operator_response: "요청을 메인 스레드에 전달하겠습니다. 바로 처리인지 대기인지도 이어서 확인하겠습니다.",
        action: "handoff_intent",
        request: operatorMessage,
      });
    }
    return normalizeBridgeDecision({
      operator_response: "지금 확인된 사실 기준으로 상태를 다시 정리해드리겠습니다.",
      action: "none",
      request: null,
    });
  }

  if (phase === "outcome") {
    if (handoffResult?.mode_target === "background") {
      return normalizeBridgeDecision({
        operator_response: `백그라운드 모드로 전환했습니다.${handoffResult.scheduler_gate?.ready ? " scheduler도 바로 동작 가능합니다." : " 다만 아직 바로 진행되진 않는 상태입니다."}`,
        action: "none",
        request: null,
      });
    }
    if (handoffResult?.mode_target === "foreground") {
      return normalizeBridgeDecision({
        operator_response: "앱 기준 foreground 모드로 돌렸습니다.",
        action: "none",
        request: null,
      });
    }
    return normalizeBridgeDecision({
      operator_response: "요청은 메인 스레드에 전달됐습니다. 실행이 시작되거나 결과가 나오면 이어서 알려드리겠습니다.",
      action: "none",
      request: null,
    });
  }

  if (phase === "notification" && kind === "human_gate") {
    return normalizeBridgeDecision({
      operator_response: "지금 메인 쪽에서 승인 확인이 필요해 잠시 대기 중입니다.",
      action: "none",
      request: null,
    });
  }

  return normalizeBridgeDecision({
    operator_response: `${projectDisplayName} 관련 새 상태가 도착했습니다. 필요하면 지금 상태를 다시 물어보세요.`,
    action: "none",
    request: null,
  });
}

function normalizeBridgeDecision(decision, fallbackResponse = null) {
  const operatorResponse = collapseWhitespace(decision?.operator_response ?? fallbackResponse ?? "");
  const requestedAction = String(decision?.action ?? "none").trim() || "none";
  const allowedActions = new Set([
    "none",
    "handoff_intent",
    "handoff_reply",
    "set_mode_background",
    "set_mode_foreground",
  ]);
  const action = allowedActions.has(requestedAction) ? requestedAction : "none";
  const request = collapseWhitespace(decision?.request ?? "");
  return {
    operator_response: operatorResponse || "요청을 이해했습니다. 필요한 상태를 다시 정리해서 이어가겠습니다.",
    action,
    request: request || null,
  };
}

function isMissingBridgeThreadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not found|thread not loaded/i.test(message);
}

async function readRecentProjectNotes({ sharedBase, workspaceKey, projectKey, limit = 3 }) {
  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  const notes = [];

  const processedFiles = (await listFilesSafe(paths.processedDir, ".json")).slice(-limit).reverse();
  for (const fileName of processedFiles) {
    const record = await readJsonIfExists(path.join(paths.processedDir, fileName));
    if (!record) continue;
    const summary = summarizeText(record.final_text);
    if (summary) {
      notes.push({
        kind: "processed",
        text: summary,
      });
    }
  }

  const schedulerRuntime = await readJsonIfExists(path.join(paths.runtimeDir, "scheduler_runtime.json"));
  if (schedulerRuntime?.decision || Array.isArray(schedulerRuntime?.reasons)) {
    const reasonText = Array.isArray(schedulerRuntime.reasons) ? schedulerRuntime.reasons.join(", ") : null;
    notes.push({
      kind: "scheduler",
      text: summarizeText(
        `scheduler=${schedulerRuntime.decision ?? "unknown"}${reasonText ? ` (${reasonText})` : ""}`,
      ),
    });
  }

  return notes.slice(0, limit);
}

function buildPlanningPrompt({
  guidebook,
  projectDisplayName,
  projectKey,
  summary,
  snapshot,
  bridgeThreadId,
  operatorMessage,
  recentNotes,
}) {
  const backgroundMode =
    summary.background_trigger_enabled === true && summary.foreground_session_active !== true
      ? "background"
      : summary.foreground_session_active
        ? "foreground"
        : "manual";
  const lines = [
    `You are the operator-facing Discord bridge thread for project "${projectDisplayName}" (${projectKey}).`,
    "Follow the guidebook below exactly.",
    "",
    "<guidebook>",
    guidebook,
    "</guidebook>",
    "",
    'Return ONLY minified JSON with keys "operator_response", "action", and "request".',
    'Valid action values: "none", "handoff_intent", "handoff_reply", "set_mode_background", "set_mode_foreground".',
    "Write operator_response in concise natural Korean, 1 to 4 sentences.",
    "",
    "Current project context:",
    `- display_name: ${projectDisplayName}`,
    `- project_key: ${projectKey}`,
    `- bridge_thread: ${shortId(bridgeThreadId) ?? "none"}`,
    `- main_thread: ${shortId(summary.attached_thread_id) ?? shortId(snapshot?.coordinator_binding?.threadId) ?? "none"}`,
    `- main_thread_name: ${summary.attached_thread_name ?? "none"}`,
    `- main_workspace: ${summary.attached_workspace_label ?? "none"}`,
    `- main_status: ${summary.attached_thread_status ?? summary.coordinator_status ?? "unknown"}`,
    `- mode: ${backgroundMode}`,
    `- current_goal: ${summary.current_goal ?? "none"}`,
    `- current_focus: ${summary.current_focus ?? "none"}`,
    `- next_smallest_batch: ${summary.next_smallest_batch ?? "none"}`,
    `- dispatch_queue_count: ${summary.dispatch_queue_count ?? 0}`,
    `- human_gate_count: ${summary.human_gate_candidate_count ?? 0}`,
    `- active_approval_source_ref: ${snapshot?.coordinator_status?.active_approval_source_ref ?? "none"}`,
    "",
    "Recent notes:",
  ];

  if (!recentNotes.length) {
    lines.push("- none");
  } else {
    for (const note of recentNotes) {
      lines.push(`- ${note.kind}: ${note.text}`);
    }
  }

  lines.push("");
  lines.push(`Operator message: ${operatorMessage}`);
  return lines.join("\n");
}

function buildBridgeSeedPrompt({ projectDisplayName, projectKey }) {
  return [
    `You are now the Discord bridge thread for project "${projectDisplayName}" (${projectKey}).`,
    "You talk to the operator in Korean and help them understand current state.",
    "You never edit the repo directly. You never act as the main coordinator.",
    "You only explain state, collect requests, and prepare handoff decisions for the main thread.",
    'Reply only with {"status":"bridge_ready"}.',
  ].join("\n");
}

function buildNotificationPrompt({
  guidebook,
  projectDisplayName,
  projectKey,
  kind,
  payloadText,
}) {
  return [
    `You are the Discord bridge thread for project "${projectDisplayName}" (${projectKey}).`,
    "Follow the guidebook below exactly.",
    "",
    "<guidebook>",
    guidebook,
    "</guidebook>",
    "",
    "You are summarizing a note from the main execution lane for the operator.",
    "Reply in concise natural Korean, 1 to 3 sentences.",
    'Return ONLY minified JSON with keys "operator_response", "action", and "request".',
    'For notifications, always use action "none" and request null.',
    `Notification kind: ${kind}`,
    `Payload: ${payloadText}`,
  ].join("\n");
}

function summarizeOutcomeFacts({ operatorMessage, action, handoffResult, projectDisplayName, projectKey }) {
  const lines = [
    `Operator message: ${operatorMessage}`,
    `Chosen action: ${action}`,
    `Project display: ${projectDisplayName}`,
    `Project key: ${projectKey}`,
  ];
  if (!handoffResult) {
    lines.push("Execution result: none");
    return lines.join("\n");
  }

  lines.push(`Execution route: ${handoffResult.route ?? "none"}`);
  lines.push(`Delivery decision: ${handoffResult.delivery_decision ?? "none"}`);
  if (handoffResult.mode_target) {
    lines.push(`Mode target: ${handoffResult.mode_target}`);
  }
  if (handoffResult.summary) {
    lines.push(`Status: ${handoffResult.summary.attached_thread_status ?? handoffResult.summary.coordinator_status ?? "unknown"}`);
    lines.push(`Next batch: ${handoffResult.summary.next_smallest_batch ?? "none"}`);
    lines.push(`Queue count: ${handoffResult.summary.dispatch_queue_count ?? 0}`);
    lines.push(`Human gate count: ${handoffResult.summary.human_gate_candidate_count ?? 0}`);
  }
  if (handoffResult.scheduler_gate) {
    lines.push(`Scheduler ready: ${handoffResult.scheduler_gate.ready === true ? "yes" : "no"}`);
    lines.push(`Scheduler reasons: ${(handoffResult.scheduler_gate.reasons ?? []).join(", ") || "none"}`);
  }
  if (handoffResult.quarantine_reason) {
    lines.push(`Quarantine reason: ${handoffResult.quarantine_reason}`);
  }
  return lines.join("\n");
}

function buildOutcomePrompt({
  guidebook,
  projectDisplayName,
  projectKey,
  planningDecision,
  operatorMessage,
  handoffResult,
}) {
  return [
    `You are the Discord bridge thread for project "${projectDisplayName}" (${projectKey}).`,
    "Follow the guidebook below exactly.",
    "",
    "<guidebook>",
    guidebook,
    "</guidebook>",
    "",
    "You already decided on an action and the runtime executed it.",
    "Now explain the actual result back to the operator in natural Korean.",
    "Do not mention internal route keys, JSON fields, file paths, or implementation details.",
    'Return ONLY minified JSON with keys "operator_response", "action", and "request".',
    'For this step, action must always be "none" and request must be null.',
    "",
    `Initial bridge response: ${planningDecision.operator_response}`,
    summarizeOutcomeFacts({
      operatorMessage,
      action: planningDecision.action,
      handoffResult,
      projectDisplayName,
      projectKey,
    }),
  ].join("\n");
}

export class DiscordBridgeThreadService {
  constructor({
    runtime,
    sharedBase,
    workspaceKey,
    wsUrl,
    logPath = null,
    workspaceCwd,
    serviceName = "remodex_discord_bridge_thread",
  }) {
    this.runtime = runtime;
    this.sharedBase = sharedBase;
    this.workspaceKey = workspaceKey;
    this.wsUrl = wsUrl;
    this.logPath = logPath;
    this.workspaceCwd = workspaceCwd;
    this.serviceName = serviceName;
    this.guidebookText = null;
  }

  async loadGuidebook() {
    if (this.guidebookText) return this.guidebookText;
    try {
      this.guidebookText = await fs.readFile(GUIDEBOOK_PATH, "utf8");
    } catch {
      this.guidebookText = "Use natural Korean. State exact connection facts. Do not expose internal implementation details. Decide whether to explain, hand off, or change mode.";
    }
    return this.guidebookText;
  }

  async withClient(work) {
    if (!this.wsUrl) {
      throw new Error("bridge thread service requires app-server wsUrl");
    }
    const client = await createInitializedWsClient(
      this.wsUrl,
      this.logPath,
      `${this.serviceName}_${Date.now().toString(36)}`,
    );
    try {
      return await work(client);
    } finally {
      client.close();
    }
  }

  async runThreadTurn(threadId, prompt, timeoutMs = 180_000) {
    return await this.withClient(async (client) => {
      return await runTurnAndRead(
        client,
        threadId,
        prompt,
        timeoutMs,
      );
    });
  }

  async runValidatedBridgeDecision({
    threadId,
    phase,
    initialPrompt,
    projectDisplayName,
    projectKey,
    facts,
    operatorMessage = "",
    kind = null,
    payloadText = "",
    handoffResult = null,
    timeoutMs = 180_000,
  }) {
    let prompt = initialPrompt;
    let lastTurnId = null;
    let lastDecision = null;
    let lastValidation = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const turn = await this.runThreadTurn(threadId, prompt, timeoutMs);
      lastTurnId = turn.turnId;
      lastDecision = normalizeBridgeDecision(extractJson(turn.text), turn.text);
      lastValidation = validateBridgeDecision({
        phase,
        decision: lastDecision,
        operatorMessage,
        kind,
        facts,
        handoffResult,
      });
      if (lastValidation.ok) {
        return {
          parsed: lastDecision,
          turn_id: lastTurnId,
          validation: lastValidation,
          repaired: attempt > 0,
          fallback_used: false,
        };
      }
      prompt = buildRepairPrompt({
        guidebook: await this.loadGuidebook(),
        projectDisplayName,
        projectKey,
        phase,
        previousDecision: lastDecision,
        blockers: lastValidation.blockers,
        facts,
        operatorMessage,
        kind,
        payloadText,
        handoffResult,
      });
    }

    return {
      parsed: buildSafeFallbackDecision({
        phase,
        operatorMessage,
        kind,
        facts,
        handoffResult,
        projectDisplayName,
      }),
      turn_id: lastTurnId,
      validation: lastValidation,
      repaired: true,
      fallback_used: true,
    };
  }

  async ensureBridgeThread({ guildId, channelId, projectKey, projectDisplayName }) {
    const bindings = await this.runtime.readChannelBindings();
    const binding = bindings[channelBindingKey(guildId, channelId)] ?? null;
    if (binding?.project_key === projectKey && binding?.bridge_thread_id) {
      try {
        await this.withClient(async (client) => {
          await readThreadWithTurns(client, binding.bridge_thread_id);
        });
        return binding;
      } catch (error) {
        if (!isMissingBridgeThreadError(error)) {
          throw error;
        }
      }
    }

    const threadId = await this.withClient(async (client) => {
      const started = await client.request("thread/start", {
        cwd: this.workspaceCwd,
        approvalPolicy: "never",
        sandbox: "workspace-write",
        serviceName: `${this.serviceName}_${channelId}`,
      });
      const nextThreadId = started?.thread?.id ?? null;
      if (!nextThreadId) {
        throw new Error("bridge thread id missing");
      }
      await runTurnAndRead(
        client,
        nextThreadId,
        buildBridgeSeedPrompt({ projectDisplayName, projectKey }),
        120_000,
      );
      return nextThreadId;
    });

    return await this.runtime.patchChannelBinding({
      guildId,
      channelId,
      patch: {
        project_key: projectKey,
        bridge_thread_id: threadId,
        bridge_thread_created_at: nowIso(),
        bridge_thread_last_used_at: nowIso(),
        bridge_thread_status: "ready",
      },
    });
  }

  async handleBoundMessage({ payload, binding }) {
    const projectKey = binding?.project_key ?? null;
    if (!projectKey) {
      return {
        operator_response: "이 채널은 아직 프로젝트에 연결되지 않았습니다. 먼저 `/projects`로 프로젝트를 고르세요.",
        route: "project_required",
        bridge_thread_id: null,
        project_key: null,
      };
    }

    const bridgeRuntime = await this.runtime.runtimeForProject(projectKey);
    const summary = await bridgeRuntime.statusSummary();
    const snapshot = await bridgeRuntime.snapshot();
    const projectDisplayName = summary.project_display_name ?? snapshot?.project_identity?.display_name ?? projectKey;
    const recentNotes = await readRecentProjectNotes({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey,
      limit: 3,
    });
    const operatorMessage = collapseWhitespace(payload.content);
    const guidebook = await this.loadGuidebook();
    const facts = buildBridgeFacts({
      projectDisplayName,
      projectKey,
      summary,
      snapshot,
      bridgeThreadId: binding?.bridge_thread_id ?? null,
    });
    let ensuredBinding = await this.ensureBridgeThread({
      guildId: payload.guild_id,
      channelId: payload.channel_id,
      projectKey,
      projectDisplayName,
    });

    let decision;
    try {
      decision = await this.runValidatedBridgeDecision({
        threadId: ensuredBinding.bridge_thread_id,
        phase: "planning",
        initialPrompt: buildPlanningPrompt({
          guidebook,
          projectDisplayName,
          projectKey,
          summary,
          snapshot,
          bridgeThreadId: ensuredBinding.bridge_thread_id,
          operatorMessage,
          recentNotes,
        }),
        projectDisplayName,
        projectKey,
        facts: {
          ...facts,
          bridgeThreadShortId: shortId(ensuredBinding.bridge_thread_id),
        },
        operatorMessage,
      });
    } catch (error) {
      if (!isMissingBridgeThreadError(error)) {
        throw error;
      }
      ensuredBinding = await this.ensureBridgeThread({
        guildId: payload.guild_id,
        channelId: payload.channel_id,
        projectKey,
        projectDisplayName,
      });
      decision = await this.runValidatedBridgeDecision({
        threadId: ensuredBinding.bridge_thread_id,
        phase: "planning",
        initialPrompt: buildPlanningPrompt({
          guidebook,
          projectDisplayName,
          projectKey,
          summary,
          snapshot,
          bridgeThreadId: ensuredBinding.bridge_thread_id,
          operatorMessage,
          recentNotes,
        }),
        projectDisplayName,
        projectKey,
        facts: {
          ...facts,
          bridgeThreadShortId: shortId(ensuredBinding.bridge_thread_id),
        },
        operatorMessage,
      });
    }

    let handoffResult = null;
    if (
      decision.parsed.action === "handoff_intent" ||
      decision.parsed.action === "handoff_reply" ||
      decision.parsed.action === "set_mode_background" ||
      decision.parsed.action === "set_mode_foreground"
    ) {
      const commandClass =
        decision.parsed.action === "handoff_reply"
          ? "reply"
          : decision.parsed.action === "set_mode_background" || decision.parsed.action === "set_mode_foreground"
            ? "set-mode"
            : "intent";
      const normalized = {
        source: "discord",
        verified_identity: "bridge_thread",
        operator_id: payload.author?.id ?? payload.member?.user?.id ?? null,
        operator_roles: Array.isArray(payload.member?.roles) && payload.member.roles.length > 0 ? payload.member.roles : ["operator"],
        command_name: `bridge-thread-${commandClass}`,
        command_class: commandClass,
        auth_class: commandClass === "reply" ? "intent" : "intent",
        workspace_key: this.workspaceKey,
        project_key: projectKey,
        source_ref: payload.id,
        request:
          commandClass === "set-mode"
            ? null
            : decision.parsed.request ?? operatorMessage,
        mode_target:
          decision.parsed.action === "set_mode_background"
            ? "background"
            : decision.parsed.action === "set_mode_foreground"
              ? "foreground"
              : null,
        artifact: null,
        correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}:bridge`,
        received_at: payload.timestamp ?? nowIso(),
        raw_interaction_id: null,
        raw_message_id: payload.id,
        raw_guild_id: payload.guild_id ?? null,
        raw_channel_id: payload.channel_id ?? null,
      };
      const outcome = await this.runtime.handleNormalizedCommand(normalized);
      handoffResult = outcome.result ?? null;
    }

    let operatorResponse = decision.parsed.operator_response;
    if (handoffResult) {
      const outcomeDecision = await this.runValidatedBridgeDecision({
        threadId: ensuredBinding.bridge_thread_id,
        phase: "outcome",
        initialPrompt: buildOutcomePrompt({
          guidebook,
          projectDisplayName,
          projectKey,
          planningDecision: decision.parsed,
          operatorMessage,
          handoffResult,
        }),
        projectDisplayName,
        projectKey,
        facts: {
          ...facts,
          bridgeThreadShortId: shortId(ensuredBinding.bridge_thread_id),
        },
        operatorMessage,
        handoffResult,
      });
      operatorResponse = outcomeDecision.parsed.operator_response;
      decision.turn_id = outcomeDecision.turn_id ?? decision.turn_id;
    }

    await this.runtime.patchChannelBinding({
      guildId: payload.guild_id,
      channelId: payload.channel_id,
      patch: {
        bridge_thread_id: ensuredBinding.bridge_thread_id,
        bridge_thread_last_used_at: nowIso(),
        bridge_thread_status: "ready",
      },
    });

    return {
      operator_response: operatorResponse,
      bridge_thread_id: ensuredBinding.bridge_thread_id,
      bridge_turn_id: decision.turn_id,
      bridge_action: decision.parsed.action,
      project_key: projectKey,
      handoff_result: handoffResult,
      route: handoffResult?.route ?? "bridge_reply",
      bridge_validation: decision.validation ?? null,
      bridge_repaired: decision.repaired === true,
      bridge_fallback_used: decision.fallback_used === true,
    };
  }

  async summarizeNotification({ binding, kind, payloadText }) {
    const projectKey = binding?.project_key ?? null;
    if (!projectKey) return null;

    const bridgeRuntime = await this.runtime.runtimeForProject(projectKey);
    const summary = await bridgeRuntime.statusSummary();
    const projectDisplayName = summary.project_display_name ?? projectKey;
    const guidebook = await this.loadGuidebook();
    const ensuredBinding = await this.ensureBridgeThread({
      guildId: binding.guild_id,
      channelId: binding.channel_id,
      projectKey,
      projectDisplayName,
    });

    const facts = buildBridgeFacts({
      projectDisplayName,
      projectKey,
      summary,
      snapshot: null,
      bridgeThreadId: ensuredBinding.bridge_thread_id,
    });
    const decision = await this.runValidatedBridgeDecision({
      threadId: ensuredBinding.bridge_thread_id,
      phase: "notification",
      initialPrompt: buildNotificationPrompt({
        guidebook,
        projectDisplayName,
        projectKey,
        kind,
        payloadText,
      }),
      projectDisplayName,
      projectKey,
      facts,
      kind,
      payloadText,
    });

    await this.runtime.patchChannelBinding({
      guildId: binding.guild_id,
      channelId: binding.channel_id,
      patch: {
        bridge_thread_id: ensuredBinding.bridge_thread_id,
        bridge_thread_last_used_at: nowIso(),
        bridge_thread_status: "ready",
      },
    });

    return {
      operator_response: decision.parsed.operator_response,
      bridge_thread_id: ensuredBinding.bridge_thread_id,
      bridge_turn_id: decision.turn_id,
      bridge_validation: decision.validation ?? null,
      bridge_repaired: decision.repaired === true,
      bridge_fallback_used: decision.fallback_used === true,
    };
  }
}
