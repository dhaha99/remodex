import fs from "node:fs/promises";
import path from "node:path";
import { DiscordBridgeThreadService } from "./lib/discord_bridge_thread_service.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "discord_bridge_thread_validation_probe_summary.json");

function nowIso() {
  return new Date().toISOString();
}

class FakeProjectRuntime {
  constructor(summary, snapshot) {
    this.summary = summary;
    this.snapshotValue = snapshot;
  }

  async statusSummary() {
    return this.summary;
  }

  async snapshot() {
    return this.snapshotValue;
  }
}

class FakeRuntime {
  constructor({ summary, snapshot }) {
    this.summary = summary;
    this.snapshot = snapshot;
    this.binding = {
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      project_key: summary.project_key,
      bridge_thread_id: "bridge-thread-validation",
      bridge_thread_status: "ready",
    };
    this.commands = [];
  }

  async runtimeForProject() {
    return new FakeProjectRuntime(this.summary, this.snapshot);
  }

  async patchChannelBinding({ guildId, channelId, patch = {} }) {
    this.binding = {
      ...this.binding,
      guild_id: guildId,
      channel_id: channelId,
      ...patch,
    };
    return this.binding;
  }

  async handleNormalizedCommand(normalized) {
    this.commands.push(normalized);
    if (normalized.command_class === "set-mode") {
      return {
        result: {
          route: "project_mode_updated",
          project_key: normalized.project_key,
          mode_target: normalized.mode_target,
          scheduler_gate: {
            ready: true,
            reasons: [],
          },
          summary: this.summary,
        },
      };
    }
    return {
      result: {
        route: "inbox",
        project_key: normalized.project_key,
        delivery_decision: "deferred",
        summary: this.summary,
      },
    };
  }
}

class ScriptedBridgeThreadService extends DiscordBridgeThreadService {
  constructor({ runtime, scripts }) {
    super({
      runtime,
      sharedBase: path.join(workspace, "verification", "bridge-thread-validation-fake"),
      workspaceKey: "remodex",
      wsUrl: "ws://127.0.0.1:4517",
      workspaceCwd: workspace,
      serviceName: "probe_discord_bridge_thread_validation",
    });
    this.scripts = [...scripts];
    this.prompts = [];
  }

  async loadGuidebook() {
    return [
      "한국어로 자연스럽게 답해라.",
      "연결 질문이면 메인 스레드 이름, 짧은 ID, workspace, 프로젝트 표시명을 반드시 말해라.",
      "내부 키나 경로를 노출하지 마라.",
      "작업 요청이면 handoff_intent와 사람이 읽을 수 있는 request를 만들어라.",
    ].join("\n");
  }

  async ensureBridgeThread({ guildId, channelId, projectKey }) {
    return {
      guild_id: guildId,
      channel_id: channelId,
      project_key: projectKey,
      bridge_thread_id: "bridge-thread-validation",
      bridge_thread_status: "ready",
    };
  }

  async runThreadTurn(threadId, prompt) {
    this.prompts.push({ threadId, prompt });
    const next = this.scripts.shift();
    if (!next) {
      throw new Error("scripted turn missing");
    }
    return {
      turnId: `turn-${this.prompts.length}`,
      text: next,
    };
  }
}

const summary = {
  startedAt: nowIso(),
};

