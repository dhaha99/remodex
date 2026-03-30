import fs from "node:fs/promises";
import path from "node:path";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_conversation_mode_disclosure_probe");
const summaryPath = path.join(
  verificationDir,
  "discord_conversation_mode_disclosure_probe_summary.json",
);

class CaptureTransport {
  constructor() {
    this.responses = [];
  }

  async respondAutocomplete(_interaction, choices) {
    this.responses.push({ type: "autocomplete", choices });
  }

  async deferChannelMessage(_interaction, _options) {
    this.responses.push({ type: "defer" });
  }

  async editOriginalResponse(_interaction, body) {
    this.responses.push({ type: "edit", body });
  }

  async deferUpdateMessage(_interaction) {
    this.responses.push({ type: "defer_update" });
  }

  async updateMessage(_interaction, body) {
    this.responses.push({ type: "update", body });
  }

  async openModal(_interaction, body) {
    this.responses.push({ type: "modal", body });
  }
}

function makeInteraction({ id, name, options = [] }) {
  return {
    id,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: "guild-disclosure",
    channel_id: "channel-disclosure",
    member: {
      user: { id: "operator-1" },
      roles: [],
    },
    data: {
      id: `cmd-${name}`,
      name,
      type: 1,
      options,
    },
  };
}

async function seedProject(sharedBase) {
  const paths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-disclosure",
  });
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: "project-disclosure",
    display_name: "Disclosure Demo",
    aliases: ["disclosure-demo"],
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
  await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), "current_goal: disclosure\n");
  await writeAtomicText(path.join(paths.stateDir, "progress_axes.md"), "next_smallest_batch: 상태 확인\n");
  await writeAtomicJson(path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json"), {
    bindings: {
      "guild-disclosure:channel-disclosure": {
        guild_id: "guild-disclosure",
        channel_id: "channel-disclosure",
        project_key: "project-disclosure",
        operator_id: "operator-1",
        updated_at: new Date().toISOString(),
      },
    },
  });
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
  await seedProject(sharedBase);

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: "",
    logPath: path.join(probeRoot, "events.jsonl"),
    appServerLogPath: path.join(probeRoot, "app-server.jsonl"),
    workspaceCwd: workspace,
  });

  const callbackTransport = new CaptureTransport();
  const conversationState = {
    mode: "mention_only",
    blocker: "message_content_intent_disabled_or_unconfigured",
    botUsername: "Remodex Pilot",
  };

  await processGatewayInteraction({
    interaction: makeInteraction({ id: "interaction-projects", name: "projects" }),
    runtime,
    callbackTransport,
    conversationState,
  });

  await processGatewayInteraction({
    interaction: makeInteraction({ id: "interaction-status", name: "status" }),
    runtime,
    callbackTransport,
    conversationState,
  });

  const editedBodies = callbackTransport.responses
    .filter((entry) => entry.type === "edit")
    .map((entry) => entry.body);
  const projectsBody = editedBodies.find((body) => String(body?.content ?? "").includes("projects:"));
  const statusBody = editedBodies.find((body) => String(body?.content ?? "").includes("display: Disclosure Demo"));

  summary.projects_body = projectsBody ?? null;
  summary.status_body = statusBody ?? null;
  summary.finishedAt = new Date().toISOString();

  const passed =
    String(projectsBody?.content ?? "").includes("대화 모드: mention_only") &&
    String(statusBody?.content ?? "").includes("대화 모드: mention_only") &&
    String(statusBody?.content ?? "").includes("@Remodex Pilot 지금 어디까지 했어?");

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
  throw new Error(summary.error ?? "discord conversation mode disclosure probe failed");
}
