import fs from "node:fs/promises";
import path from "node:path";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_component_ux_probe");
const summaryPath = path.join(verificationDir, "discord_component_ux_probe_summary.json");

function baseInteraction({ id, type, token = null, guildId = "guild-components", channelId = "channel-components" }) {
  return {
    id,
    application_id: "app-components",
    token: token ?? `token-${id}`,
    type,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-components" },
      roles: ["operator"],
    },
  };
}

function commandInteraction({ id, commandName, project = null }) {
  const options = [];
  if (project !== null) options.push({ name: "project", value: project, type: 3 });
  return {
    ...baseInteraction({ id, type: 2 }),
    data: {
      name: commandName,
      options,
    },
  };
}

function componentInteraction({ id, customId, componentType, values = null }) {
  return {
    ...baseInteraction({ id, type: 3 }),
    data: {
      custom_id: customId,
      component_type: componentType,
      ...(values ? { values } : {}),
    },
  };
}

function modalSubmitInteraction({ id, customId, request }) {
  return {
    ...baseInteraction({ id, type: 5 }),
    data: {
      custom_id: customId,
      components: [
        {
          type: 18,
          component: {
            type: 4,
            custom_id: "request",
            value: request,
          },
        },
      ],
    },
  };
}

function makeFetchCollector() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method ?? "GET",
        body: options.body ? JSON.parse(options.body) : null,
      });
      return new Response(null, { status: 204 });
    },
  };
}

async function seedProject(paths, projectKey, displayName, currentGoal, nextBatch) {
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    display_name: displayName,
    aliases: [displayName.toLowerCase()],
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId: `thread-${projectKey}`,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: false,
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), `current_goal: ${currentGoal}\n`);
  await writeAtomicText(path.join(paths.stateDir, "progress_axes.md"), `next_smallest_batch: ${nextBatch}\n`);
}

const summary = {
  startedAt: new Date().toISOString(),
};

