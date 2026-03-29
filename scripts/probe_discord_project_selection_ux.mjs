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
const probeRoot = path.join(verificationDir, "discord_project_selection_ux_probe");
const summaryPath = path.join(
  verificationDir,
  "discord_project_selection_ux_probe_summary.json",
);

function commandInteraction({
  id,
  commandName,
  guildId = "guild-ux",
  channelId = "channel-ux",
  project = null,
  request = null,
  sourceRef = null,
  roles = ["operator"],
}) {
  const options = [];
  if (project !== null) options.push({ name: "project", value: project, type: 3 });
  if (request !== null) options.push({ name: "request", value: request, type: 3 });
  if (sourceRef !== null) options.push({ name: "source_ref", value: sourceRef, type: 3 });
  return {
    id,
    application_id: "app-ux",
    token: `token-${id}`,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-ux" },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

function autocompleteInteraction({
  id,
  commandName = "status",
  guildId = "guild-ux",
  channelId = "channel-ux",
  focusedValue = "",
}) {
  return {
    id,
    application_id: "app-ux",
    token: `token-${id}`,
    type: 4,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-ux" },
      roles: ["operator"],
    },
    data: {
      name: commandName,
      options: [
        {
          name: "project",
          type: 3,
          value: focusedValue,
          focused: true,
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

async function seedProject(paths, {
  projectKey,
  displayName,
  aliases = [],
  threadId = null,
  coordinatorStatus = "idle",
  backgroundTriggerEnabled = false,
  foregroundSessionActive = false,
  currentGoal = null,
  currentFocus = null,
  nextSmallestBatch = null,
}) {
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    display_name: displayName,
    aliases,
  });
  if (threadId) {
    await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
      workspace_key: "remodex",
      project_key: projectKey,
      threadId,
    });
  }
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: coordinatorStatus,
    observed_at: new Date().toISOString(),
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: backgroundTriggerEnabled,
    foreground_session_active: foregroundSessionActive,
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  if (currentGoal) {
    await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), `current_goal: ${currentGoal}\n`);
  }
  if (currentFocus) {
    await writeAtomicText(path.join(paths.stateDir, "current_focus.md"), `current_focus: ${currentFocus}\n`);
  }
  if (nextSmallestBatch) {
    await writeAtomicText(
      path.join(paths.stateDir, "progress_axes.md"),
      `next_smallest_batch: ${nextSmallestBatch}\n`,
    );
  }
}

const summary = {
  startedAt: new Date().toISOString(),
};