try {
  await fs.mkdir(verificationDir, { recursive: true });

  const baseSummary = {
    project_key: "project-validation",
    project_display_name: "Validation Demo",
    attached_thread_id: "019d3cc3-a706-7b11-9173-c8effac79482",
    attached_thread_name: "실제 작업 메인",
    attached_workspace_label: "remodex",
    attached_thread_status: "idle",
    next_smallest_batch: "로그인 테스트 확인",
    dispatch_queue_count: 0,
    human_gate_candidate_count: 0,
    background_trigger_enabled: false,
    foreground_session_active: false,
    coordinator_status: "idle",
  };
  const baseSnapshot = {
    coordinator_binding: {
      threadId: "019d3cc3-a706-7b11-9173-c8effac79482",
    },
  };

  const identityRuntime = new FakeRuntime({
    summary: baseSummary,
    snapshot: baseSnapshot,
  });
  const identityService = new ScriptedBridgeThreadService({
    runtime: identityRuntime,
    scripts: [
      JSON.stringify({
        operator_response: "연결은 정상입니다.",
        action: "none",
        request: null,
      }),
      JSON.stringify({
        operator_response:
          "Validation Demo에서 메인 스레드 \"실제 작업 메인\"(019d3cc3-a70)와 연결돼 있습니다. 워크스페이스는 remodex입니다.",
        action: "none",
        request: null,
      }),
    ],
  });

  const identityOutcome = await identityService.handleBoundMessage({
    payload: {
      id: "msg-identity-validation",
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      timestamp: nowIso(),
      content: "지금 어느 스레드랑 연결돼 있어?",
      author: { id: "operator-validation" },
      member: { roles: [] },
    },
    binding: {
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      project_key: "project-validation",
    },
  });

  const intentRuntime = new FakeRuntime({
    summary: baseSummary,
    snapshot: baseSnapshot,
  });
  const intentService = new ScriptedBridgeThreadService({
    runtime: intentRuntime,
    scripts: [
      JSON.stringify({
        operator_response: "알겠습니다.",
        action: "none",
        request: null,
      }),
      JSON.stringify({
        operator_response: "로그인 테스트 요청은 메인 스레드에 전달하겠습니다.",
        action: "handoff_intent",
        request: "로그인 테스트를 최우선으로 진행해줘.",
      }),
      JSON.stringify({
        operator_response: "로그인 테스트 요청은 메인 스레드에 전달됐고 지금은 접수 대기 상태입니다.",
        action: "none",
        request: null,
      }),
    ],
  });

  const intentOutcome = await intentService.handleBoundMessage({
    payload: {
      id: "msg-intent-validation",
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      timestamp: nowIso(),
      content: "로그인 테스트부터 진행해",
      author: { id: "operator-validation" },
      member: { roles: [] },
    },
    binding: {
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      project_key: "project-validation",
    },
  });

  const notificationRuntime = new FakeRuntime({
    summary: {
      ...baseSummary,
      coordinator_status: "waiting_on_approval",
      attached_thread_status: "waiting_on_approval",
    },
    snapshot: baseSnapshot,
  });
  const notificationService = new ScriptedBridgeThreadService({
    runtime: notificationRuntime,
    scripts: [
      JSON.stringify({
        operator_response:
          "승인 상태는 /Users/example/router/outbox/abc.json 에 적어뒀습니다.",
        action: "none",
        request: null,
      }),
      JSON.stringify({
        operator_response: "지금 메인 쪽에서 승인 확인이 필요해서 잠시 대기 중입니다.",
        action: "none",
        request: null,
      }),
    ],
  });

  const notificationOutcome = await notificationService.summarizeNotification({
    binding: {
      guild_id: "guild-validation",
      channel_id: "channel-validation",
      project_key: "project-validation",
    },
    kind: "human_gate",
    payloadText: "Validation Demo에서 human gate가 발생했습니다.",
  });

  summary.identityOutcome = identityOutcome;
  summary.identityPrompts = identityService.prompts.length;
  summary.intentOutcome = intentOutcome;
  summary.intentPrompts = intentService.prompts.length;
  summary.intentCommand = intentRuntime.commands.at(0) ?? null;
  summary.notificationOutcome = notificationOutcome;
  summary.notificationPrompts = notificationService.prompts.length;
  summary.finishedAt = nowIso();

  const passed =
    identityOutcome.bridge_repaired === true &&
    identityOutcome.bridge_fallback_used === false &&
    String(identityOutcome.operator_response).includes("실제 작업 메인") &&
    String(identityOutcome.operator_response).includes("019d3cc3-a70") &&
    String(identityOutcome.operator_response).includes("remodex") &&
    intentOutcome.bridge_repaired === true &&
    intentOutcome.bridge_fallback_used === false &&
    intentOutcome.handoff_result?.route === "inbox" &&
    /로그인 테스트를 최우선으로 진행해줘/.test(String(summary.intentCommand?.request ?? "")) &&
    notificationOutcome.bridge_repaired === true &&
    notificationOutcome.bridge_fallback_used === false &&
    !/\/Users\/|outbox|json/i.test(String(notificationOutcome.operator_response ?? "")) &&
    /승인|대기/.test(String(notificationOutcome.operator_response ?? ""));

  summary.status = passed ? "PASS" : "FAIL";
} catch (error) {
  summary.finishedAt = nowIso();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
}

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord bridge thread validation probe failed");
}
