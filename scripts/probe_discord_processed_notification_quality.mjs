import fs from "node:fs/promises";
import path from "node:path";
import { DiscordConversationService } from "./lib/discord_conversation_service.mjs";
import { buildProjectPaths, ensureProjectDirs, writeAtomicJson } from "./lib/shared_memory_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_processed_notification_quality_probe");
const summaryPath = path.join(verificationDir, "discord_processed_notification_quality_probe_summary.json");

const summary = {
  startedAt: new Date().toISOString(),
};

function makeTransport() {
  const messages = [];
  return {
    messages,
    async createChannelMessage(payload) {
      messages.push(payload);
      return { id: `message-${messages.length}` };
    },
  };
}

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(probeRoot, { recursive: true });

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const workspaceKey = "remodex";
  const projectKey = "project-quality";
  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: projectKey,
    display_name: "Quality Demo",
  });

  const transport = makeTransport();
  const runtime = {
    async readChannelBindings() {
      return {
        "guild-quality:channel-quality": {
          guild_id: "guild-quality",
          channel_id: "channel-quality",
          project_key: projectKey,
        },
      };
    },
  };

  const service = new DiscordConversationService({
    runtime,
    channelTransport: transport,
    sharedBase,
    workspaceKey,
  });

  const statusDelivery = await service.deliverProcessedReceipt(
    {
      workspace_key: workspaceKey,
      project_key: projectKey,
      source_ref: "status-1",
      source_command_class: "status",
      disposition: "consumed",
      final_text: "상태 응답입니다.",
      project_display_name: "Quality Demo",
    },
    await runtime.readChannelBindings(),
  );

  const noisyDelivery = await service.deliverProcessedReceipt(
    {
      workspace_key: workspaceKey,
      project_key: projectKey,
      source_ref: "intent-1",
      source_command_class: "intent",
      disposition: "consumed",
      project_display_name: "Quality Demo",
      final_text: `아직 **실제 작업 응답은 안 왔습니다.**

- **온 것**
  - Discord 상태 응답 2건은 왔습니다.
  - 근거: [router/outbox](/Users/mymac/my%20dev/remodex/runtime/external-shared-memory/remodex/router/outbox)
    - [2026-03-29T23-29-28.914Z_status_response.json](/Users/mymac/my%20dev/remodex/runtime/external-shared-memory/remodex/router/outbox/2026-03-29T23-29-28.914Z_status_response.json)

현재 상태:
- [coordinator_status.json](/Users/mymac/my%20dev/remodex/runtime/external-shared-memory/remodex/projects/project-codex-ipc/state/coordinator_status.json): \`active\`
- [scheduler_runtime.json](/Users/mymac/my%20dev/remodex/runtime/external-shared-memory/remodex/projects/project-codex-ipc/runtime/scheduler_runtime.json): \`blocked\`

원하면 바로 다음으로 파보겠습니다.`,
    },
    await runtime.readChannelBindings(),
  );

  summary.status_delivery = statusDelivery;
  summary.noisy_delivery = noisyDelivery;
  summary.messages = transport.messages;
  summary.finishedAt = new Date().toISOString();

  const onlyMessage = transport.messages[0]?.content ?? "";
  const passed =
    statusDelivery?.disposition === "ignored_status_receipt" &&
    noisyDelivery?.disposition === "delivered" &&
    transport.messages.length === 1 &&
    onlyMessage.includes("Quality Demo 응답이 도착했습니다.") &&
    onlyMessage.includes("요약: 아직 실제 작업 결과는 오지 않았습니다.") &&
    !onlyMessage.includes("/Users/") &&
    !onlyMessage.includes("router/outbox") &&
    !onlyMessage.includes("turn:");

  summary.status = passed ? "PASS" : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
