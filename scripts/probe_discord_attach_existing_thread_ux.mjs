import fs from "node:fs/promises";
import path from "node:path";
import { JsonRpcWsClient } from "./lib/app_server_jsonrpc.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import { readJsonIfExists } from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_attach_existing_thread_ux_probe");
const summaryPath = path.join(verificationDir, "discord_attach_existing_thread_ux_probe_summary.json");
const wsUrl = "ws://127.0.0.1:4517";

function commandInteraction({ id, commandName, guildId = "guild-attach", channelId = "channel-attach" }) {
  return {
    id,
    application_id: "app-attach",
    token: `token-${id}`,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-attach" },
      roles: ["operator"],
    },
    data: {
      name: commandName,
      options: [],
    },
  };
}

function componentSelectInteraction({
  id,
  customId,
  value,
  guildId = "guild-attach",
  channelId = "channel-attach",
}) {
  return {
    id,
    application_id: "app-attach",
    token: `token-${id}`,
    type: 3,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-attach" },
      roles: ["operator"],
    },
    data: {
      component_type: 3,
      custom_id: customId,
      values: [value],
    },
  };
}

function autocompleteInteraction({
  id,
  commandName,
  optionName,
  focusedValue = "",
  guildId = "guild-attach",
  channelId = "channel-attach",
}) {
  return {
    id,
    application_id: "app-attach",
    token: `token-${id}`,
    type: 4,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-attach" },
      roles: ["operator"],
    },
    data: {
      name: commandName,
      options: [
        {
          name: optionName,
          type: 3,
          value: focusedValue,
          focused: true,
        },
      ],
    },
  };
}

function componentButtonInteraction({
  id,
  customId,
  guildId = "guild-attach",
  channelId = "channel-attach",
}) {
  return {
    id,
    application_id: "app-attach",
    token: `token-${id}`,
    type: 3,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-attach" },
      roles: ["operator"],
    },
    data: {
      component_type: 2,
      custom_id: customId,
    },
  };
}