let runtime = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const alphaPaths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-alpha",
  });
  const betaPaths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-beta",
  });
  await seedProject(alphaPaths, "project-alpha", "Alpha", "로그인 안정화", "integration-tests");
  await seedProject(betaPaths, "project-beta", "Beta", "UI polish", "visual-regression");

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: null,
  });
  const collector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: collector.fetchImpl,
  });

  await processGatewayInteraction({
    interaction: commandInteraction({
      id: "component-projects-001",
      commandName: "projects",
    }),
    runtime,
    callbackTransport,
  });

  await processGatewayInteraction({
    interaction: componentInteraction({
      id: "component-select-001",
      customId: "projects:select",
      componentType: 3,
      values: ["project-alpha"],
    }),
    runtime,
    callbackTransport,
  });

  await processGatewayInteraction({
    interaction: componentInteraction({
      id: "component-status-001",
      customId: "projects:status:project-alpha",
      componentType: 2,
    }),
    runtime,
    callbackTransport,
  });

  await processGatewayInteraction({
    interaction: componentInteraction({
      id: "component-bind-001",
      customId: "projects:bind:project-alpha",
      componentType: 2,
    }),
    runtime,
    callbackTransport,
  });

  await processGatewayInteraction({
    interaction: componentInteraction({
      id: "component-intent-001",
      customId: "projects:intent:project-alpha",
      componentType: 2,
    }),
    runtime,
    callbackTransport,
  });

  await processGatewayInteraction({
    interaction: modalSubmitInteraction({
      id: "component-modal-submit-001",
      customId: "projects:intent_modal:project-alpha",
      request: "버튼에서 연 작업 지시",
    }),
    runtime,
    callbackTransport,
  });

  const callbackPosts = collector.requests.filter((request) => request.method === "POST");
  const callbackPatches = collector.requests.filter((request) => request.method === "PATCH");
  const projectsPatch = callbackPatches[0]?.body ?? null;
  const selectDeferred = callbackPosts.find((request) => request.body?.type === 6)?.body ?? null;
  const selectUpdate =
    callbackPatches.find((request) => {
      const content = String(request.body?.content ?? "");
      return (
        content.includes("project: project-alpha") &&
        content.includes("display: Alpha") &&
        content.includes("goal: 로그인 안정화") &&
        Array.isArray(request.body?.components)
      );
    })?.body ?? null;
  const statusDeferred = callbackPosts.filter((request) => request.body?.type === 6)[1]?.body ?? null;
  const statusUpdate =
    callbackPatches.find((request) => {
      const content = String(request.body?.content ?? "");
      return content.includes("project: project-alpha") && content.includes("status:") && content.includes("queue:");
    })?.body ?? null;
  const bindDeferred = callbackPosts.filter((request) => request.body?.type === 6)[2]?.body ?? null;
  const bindUpdate =
    callbackPatches.find((request) => String(request.body?.content ?? "").includes("route: channel_binding"))?.body ?? null;
  const intentModal = callbackPosts.find((request) => request.body?.type === 9)?.body ?? null;
  const modalAck = callbackPosts.find((request) => request.body?.type === 5 && request.url?.includes("/callback") && request.body?.data?.flags === 64)?.body ?? null;
  const modalPatch = callbackPatches.find((request) => String(request.body?.content ?? "").includes("route: inbox"))?.body ?? null;

  const bindingsRecord = await readJsonIfExists(
    path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json"),
  );
  const alphaInboxFiles = await fs.readdir(alphaPaths.inboxDir);
  const alphaDispatchFiles = await fs.readdir(alphaPaths.dispatchQueueDir);
  const inboxRecord = alphaInboxFiles[0]
    ? await readJsonIfExists(path.join(alphaPaths.inboxDir, alphaInboxFiles[0]))
    : null;
  const dispatchRecord = alphaDispatchFiles[0]
    ? await readJsonIfExists(path.join(alphaPaths.dispatchQueueDir, alphaDispatchFiles[0]))
    : null;

  summary.projects_patch = projectsPatch;
  summary.select_deferred = selectDeferred;
  summary.select_update = selectUpdate;
  summary.status_deferred = statusDeferred;
  summary.status_update = statusUpdate;
  summary.bind_deferred = bindDeferred;
  summary.bind_update = bindUpdate;
  summary.intent_modal = intentModal;
  summary.modal_ack = modalAck;
  summary.modal_patch = modalPatch;
  summary.channel_binding = bindingsRecord?.bindings?.["guild-components:channel-components"] ?? null;
  summary.inbox_record = inboxRecord;
  summary.dispatch_record = dispatchRecord;
  summary.callback_post_count = callbackPosts.length;
  summary.callback_patch_count = callbackPatches.length;
  summary.finishedAt = new Date().toISOString();

  const projectsHasSelect =
    projectsPatch?.components?.[0]?.components?.[0]?.custom_id === "projects:select";
  const selectHasButtons =
    selectUpdate?.components?.[1]?.components?.some((component) => component.custom_id === "projects:intent:project-alpha");
  const selectHasModeButtons =
    selectUpdate?.components?.[2]?.components?.some((component) => component.custom_id === "projects:background:project-alpha") &&
    selectUpdate?.components?.[2]?.components?.some((component) => component.custom_id === "projects:foreground:project-alpha");
  const statusShowsSummary =
    String(statusUpdate?.content ?? "").includes("project: project-alpha") &&
    String(statusUpdate?.content ?? "").includes("status:") &&
    String(statusUpdate?.content ?? "").includes("queue:");
  const statusHasModeButtons =
    statusUpdate?.components?.[2]?.components?.some((component) => component.custom_id === "projects:background:project-alpha") &&
    statusUpdate?.components?.[2]?.components?.some((component) => component.custom_id === "projects:foreground:project-alpha");
  const bindingWorked = summary.channel_binding?.project_key === "project-alpha";
  const modalOpened =
    intentModal?.data?.custom_id === "projects:intent_modal:project-alpha" &&
    intentModal?.data?.components?.[0]?.component?.custom_id === "request";
  const modalDelivered =
    modalAck?.type === 5 &&
    summary.inbox_record?.request === "버튼에서 연 작업 지시" &&
    summary.dispatch_record?.project_key === "project-alpha";
  const deferredInteractionsWorked =
    selectDeferred?.type === 6 &&
    statusDeferred?.type === 6 &&
    bindDeferred?.type === 6 &&
    String(bindUpdate?.content ?? "").includes("route: channel_binding");

  summary.status =
    projectsHasSelect &&
    deferredInteractionsWorked &&
    selectHasButtons &&
    selectHasModeButtons &&
    statusShowsSummary &&
    statusHasModeButtons &&
    bindingWorked &&
    modalOpened &&
    modalDelivered
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await runtime?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord component ux probe failed");
}
