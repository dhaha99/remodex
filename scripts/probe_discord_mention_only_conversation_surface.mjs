import fs from "node:fs/promises";
import path from "node:path";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";
import { DiscordConversationService } from "./lib/discord_conversation_service.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_mention_only_conversation_surface_probe");
const summaryPath = path.join(
  verificationDir,
  "discord_mention_only_conversation_surface_probe_summary.json",
);

class CaptureChannelTransport {
  constructor() {
    this.messages = [];
  }

  async createChannelMessage(payload) {
    this.messages.push(payload);
    return { id: `message-${this.messages.length}` };
  }
}

function createMessage({
  id,
  channelId,
  content,
  mentions = [],
}) {
  return {
    id,
    guild_id: "guild-mention",
    channel_id: channelId,
    timestamp: new Date().toISOString(),
    type: 0,
    content,
    author: {
      id: "operator-1",
      username: "operator",
      bot: false,
    },
    member: {
      user: { id: "operator-1" },
      roles: [],
    },
    mentions,
  };
}

async function seedProject(sharedBase) {
  const paths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-mention",
  });
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: "project-mention",
    display_name: "Mention Demo",
    aliases: ["mention-demo"],
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: true,
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), "current_goal: mention-only flow\n");
  await writeAtomicText(path.join(paths.stateDir, "progress_axes.md"), "next_smallest_batch: 로그인 테스트부터 진행\n");
  await writeAtomicJson(path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json"), {
    bindings: {
      "guild-mention:channel-bound": {
        guild_id: "guild-mention",
        channel_id: "channel-bound",
        project_key: "project-mention",
        operator_id: "operator-1",
        updated_at: new Date().toISOString(),
      },
    },
  });
  return paths;
}

const summary = {
  startedAt: new Date().toISOString(),
};

let runtime = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.mkdir(probeRoot, { recursive: true });

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const paths = await seedProject(sharedBase);
  const channelTransport = new CaptureChannelTransport();

  const { DiscordGatewayAdapterRuntime } = await import("./lib/discord_gateway_adapter_runtime.mjs");
  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: "",
    logPath: path.join(probeRoot, "events.jsonl"),
    appServerLogPath: path.join(probeRoot, "app-server.jsonl"),
    workspaceCwd: workspace,
  });

  const service = new DiscordConversationService({
    runtime,
    channelTransport,
    sharedBase,
    workspaceKey: "remodex",
    outboxPollIntervalMs: 100,
    messageContentMode: "mention_only",
  });
  service.setBotIdentity({ id: "bot-mention", username: "Remodex Pilot" });

  const statusResult = await service.handleMessageCreate(
    createMessage({
      id: "message-status",
      channelId: "channel-bound",
      content: "<@bot-mention> 지금 어디까지 했어?",
      mentions: [{ id: "bot-mention" }],
    }),
  );

  const intentResult = await service.handleMessageCreate(
    createMessage({
      id: "message-intent",
      channelId: "channel-bound",
      content: "<@bot-mention> 로그인 테스트부터 진행해",
      mentions: [{ id: "bot-mention" }],
    }),
  );

  const unavailableResult = await service.handleMessageCreate(
    createMessage({
      id: "message-empty",
      channelId: "channel-bound",
      content: "",
      mentions: [],
    }),
  );

  const inboxFiles = await fs.readdir(paths.inboxDir);
  const inboxRecord = inboxFiles[0]
    ? await readJsonIfExists(path.join(paths.inboxDir, inboxFiles[0]))
    : null;

  summary.status_result = statusResult;
  summary.intent_result = intentResult;
  summary.unavailable_result = unavailableResult;
  summary.channel_messages = channelTransport.messages;
  summary.inbox_record = inboxRecord;
  summary.finishedAt = new Date().toISOString();

  const statusReply = channelTransport.messages.find((entry) =>
    String(entry.content ?? "").includes("Mention Demo 현재 상태입니다."),
  );
  const intentReply = channelTransport.messages.find((entry) =>
    String(entry.content ?? "").includes("Mention Demo에 작업 요청을 기록했습니다."),
  );
  const unavailableReply = channelTransport.messages.find((entry) =>
    String(entry.content ?? "").includes("Message Content intent가 꺼져 있어"),
  );

  const passed =
    statusResult?.ignored === false &&
    intentResult?.ignored === false &&
    unavailableResult?.reason === "message_content_unavailable" &&
    statusReply &&
    intentReply &&
    unavailableReply &&
    inboxRecord?.request === "로그인 테스트부터 진행해";

  summary.status = passed ? "PASS" : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await runtime?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord mention-only conversation surface probe failed");
}