function modalSubmitInteraction({
  id,
  customId,
  values,
  guildId = "guild-attach",
  channelId = "channel-attach",
}) {
  return {
    id,
    application_id: "app-attach",
    token: `token-${id}`,
    type: 5,
    timestamp: new Date().toISOString(),
    guild_id: guildId,
    channel_id: channelId,
    member: {
      user: { id: "operator-attach" },
      roles: ["operator"],
    },
    data: {
      custom_id: customId,
      components: Object.entries(values).map(([key, value]) => ({
        type: 18,
        component: {
          type: 4,
          custom_id: key,
          value,
        },
      })),
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

const summary = {
  startedAt: new Date().toISOString(),
};

let runtime = null;
let client = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  client = new JsonRpcWsClient(wsUrl, null);
  await client.connect();
  await client.initialize("discord_attach_existing_thread_ux_probe");

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey: "remodex",
    wsUrl,
    workspaceCwd: workspace,
  });
  const fetchCollector = makeFetchCollector();
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: "http://discord.example/api/v10",
    fetchImpl: fetchCollector.fetchImpl,
  });

  const projectsOutcome = await processGatewayInteraction({
    interaction: commandInteraction({
      id: "attach-projects-001",
      commandName: "projects",
    }),
    runtime,
    callbackTransport,
  });
  summary.projects = {
    route: projectsOutcome.result.route,
    operator_message: projectsOutcome.operator_message,
    attachable_threads: projectsOutcome.result.attachable_threads ?? [],
    patch_body: fetchCollector.requests.at(-1)?.body ?? null,
  };

  const attachableThreads = projectsOutcome.result.attachable_threads ?? [];
  const attachedThread = attachableThreads[0] ?? null;
  if (!attachedThread) {
    throw new Error("no meaningful attachable thread was exposed");
  }
  summary.threadId = attachedThread.thread_id;
  summary.threadShortId = String(attachedThread.thread_id ?? "").slice(0, 8);

  const autocompleteOutcome = await processGatewayInteraction({
    interaction: autocompleteInteraction({
      id: "attach-autocomplete-001",
      commandName: "attach-thread",
      optionName: "thread_id",
      focusedValue: summary.threadShortId,
    }),
    runtime,
    callbackTransport,
  });
  summary.attach_autocomplete = {
    choice_count: autocompleteOutcome.result.choices?.length ?? 0,
    first_choice_value: autocompleteOutcome.result.choices?.[0]?.value ?? null,
  };

  const allScopeOutcome = await processGatewayInteraction({
    interaction: componentButtonInteraction({
      id: "attach-scope-all-001",
      customId: "projects:attach_scope_all",
    }),
    runtime,
    callbackTransport,
  });
  summary.all_scope = {
    route: allScopeOutcome.result.route,
    attach_scope: allScopeOutcome.result.attach_scope,
    attachable_threads: allScopeOutcome.result.attachable_threads?.length ?? 0,
    first_choices: (allScopeOutcome.result.attachable_threads ?? []).slice(0, 5).map((thread) => ({
      thread_id: thread.thread_id,
      display_name: thread.display_name,
      workspace_label: thread.workspace_label ?? null,
    })),
  };
  const crossWorkspaceThread = (allScopeOutcome.result.attachable_threads ?? []).find(
    (thread) => thread.workspace_label && !thread.workspace_label.includes("(현재 저장소)"),
  ) ?? null;
  summary.cross_workspace_thread = crossWorkspaceThread
    ? {
        thread_id: crossWorkspaceThread.thread_id,
        display_name: crossWorkspaceThread.display_name,
        workspace_label: crossWorkspaceThread.workspace_label,
      }
    : null;

  const manualModalOutcome = await processGatewayInteraction({
    interaction: componentButtonInteraction({
      id: "attach-manual-open-001",
      customId: "projects:attach_manual",
    }),
    runtime,
    callbackTransport,
  });
  summary.manual_modal = {
    route: manualModalOutcome.result.route,
    custom_id: fetchCollector.requests.at(-1)?.body?.data?.custom_id ?? null,
  };

  const attachOutcome = await processGatewayInteraction({
    interaction: componentSelectInteraction({
      id: "attach-select-001",
      customId: "projects:attach_select",
      value: attachedThread.thread_id,
    }),
    runtime,
    callbackTransport,
  });
  summary.attach = {
    route: attachOutcome.result.route,
    project_key: attachOutcome.result.project_key,
    operator_message: attachOutcome.operator_message,
  };

  const manualAttachOutcome = await processGatewayInteraction({
    interaction: modalSubmitInteraction({
      id: "attach-manual-submit-001",
      customId: "projects:attach_manual_modal",
      values: {
        thread_id: attachedThread.thread_id,
      },
    }),
    runtime,
    callbackTransport,
  });
  summary.manual_attach = {
    route: manualAttachOutcome.result.route,
    project_key: manualAttachOutcome.result.project_key,
  };

  const slashAttachOutcome = await processGatewayInteraction({
    interaction: {
      ...commandInteraction({
        id: "attach-thread-command-001",
        commandName: "attach-thread",
      }),
      data: {
        name: "attach-thread",
        options: [
          {
            name: "thread_id",
            value: summary.threadShortId,
          },
        ],
      },
    },
    runtime,
    callbackTransport,
  });
  summary.slash_attach = {
    route: slashAttachOutcome.result.route,
    project_key: slashAttachOutcome.result.project_key,
    thread_id: slashAttachOutcome.result.thread_id ?? null,
  };

  if (crossWorkspaceThread) {
    const crossWorkspaceShortId = String(crossWorkspaceThread.thread_id ?? "").slice(0, 8);
    const crossWorkspaceAttachOutcome = await processGatewayInteraction({
      interaction: {
        ...commandInteraction({
          id: "attach-thread-cross-workspace-001",
          commandName: "attach-thread",
          guildId: "guild-cross-workspace",
          channelId: "channel-cross-workspace",
        }),
        data: {
          name: "attach-thread",
          options: [
            {
              name: "thread_id",
              value: crossWorkspaceShortId,
            },
          ],
        },
      },
      runtime,
      callbackTransport,
    });
    summary.cross_workspace_attach = {
      route: crossWorkspaceAttachOutcome.result.route,
      project_key: crossWorkspaceAttachOutcome.result.project_key,
      thread_id: crossWorkspaceAttachOutcome.result.thread_id ?? null,
    };

    const crossWorkspaceStatusOutcome = await processGatewayInteraction({
      interaction: commandInteraction({
        id: "attach-thread-cross-workspace-status-001",
        commandName: "status",
        guildId: "guild-cross-workspace",
        channelId: "channel-cross-workspace",
      }),
      runtime,
      callbackTransport,
    });
    summary.cross_workspace_status = {
      route: crossWorkspaceStatusOutcome.result.route,
      operator_message: crossWorkspaceStatusOutcome.operator_message,
      summary: crossWorkspaceStatusOutcome.result.summary ?? null,
    };
  }

  const stateDir = path.join(sharedBase, "remodex", "projects", attachOutcome.result.project_key, "state");
  summary.project_identity = await readJsonIfExists(path.join(stateDir, "project_identity.json"));
  summary.coordinator_binding = await readJsonIfExists(path.join(stateDir, "coordinator_binding.json"));
  summary.channel_bindings = await readJsonIfExists(
    path.join(sharedBase, "remodex", "router", "discord_channel_project_bindings.json"),
  );

  summary.finishedAt = new Date().toISOString();
  if (summary.all_scope.attach_scope !== "all") {
    throw new Error("all scope toggle did not switch attach scope");
  }
  if (!summary.cross_workspace_thread) {
    throw new Error("all scope did not surface any cross-workspace attach candidate");
  }
  if (summary.attach_autocomplete.first_choice_value !== attachedThread.thread_id) {
    throw new Error("attach-thread autocomplete did not surface canonical thread id");
  }
  if (summary.manual_modal.custom_id !== "projects:attach_manual_modal") {
    throw new Error("manual attach modal did not open");
  }
  if (!["thread_attached", "thread_attached_existing"].includes(summary.manual_attach.route)) {
    throw new Error("manual attach did not succeed");
  }
  if (!["thread_attached", "thread_attached_existing"].includes(summary.slash_attach.route)) {
    throw new Error("slash attach did not succeed");
  }
  if (summary.slash_attach.thread_id && summary.slash_attach.thread_id !== attachedThread.thread_id) {
    throw new Error("short thread id was not resolved back to canonical thread id");
  }
  if (
    summary.cross_workspace_attach &&
    !["thread_attached", "thread_attached_existing"].includes(summary.cross_workspace_attach.route)
  ) {
    throw new Error("cross-workspace attach did not succeed");
  }
  if (summary.cross_workspace_status) {
    const statusText = summary.cross_workspace_status.operator_message ?? "";
    if (!statusText.includes("display: 최종 조율자 스레드")) {
      throw new Error("cross-workspace status did not expose thread display name");
    }
    if (!statusText.includes("thread: 019cea08")) {
      throw new Error("cross-workspace status did not expose short thread id");
    }
    if (!statusText.includes("workspace: datarwin-phase1-baseline")) {
      throw new Error("cross-workspace status did not expose workspace label");
    }
    if (!statusText.includes("저장됨(notLoaded)")) {
      throw new Error("cross-workspace status did not translate attached thread state");
    }
    if (statusText.includes("main coordinator state refresh")) {
      throw new Error("cross-workspace status leaked bootstrap placeholder next batch");
    }
  }

  summary.status = "PASS";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = {
    message: error.message,
    stack: error.stack,
  };
} finally {
  if (runtime) {
    await runtime.close();
  }
  client?.close();
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status !== "PASS") {
    process.exitCode = 1;
  }
}