let multiRuntime = null;
let singleRuntime = null;

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

  await seedProject(alphaPaths, {
    projectKey: "project-alpha",
    displayName: "Alpha",
    aliases: ["alpha", "알파", "backend"],
    threadId: "thread-alpha-ux",
    currentGoal: "로그인 안정화",
    currentFocus: "API contract",
    nextSmallestBatch: "integration-tests",
  });
  await seedProject(betaPaths, {
    projectKey: "project-beta",
    displayName: "Beta",
    aliases: ["beta", "베타", "frontend"],
    currentGoal: "UI polish",
    currentFocus: "settings page",
    nextSmallestBatch: "visual-regression",
  });

  multiRuntime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl: null,
  });
  const fetchCollector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: fetchCollector.fetchImpl,
  });

  const autocompleteOutcome = await processGatewayInteraction({
    interaction: autocompleteInteraction({
      id: "ux-autocomplete-001",
      focusedValue: "alp",
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const projectsOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-projects-001",
      commandName: "projects",
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const missingProjectOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-missing-001",
      commandName: "status",
      channelId: "channel-unbound",
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const useProjectOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-bind-001",
      commandName: "use-project",
      channelId: "channel-alpha",
      project: "alpha",
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const channelBindings = await readJsonIfExists(
    path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json"),
  );

  const boundStatusOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-status-bound-001",
      commandName: "status",
      channelId: "channel-alpha",
      roles: [],
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const boundIntentOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-intent-bound-001",
      commandName: "intent",
      channelId: "channel-alpha",
      request: "로그인 테스트부터 진행",
      roles: [],
    }),
    runtime: multiRuntime,
    callbackTransport,
  });

  const alphaInboxFiles = await fs.readdir(alphaPaths.inboxDir);
  const alphaDispatchFiles = await fs.readdir(alphaPaths.dispatchQueueDir);
  const alphaInboxRecord = alphaInboxFiles[0]
    ? await readJsonIfExists(path.join(alphaPaths.inboxDir, alphaInboxFiles[0]))
    : null;
  const alphaDispatchRecord = alphaDispatchFiles[0]
    ? await readJsonIfExists(path.join(alphaPaths.dispatchQueueDir, alphaDispatchFiles[0]))
    : null;

  const singleSharedBase = path.join(probeRoot, "single-project-default", "external-shared-memory");
  const gammaPaths = buildProjectPaths({
    sharedBase: singleSharedBase,
    workspaceKey: "remodex",
    projectKey: "project-gamma",
  });
  await seedProject(gammaPaths, {
    projectKey: "project-gamma",
    displayName: "Gamma",
    aliases: ["gamma", "감마"],
    currentGoal: "single project default",
    nextSmallestBatch: "smoke-check",
  });

  singleRuntime = new DiscordGatewayAdapterRuntime({
    sharedBase: singleSharedBase,
    workspaceKey: "remodex",
    wsUrl: null,
  });
  const singleCollector = makeFetchCollector();
  const singleCallbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: singleCollector.fetchImpl,
  });
  const singleProjectStatusOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "ux-single-status-001",
      commandName: "status",
      channelId: "channel-gamma",
    }),
    runtime: singleRuntime,
    callbackTransport: singleCallbackTransport,
  });

  const autocompleteRequest = fetchCollector.requests.find(
    (request) => request.method === "POST" && request.body?.type === 8,
  );
  const projectListingMessage = projectsOutcome.operator_message ?? "";
  const resolutionHelpMessage = missingProjectOutcome.operator_message ?? "";
  const channelBindingRecord = channelBindings?.bindings?.["guild-ux:channel-alpha"] ?? null;

  summary.autocomplete = {
    interaction_kind: autocompleteOutcome.interaction_kind,
    choices: autocompleteRequest?.body?.data?.choices ?? [],
  };
  summary.projects = {
    route: projectsOutcome.result.route,
    operator_message: projectListingMessage,
  };
  summary.missing_project = {
    route: missingProjectOutcome.result.route,
    operator_message: resolutionHelpMessage,
  };
  summary.channel_binding = {
    route: useProjectOutcome.result.route,
    operator_message: useProjectOutcome.operator_message,
    binding_record: channelBindingRecord,
  };
  summary.bound_status = {
    route: boundStatusOutcome.result.route,
    summary: boundStatusOutcome.result.summary,
    project_resolution: boundStatusOutcome.project_resolution,
  };
  summary.bound_intent = {
    route: boundIntentOutcome.result.route,
    delivery_decision: boundIntentOutcome.result.delivery_decision,
    project_resolution: boundIntentOutcome.project_resolution,
    inbox_record: alphaInboxRecord,
    dispatch_record: alphaDispatchRecord,
  };
  summary.single_project_default = {
    route: singleProjectStatusOutcome.result.route,
    summary: singleProjectStatusOutcome.result.summary,
    project_resolution: singleProjectStatusOutcome.project_resolution,
  };
  summary.callback_request_count = fetchCollector.requests.length + singleCollector.requests.length;
  summary.finishedAt = new Date().toISOString();

  const autocompleteChoices = summary.autocomplete.choices;
  const hasAlphaChoice = autocompleteChoices.some((choice) => choice.value === "project-alpha");
  const projectsListed =
    projectListingMessage.includes("project-alpha") && projectListingMessage.includes("project-beta");
  const missingProjectHelpful =
    summary.missing_project.route === "project_required" &&
    resolutionHelpMessage.includes("available: project-alpha, project-beta");
  const bindingWorked =
    summary.channel_binding.route === "channel_binding" &&
    channelBindingRecord?.project_key === "project-alpha";
  const boundStatusWorked =
    summary.bound_status.route === "status" &&
    summary.bound_status.summary?.project_key === "project-alpha" &&
    summary.bound_status.project_resolution?.resolved_via === "channel_binding";
  const boundIntentWorked =
    summary.bound_intent.route === "inbox" &&
    summary.bound_intent.delivery_decision === "deferred" &&
    summary.bound_intent.project_resolution?.resolved_via === "channel_binding" &&
    summary.bound_intent.inbox_record?.project_key === "project-alpha" &&
    summary.bound_intent.dispatch_record?.project_key === "project-alpha" &&
    summary.bound_intent.dispatch_record?.blocked_reasons?.includes("background_trigger_disabled");
  const singleProjectWorked =
    summary.single_project_default.route === "status" &&
    summary.single_project_default.summary?.project_key === "project-gamma" &&
    summary.single_project_default.project_resolution?.resolved_via === "single_project_default";

  summary.status =
    autocompleteOutcome.interaction_kind === "autocomplete" &&
    hasAlphaChoice &&
    projectsListed &&
    missingProjectHelpful &&
    bindingWorked &&
    boundStatusWorked &&
    boundIntentWorked &&
    singleProjectWorked
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await multiRuntime?.close().catch(() => {});
  await singleRuntime?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord project selection UX probe failed");
}
