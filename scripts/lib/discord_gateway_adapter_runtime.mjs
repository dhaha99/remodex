import path from "node:path";
import { BridgeRuntime } from "./bridge_runtime.mjs";
import {
  createInitializedWsClient,
  listLoadedThreads,
  listStoredThreads,
} from "./app_server_jsonrpc.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  listProjectKeys,
  readJsonIfExists,
  readProjectSnapshot,
  safeFileFragment,
  summarizeSnapshot,
  writeAtomicJson,
  writeAtomicText,
  writeOutboxRecord,
} from "./shared_memory_runtime.mjs";
import { focusedInteractionOption, normalizeDiscordInteraction } from "./discord_transport.mjs";

const COMPONENT_CUSTOM_ID = Object.freeze({
  PROJECT_SELECT: "projects:select",
  PROJECT_ATTACH_SELECT: "projects:attach_select",
  PROJECT_ATTACH_SCOPE_ALL: "projects:attach_scope_all",
  PROJECT_ATTACH_SCOPE_RECOMMENDED: "projects:attach_scope_recommended",
  PROJECT_ATTACH_MANUAL: "projects:attach_manual",
  PROJECT_CREATE: "projects:create",
  PROJECT_STATUS: "projects:status",
  PROJECT_BIND: "projects:bind",
  PROJECT_INTENT: "projects:intent",
  PROJECT_ATTACH_MANUAL_MODAL: "projects:attach_manual_modal",
  PROJECT_CREATE_MODAL: "projects:create_modal",
  PROJECT_INTENT_MODAL: "projects:intent_modal",
});

export class DiscordGatewayAdapterRuntime {
  constructor({
    sharedBase,
    workspaceKey,
    wsUrl = null,
    logPath = null,
    serviceName = "remodex_discord_gateway_adapter",
    processedBy = "remodex_discord_gateway_adapter",
    workspaceCwd = process.cwd(),
  }) {
    this.sharedBase = sharedBase;
    this.workspaceKey = workspaceKey;
    this.wsUrl = wsUrl;
    this.logPath = logPath;
    this.serviceName = serviceName;
    this.processedBy = processedBy;
    this.workspaceCwd = workspaceCwd;
    this.runtimeByProject = new Map();
    this.channelBindingsPath = path.join(this.sharedBase, this.workspaceKey, "router", "discord_channel_project_bindings.json");
  }

  async close() {
    await Promise.all([...this.runtimeByProject.values()].map((runtime) => runtime.close()));
    this.runtimeByProject.clear();
  }

  async runtimeForProject(projectKey) {
    const key = projectKey ?? "_unresolved";
    if (this.runtimeByProject.has(key)) {
      return this.runtimeByProject.get(key);
    }
    const runtime = await BridgeRuntime.forProject({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey: key,
      wsUrl: this.wsUrl,
      logPath: this.logPath,
      serviceName: this.serviceName,
      processedBy: this.processedBy,
    });
    this.runtimeByProject.set(key, runtime);
    return runtime;
  }

  async publishOutbox(projectKey, type, record) {
    const runtime = await this.runtimeForProject(projectKey);
    return await writeOutboxRecord(
      runtime.paths,
      {
        workspace_key: this.workspaceKey,
        project_key: projectKey,
        type,
        emitted_at: new Date().toISOString(),
        ...record,
      },
      null,
    );
  }

  async handleInteractionPayload(payload) {
    if (payload.type === 3) {
      return await this.handleComponentPayload(payload);
    }
    if (payload.type === 5) {
      return await this.handleModalSubmitPayload(payload);
    }
    const normalized = normalizeDiscordInteraction(payload, this.workspaceKey);
    if (payload.type === 4) {
      return {
        normalized,
        ...(await this.handleAutocompletePayload(payload)),
      };
    }
    const result = await this.handleNormalizedCommand(normalized);
    return {
      normalized,
      ...result,
    };
  }

  async handleComponentPayload(payload) {
    const componentType = payload.data?.component_type ?? null;
    const customId = String(payload.data?.custom_id ?? "");
    const [family, action, rawProjectKey] = customId.split(":");
    const normalizedBase = {
      source: "discord",
      verified_identity: "gateway_session",
      operator_id: payload.member?.user?.id ?? null,
      operator_roles: payload.member?.roles ?? [],
      workspace_key: this.workspaceKey,
      raw_interaction_id: payload.id,
      raw_guild_id: payload.guild_id ?? null,
      raw_channel_id: payload.channel_id ?? null,
      received_at: payload.timestamp ?? new Date().toISOString(),
      correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
      source_ref: payload.id,
    };

    if (componentType === 3 && customId === COMPONENT_CUSTOM_ID.PROJECT_SELECT) {
      const selectedProjectKey = payload.data?.values?.[0] ?? null;
      const resolution = await this.resolveProjectReference({
        ...normalizedBase,
        command_class: "projects",
        project_key: selectedProjectKey,
      });
      if (!resolution.ok) {
        const attachScope = "recommended";
        return {
          normalized: {
            ...normalizedBase,
            command_name: "projects-select",
            command_class: "projects",
            auth_class: "status",
            project_key: selectedProjectKey,
          },
          result: {
            route: resolution.reason === "unknown_project" ? "unknown_project" : "project_required",
            delivery_decision: "blocked",
            requested_project: selectedProjectKey,
            available_projects: resolution.available_projects ?? [],
            attachable_threads: await this.listAttachableThreads({ scope: attachScope }),
            attach_scope: attachScope,
          },
          response_plan: {
            initial_response: "component_update",
            followup_source: "project_resolution_help",
            project_key: null,
          },
          project_resolution: resolution,
        };
      }
      const catalog = await this.listProjectCatalog();
      const attachScope = "recommended";
      const selectedProject = catalog.find((entry) => entry.project_key === resolution.project_key) ?? null;
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-select",
          command_class: "projects",
          auth_class: "status",
          project_key: resolution.project_key,
        },
        result: {
          route: "project_selected",
          delivery_decision: "not_applicable",
          project_key: resolution.project_key,
          project: selectedProject,
          projects: catalog,
          attachable_threads: await this.listAttachableThreads({ scope: attachScope }),
          attach_scope: attachScope,
        },
        response_plan: {
          initial_response: "component_update",
          followup_source: "project_selected",
          project_key: resolution.project_key,
        },
        project_resolution: resolution,
      };
    }

    if (componentType === 3 && customId === COMPONENT_CUSTOM_ID.PROJECT_ATTACH_SELECT) {
      const selectedThreadId = payload.data?.values?.[0] ?? null;
      const outcome = await this.attachExistingThread({
        threadId: selectedThreadId,
        operatorId: normalizedBase.operator_id,
        guildId: normalizedBase.raw_guild_id,
        channelId: normalizedBase.raw_channel_id,
      });
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-attach-select",
          command_class: "create-project",
          auth_class: "intent",
          project_key: outcome.result.project_key ?? null,
          thread_id: selectedThreadId,
        },
        ...outcome,
        response_plan: {
          ...(outcome.response_plan ?? {}),
          initial_response: "component_update",
        },
      };
    }

    if (componentType === 2 && customId === COMPONENT_CUSTOM_ID.PROJECT_ATTACH_SCOPE_ALL) {
      const outcome = await this.handleNormalizedCommand({
        ...normalizedBase,
        command_name: "projects-attach-scope-all",
        command_class: "projects",
        auth_class: "status",
        attach_scope: "all",
      });
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-attach-scope-all",
          command_class: "projects",
          auth_class: "status",
          attach_scope: "all",
        },
        ...outcome,
        response_plan: {
          ...(outcome.response_plan ?? {}),
          initial_response: "component_update",
        },
      };
    }

    if (componentType === 2 && customId === COMPONENT_CUSTOM_ID.PROJECT_ATTACH_SCOPE_RECOMMENDED) {
      const outcome = await this.handleNormalizedCommand({
        ...normalizedBase,
        command_name: "projects-attach-scope-recommended",
        command_class: "projects",
        auth_class: "status",
        attach_scope: "recommended",
      });
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-attach-scope-recommended",
          command_class: "projects",
          auth_class: "status",
          attach_scope: "recommended",
        },
        ...outcome,
        response_plan: {
          ...(outcome.response_plan ?? {}),
          initial_response: "component_update",
        },
      };
    }

    if (componentType === 2 && customId === COMPONENT_CUSTOM_ID.PROJECT_ATTACH_MANUAL) {
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-attach-manual-button",
          command_class: "attach-thread",
          auth_class: "intent",
          thread_id: null,
        },
        result: {
          route: "attach_thread_modal",
          delivery_decision: "not_applicable",
        },
        response_plan: {
          initial_response: "modal",
          followup_source: "attach_thread_modal",
          project_key: null,
        },
      };
    }

    if (componentType === 2 && customId === COMPONENT_CUSTOM_ID.PROJECT_CREATE) {
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-create-button",
          command_class: "create-project",
          auth_class: "intent",
          project_key: null,
          display_name: null,
          goal: null,
        },
        result: {
          route: "create_project_modal",
          delivery_decision: "not_applicable",
        },
        response_plan: {
          initial_response: "modal",
          followup_source: "create_project_modal",
          project_key: null,
        },
      };
    }

    if (family !== "projects" || !action || !rawProjectKey) {
      const attachScope = "recommended";
      return {
        normalized: {
          ...normalizedBase,
          command_name: "component-unknown",
          command_class: "status",
          auth_class: "status",
          project_key: null,
        },
        result: {
          route: "project_required",
          delivery_decision: "blocked",
          requested_project: null,
          available_projects: await this.listProjectCatalog(),
          attachable_threads: await this.listAttachableThreads({ scope: attachScope }),
          attach_scope: attachScope,
        },
        response_plan: {
          initial_response: "component_update",
          followup_source: "project_resolution_help",
          project_key: null,
        },
      };
    }

    if (action === "intent") {
      const resolution = await this.resolveProjectReference({
        ...normalizedBase,
        command_class: "intent",
        project_key: rawProjectKey,
      });
      return {
        normalized: {
          ...normalizedBase,
          command_name: "projects-intent-button",
          command_class: "intent",
          auth_class: "intent",
          project_key: resolution.project_key ?? rawProjectKey,
        },
        result: {
          route: "intent_modal",
          delivery_decision: "not_applicable",
          project_key: resolution.project_key ?? rawProjectKey,
        },
        response_plan: {
          initial_response: "modal",
          followup_source: "intent_modal",
          project_key: resolution.project_key ?? rawProjectKey,
        },
        project_resolution: resolution,
      };
    }

    const commandClass = action === "bind" ? "use-project" : "status";
    const normalized = {
      ...normalizedBase,
      command_name: `projects-${action}-button`,
      command_class: commandClass,
      auth_class: commandClass === "status" ? "status" : "intent",
      project_key: rawProjectKey,
      request: null,
      artifact: null,
    };
    const outcome = await this.handleNormalizedCommand(normalized);
    const catalog = await this.listProjectCatalog();
    const selectedProject =
      catalog.find((entry) => entry.project_key === (outcome.project_resolution?.project_key ?? rawProjectKey)) ?? null;
    return {
      normalized,
      ...outcome,
      result: {
        ...outcome.result,
        projects:
          outcome.result.projects ??
          catalog,
        project_key:
          outcome.result.project_key ??
          outcome.project_resolution?.project_key ??
          rawProjectKey,
        project:
          outcome.result.project ??
          selectedProject,
      },
      response_plan: {
        ...(outcome.response_plan ?? {}),
        initial_response: "component_update",
      },
    };
  }

  async handleModalSubmitPayload(payload) {
    const modalCustomId = String(payload.data?.custom_id ?? "");
    const [family, action, rawProjectKey] = modalCustomId.split(":");
    if (family === "projects" && action === "create_modal") {
      const displayName = extractModalTextValue(payload.data?.components, "display_name");
      const requestedProjectKey = extractModalTextValue(payload.data?.components, "project_key");
      const goal = extractModalTextValue(payload.data?.components, "goal");
      const normalized = {
        source: "discord",
        verified_identity: "gateway_session",
        operator_id: payload.member?.user?.id ?? null,
        operator_roles: payload.member?.roles ?? [],
        command_name: "projects-create-modal-submit",
        command_class: "create-project",
        auth_class: "intent",
        workspace_key: this.workspaceKey,
        project_key: requestedProjectKey,
        display_name: displayName,
        goal,
        source_ref: payload.id,
        request: null,
        artifact: null,
        correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
        received_at: payload.timestamp ?? new Date().toISOString(),
        raw_interaction_id: payload.id,
        raw_guild_id: payload.guild_id ?? null,
        raw_channel_id: payload.channel_id ?? null,
      };
      const outcome = await this.handleNormalizedCommand(normalized);
      return {
        normalized: {
          ...normalized,
          project_key: outcome.result.project_key ?? normalizeRequestedProjectKey(requestedProjectKey, displayName),
        },
        ...outcome,
        response_plan: {
          ...(outcome.response_plan ?? {}),
          initial_response: "deferred_ephemeral",
        },
      };
    }

    if (family === "projects" && action === "attach_manual_modal") {
      const threadId = extractModalTextValue(payload.data?.components, "thread_id");
      const normalized = {
        source: "discord",
        verified_identity: "gateway_session",
        operator_id: payload.member?.user?.id ?? null,
        operator_roles: payload.member?.roles ?? [],
        command_name: "projects-attach-manual-modal-submit",
        command_class: "attach-thread",
        auth_class: "intent",
        workspace_key: this.workspaceKey,
        thread_id: threadId,
        project_key: null,
        source_ref: payload.id,
        request: null,
        artifact: null,
        correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
        received_at: payload.timestamp ?? new Date().toISOString(),
        raw_interaction_id: payload.id,
        raw_guild_id: payload.guild_id ?? null,
        raw_channel_id: payload.channel_id ?? null,
      };
      const outcome = await this.handleNormalizedCommand(normalized);
      return {
        normalized,
        ...outcome,
        response_plan: {
          ...(outcome.response_plan ?? {}),
          initial_response: "deferred_ephemeral",
        },
      };
    }

    if (family !== "projects" || action !== "intent_modal" || !rawProjectKey) {
      return {
        normalized: {
          source: "discord",
          verified_identity: "gateway_session",
          operator_id: payload.member?.user?.id ?? null,
          operator_roles: payload.member?.roles ?? [],
          command_name: "modal-unknown",
          command_class: "intent",
          auth_class: "intent",
          workspace_key: this.workspaceKey,
          project_key: null,
          source_ref: payload.id,
          request: null,
          artifact: null,
          correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
          received_at: payload.timestamp ?? new Date().toISOString(),
          raw_interaction_id: payload.id,
          raw_guild_id: payload.guild_id ?? null,
          raw_channel_id: payload.channel_id ?? null,
        },
        result: {
          route: "project_required",
          delivery_decision: "blocked",
          available_projects: await this.listProjectCatalog(),
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "project_resolution_help",
          project_key: null,
        },
      };
    }

    const request = extractModalTextValue(payload.data?.components, "request");
    const normalized = {
      source: "discord",
      verified_identity: "gateway_session",
      operator_id: payload.member?.user?.id ?? null,
      operator_roles: payload.member?.roles ?? [],
      command_name: "projects-intent-modal-submit",
      command_class: "intent",
      auth_class: "intent",
      workspace_key: this.workspaceKey,
      project_key: rawProjectKey,
      source_ref: payload.id,
      request,
      artifact: null,
      correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
      received_at: payload.timestamp ?? new Date().toISOString(),
      raw_interaction_id: payload.id,
      raw_guild_id: payload.guild_id ?? null,
      raw_channel_id: payload.channel_id ?? null,
    };
    const outcome = await this.handleNormalizedCommand(normalized);
    return {
      normalized: {
        ...normalized,
        project_key: outcome.project_resolution?.project_key ?? normalized.project_key,
      },
      ...outcome,
      response_plan: {
        ...(outcome.response_plan ?? {}),
        initial_response: "deferred_ephemeral",
      },
    };
  }

  async handleAutocompletePayload(payload) {
    const focused = focusedInteractionOption(payload);
    if (!focused) {
      return {
        result: {
          route: "autocomplete",
          delivery_decision: "not_applicable",
          choices: [],
        },
        response_plan: {
          initial_response: "autocomplete",
          followup_source: "none",
          project_key: null,
        },
      };
    }

    if (focused.name === "thread_id" && payload.data?.name === "attach-thread") {
      const attachableThreads = await this.listAttachableThreads({ scope: "all", limit: 200 });
      const query = String(focused.value ?? "").trim().toLowerCase();
      const filtered = query
        ? attachableThreads.filter((thread) => {
            const haystack = [
              thread.thread_id,
              String(thread.thread_id ?? "").slice(0, 8),
              thread.display_name,
              thread.attach_hint,
              thread.prompt_hint,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            return haystack.includes(query);
          })
        : attachableThreads;
      const choices = filtered.slice(0, 25).map((thread) => ({
        name: truncateChoiceName(
          `${thread.display_name ?? `Codex Thread ${String(thread.thread_id ?? "").slice(0, 8)}`} [${String(thread.thread_id ?? "").slice(0, 8)}]`,
        ),
        value: thread.thread_id,
      }));
      return {
        result: {
          route: "autocomplete",
          delivery_decision: "not_applicable",
          choices,
        },
        response_plan: {
          initial_response: "autocomplete",
          followup_source: "none",
          project_key: null,
        },
      };
    }

    if (focused.name !== "project") {
      return {
        result: {
          route: "autocomplete",
          delivery_decision: "not_applicable",
          choices: [],
        },
        response_plan: {
          initial_response: "autocomplete",
          followup_source: "none",
          project_key: null,
        },
      };
    }

    const catalog = await this.listProjectCatalog();
    const query = String(focused.value ?? "").trim().toLowerCase();
    const filtered = query
      ? catalog.filter((entry) => {
          const haystack = [
            entry.project_key,
            entry.display_name,
            ...entry.aliases,
            entry.current_goal ?? "",
            entry.current_focus ?? "",
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return haystack.includes(query);
        })
      : catalog;
    const choices = filtered.slice(0, 25).map((entry) => ({
      name: truncateChoiceName(entry.choice_name),
      value: entry.project_key,
    }));
    return {
      result: {
        route: "autocomplete",
        delivery_decision: "not_applicable",
        choices,
      },
      response_plan: {
        initial_response: "autocomplete",
        followup_source: "none",
        project_key: null,
      },
    };
  }

  async handleNormalizedCommand(normalized) {
    if (normalized.command_class === "projects") {
      const attachScope = normalizeAttachScope(normalized.attach_scope);
      const catalog = await this.listProjectCatalog();
      const attachableThreads = await this.listAttachableThreads({ scope: attachScope });
      return {
        result: {
          route: "projects",
          delivery_decision: "not_applicable",
          projects: catalog,
          attachable_threads: attachableThreads,
          attach_scope: attachScope,
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "projects_catalog",
          project_key: null,
        },
      };
    }

    if (normalized.command_class === "create-project") {
      return await this.handleCreateProjectCommand(normalized);
    }

    if (normalized.command_class === "attach-thread") {
      return await this.attachExistingThread({
        threadId: normalized.thread_id,
        operatorId: normalized.operator_id,
        guildId: normalized.raw_guild_id,
        channelId: normalized.raw_channel_id,
      });
    }

    const resolution = await this.resolveProjectReference(normalized);
    if (!resolution.ok) {
      const attachScope = "recommended";
      return {
        result: {
          route: resolution.reason === "unknown_project" ? "unknown_project" : "project_required",
          delivery_decision: "blocked",
          requested_project: normalized.project_key ?? null,
          bound_project_key: resolution.bound_project_key ?? null,
          available_projects: resolution.available_projects ?? [],
          attachable_threads: await this.listAttachableThreads({ scope: attachScope }),
          attach_scope: attachScope,
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "project_resolution_help",
          project_key: null,
        },
      };
    }

    const effectiveNormalized = {
      ...normalized,
      project_key: resolution.project_key,
    };

    if (effectiveNormalized.command_class === "use-project") {
      const catalog = await this.listProjectCatalog();
      const project = catalog.find((entry) => entry.project_key === resolution.project_key) ?? null;
      await this.writeChannelBinding({
        guildId: effectiveNormalized.raw_guild_id,
        channelId: effectiveNormalized.raw_channel_id,
        projectKey: resolution.project_key,
        operatorId: effectiveNormalized.operator_id,
      });
      return {
        result: {
          route: "channel_binding",
          delivery_decision: "not_applicable",
          project_key: resolution.project_key,
          project,
          resolved_via: resolution.resolved_via,
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "channel_binding",
          project_key: resolution.project_key,
        },
      };
    }

    const projectKey = effectiveNormalized.project_key ?? "_unresolved";
    const runtime = await this.runtimeForProject(projectKey);
    const deliveryMode =
      effectiveNormalized.command_class === "status" || effectiveNormalized.command_class === "approve-candidate"
        ? "sync"
        : "async";
    const result = await runtime.handleCommand(effectiveNormalized, { deliveryMode });
    let outbox = null;

    if (effectiveNormalized.command_class === "status" && result.route === "status") {
      outbox = await this.publishOutbox(projectKey, "status_response", {
        source_ref: effectiveNormalized.source_ref,
        correlation_key: effectiveNormalized.correlation_key,
        operator_id: effectiveNormalized.operator_id ?? null,
        summary: result.summary,
      });
    }

    return {
      result,
      outbox,
      response_plan: buildResponsePlan(effectiveNormalized, result),
      project_resolution: resolution,
    };
  }

  async listProjectCatalog() {
    const projectKeys = await listProjectKeys(this.sharedBase, this.workspaceKey);
    const catalog = [];
    for (const projectKey of projectKeys) {
      if (projectKey === "_unresolved") continue;
      const paths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey,
      });
      await ensureProjectDirs(paths);
      const snapshot = await readProjectSnapshot(paths);
      if (!isCatalogProject(snapshot, projectKey)) continue;
      const summary = summarizeSnapshot(paths, snapshot);
      const displayName =
        snapshot.project_identity?.display_name ??
        snapshot.project_identity?.name ??
        projectKey;
      const aliases = buildProjectAliases(projectKey, snapshot.project_identity);
      const hint = summary.current_goal ?? summary.current_focus ?? summary.next_smallest_batch ?? null;
      catalog.push({
        project_key: projectKey,
        display_name: displayName,
        aliases,
        current_goal: summary.current_goal,
        current_focus: summary.current_focus,
        next_smallest_batch: summary.next_smallest_batch,
        choice_name: hint ? `${displayName} — ${hint}` : displayName,
      });
    }
    return catalog.sort((a, b) => a.project_key.localeCompare(b.project_key));
  }

  async listProjectBindings() {
    const projectKeys = await listProjectKeys(this.sharedBase, this.workspaceKey);
    const bindings = [];
    for (const projectKey of projectKeys) {
      if (projectKey === "_unresolved") continue;
      const paths = buildProjectPaths({
        sharedBase: this.sharedBase,
        workspaceKey: this.workspaceKey,
        projectKey,
      });
      const binding = await readJsonIfExists(path.join(paths.stateDir, "coordinator_binding.json"));
      if (!binding?.threadId) continue;
      const identity = await readJsonIfExists(path.join(paths.stateDir, "project_identity.json"));
      bindings.push({
        project_key: projectKey,
        thread_id: binding.threadId,
        display_name: identity?.display_name ?? projectKey,
      });
    }
    return bindings;
  }

  async withAppServerClient(work) {
    if (!this.wsUrl) return null;
    const client = await createInitializedWsClient(this.wsUrl, this.logPath, `${this.serviceName}_catalog`);
    try {
      return await work(client);
    } finally {
      client.close();
    }
  }

  async listAttachableThreads({ scope = "recommended", limit = 25 } = {}) {
    const attachScope = normalizeAttachScope(scope);
    const existingBindings = await this.listProjectBindings();
    const boundThreadIds = new Set(existingBindings.map((entry) => entry.thread_id));
    const threads =
      (await this.withAppServerClient(async (client) => {
        const loadedResult = await listLoadedThreads(client).catch(() => ({ data: [] }));
        const loadedIds = new Set(loadedResult?.data ?? []);
        const storedThreads =
          attachScope === "recommended"
            ? await listWorkspaceStoredThreads(client, this.workspaceCwd, 120)
            : await listStoredThreadsAcrossWorkspaces(client, 200);
        const storedById = new Map(storedThreads.map((thread) => [thread.id, thread]));

        const attachables = [];
        const seen = new Set();
        for (const thread of storedThreads) {
          if (!thread?.id || seen.has(thread.id) || boundThreadIds.has(thread.id)) continue;
          if (attachScope === "recommended" && !isWorkspaceThread(thread, this.workspaceCwd)) continue;
          if (isAttachNoiseThread(thread)) continue;
          seen.add(thread.id);
          const entry = buildAttachableThreadEntry(thread, loadedIds.has(thread.id), this.workspaceCwd);
          if (!entry.is_human_candidate) continue;
          attachables.push(entry);
        }

        for (const threadId of loadedIds) {
          if (seen.has(threadId) || boundThreadIds.has(threadId)) continue;
          seen.add(threadId);
          const enriched = await readMaterializedThreadForAttach(client, threadId);
          const liveThread = enriched?.thread ?? null;
          const mergedThread = mergeThreadMetadata(liveThread, storedById.get(threadId));
          if (!mergedThread) continue;
          if (attachScope === "recommended" && !isWorkspaceThread(mergedThread, this.workspaceCwd)) continue;
          if (isAttachNoiseThread(mergedThread)) continue;
          const entry = buildAttachableThreadEntry(mergedThread, true, this.workspaceCwd);
          if (!entry.is_human_candidate) continue;
          attachables.push(entry);
        }

        return attachables
          .sort(compareAttachableThreads)
          .slice(0, limit);
      })) ?? [];

    return threads;
  }

  async readChannelBindings() {
    const record = (await readJsonIfExists(this.channelBindingsPath)) ?? {};
    return record.bindings ?? {};
  }

  async writeChannelBinding({ guildId, channelId, projectKey, operatorId = null }) {
    if (!guildId || !channelId) {
      throw new Error("channel binding requires guildId and channelId");
    }
    const bindings = await this.readChannelBindings();
    bindings[channelBindingKey(guildId, channelId)] = {
      guild_id: guildId,
      channel_id: channelId,
      project_key: projectKey,
      operator_id: operatorId,
      updated_at: new Date().toISOString(),
    };
    await writeAtomicJson(this.channelBindingsPath, { bindings });
    return bindings[channelBindingKey(guildId, channelId)];
  }

  async resolveProjectReference(normalized) {
    const catalog = await this.listProjectCatalog();
    const requested = normalized.project_key ? String(normalized.project_key).trim() : "";
    if (requested) {
      const matched = matchProjectFromCatalog(requested, catalog);
      if (matched) {
        return {
          ok: true,
          project_key: matched.project_key,
          resolved_via: matched.project_key === requested ? "explicit" : "alias",
        };
      }
      return {
        ok: false,
        reason: "unknown_project",
        available_projects: catalog,
      };
    }

    if (normalized.raw_guild_id && normalized.raw_channel_id) {
      const bindings = await this.readChannelBindings();
      const binding = bindings[channelBindingKey(normalized.raw_guild_id, normalized.raw_channel_id)];
      if (binding?.project_key && catalog.some((entry) => entry.project_key === binding.project_key)) {
        return {
          ok: true,
          project_key: binding.project_key,
          resolved_via: "channel_binding",
          bound_project_key: binding.project_key,
        };
      }
    }

    if (catalog.length === 1) {
      return {
        ok: true,
        project_key: catalog[0].project_key,
        resolved_via: "single_project_default",
      };
    }

    return {
      ok: false,
      reason: "missing_project",
      available_projects: catalog,
    };
  }

  async handleCreateProjectCommand(normalized) {
    const displayName = String(normalized.display_name ?? "").trim();
    const requestedProjectKey = String(normalized.project_key ?? "").trim();
    const goal = String(normalized.goal ?? "").trim() || null;
    const projectKey = normalizeRequestedProjectKey(requestedProjectKey, displayName);
    if (!displayName) {
      return {
        result: {
          route: "create_project_invalid",
          delivery_decision: "blocked",
          reason: "missing_display_name",
          projects: await this.listProjectCatalog(),
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "create_project_invalid",
          project_key: null,
        },
      };
    }
    if (!projectKey || projectKey === "_unresolved") {
      return {
        result: {
          route: "create_project_invalid",
          delivery_decision: "blocked",
          reason: "invalid_project_key",
          projects: await this.listProjectCatalog(),
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "create_project_invalid",
          project_key: null,
        },
      };
    }

    const paths = buildProjectPaths({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey,
    });
    await ensureProjectDirs(paths);
    const existingIdentity = await readJsonIfExists(path.join(paths.stateDir, "project_identity.json"));
    if (existingIdentity?.project_key || existingIdentity?.display_name) {
      return {
        result: {
          route: "create_project_conflict",
          delivery_decision: "blocked",
          project_key: projectKey,
          display_name: existingIdentity.display_name ?? displayName,
          projects: await this.listProjectCatalog(),
        },
        response_plan: {
          initial_response: "deferred_ephemeral",
          followup_source: "create_project_conflict",
          project_key,
        },
      };
    }

    await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
      workspace_key: this.workspaceKey,
      project_key: projectKey,
      display_name: displayName,
      aliases: buildBootstrapAliases(projectKey, displayName),
      created_at: normalized.received_at ?? new Date().toISOString(),
      created_by: normalized.operator_id ?? null,
    });
    await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
      type: "idle",
      observed_at: normalized.received_at ?? new Date().toISOString(),
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
    await writeAtomicText(
      path.join(paths.stateDir, "current_goal.md"),
      `current_goal: ${goal ?? `${displayName} 초기 등록`}\n`,
    );
    await writeAtomicText(
      path.join(paths.stateDir, "current_focus.md"),
      "current_focus: project bootstrap\n",
    );
    await writeAtomicText(
      path.join(paths.stateDir, "progress_axes.md"),
      "next_smallest_batch: main coordinator bind\n",
    );

    if (normalized.raw_guild_id && normalized.raw_channel_id) {
      await this.writeChannelBinding({
        guildId: normalized.raw_guild_id,
        channelId: normalized.raw_channel_id,
        projectKey,
        operatorId: normalized.operator_id,
      });
    }

    const catalog = await this.listProjectCatalog();
    const createdProject = catalog.find((entry) => entry.project_key === projectKey) ?? {
      project_key: projectKey,
      display_name: displayName,
      aliases: buildBootstrapAliases(projectKey, displayName),
      current_goal: goal ?? `${displayName} 초기 등록`,
      current_focus: "project bootstrap",
      next_smallest_batch: "main coordinator bind",
    };

    return {
      result: {
        route: "project_created",
        delivery_decision: "not_applicable",
        project_key: projectKey,
        display_name: displayName,
        project: createdProject,
        projects: catalog,
        auto_bound_channel: Boolean(normalized.raw_guild_id && normalized.raw_channel_id),
      },
      response_plan: {
        initial_response: "deferred_ephemeral",
        followup_source: "project_created",
        project_key: projectKey,
      },
    };
  }

  async attachExistingThread({ threadId, operatorId = null, guildId = null, channelId = null }) {
    if (!threadId) {
      return {
        result: {
          route: "thread_attach_invalid",
          delivery_decision: "blocked",
          reason: "missing_thread_id",
          projects: await this.listProjectCatalog(),
          attachable_threads: await this.listAttachableThreads(),
        },
        response_plan: {
          initial_response: "component_update",
          followup_source: "thread_attach_invalid",
          project_key: null,
        },
      };
    }

    const resolvedThreadId = await this.resolveAttachThreadId(threadId);
    const existingBindings = await this.listProjectBindings();
    const existing = existingBindings.find((entry) => entry.thread_id === resolvedThreadId) ?? null;
    if (existing) {
      if (guildId && channelId) {
        await this.writeChannelBinding({
          guildId,
          channelId,
          projectKey: existing.project_key,
          operatorId,
        });
      }
      const catalog = await this.listProjectCatalog();
      const project = catalog.find((entry) => entry.project_key === existing.project_key) ?? null;
      return {
        result: {
          route: "thread_attached_existing",
          delivery_decision: "not_applicable",
          project_key: existing.project_key,
          thread_id: resolvedThreadId,
          project,
          projects: catalog,
          attachable_threads: await this.listAttachableThreads(),
          auto_bound_channel: Boolean(guildId && channelId),
        },
        response_plan: {
          initial_response: "component_update",
          followup_source: "thread_attached_existing",
          project_key: existing.project_key,
        },
      };
    }

    const thread =
      (await this.withAppServerClient(async (client) => {
        const threadRead = await client.request("thread/read", {
          threadId: resolvedThreadId,
          includeTurns: false,
        }).catch(() => null);
        return threadRead?.thread ?? null;
      })) ?? null;

    if (!thread) {
      return {
        result: {
          route: "thread_attach_invalid",
          delivery_decision: "blocked",
          reason: resolvedThreadId ? "thread_not_found" : "thread_reference_unresolved",
          projects: await this.listProjectCatalog(),
          attachable_threads: await this.listAttachableThreads(),
        },
        response_plan: {
          initial_response: "component_update",
          followup_source: "thread_attach_invalid",
          project_key: null,
        },
      };
    }

    const catalog = await this.listProjectCatalog();
    const displayName = inferThreadDisplayName(thread);
    const projectKey = allocateProjectKeyForThread(thread, catalog);
    const paths = buildProjectPaths({
      sharedBase: this.sharedBase,
      workspaceKey: this.workspaceKey,
      projectKey,
    });
    await ensureProjectDirs(paths);
    await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
      workspace_key: this.workspaceKey,
      project_key: projectKey,
      display_name: displayName,
      aliases: buildAttachedThreadAliases(projectKey, displayName, thread),
      source_kind: "codex_thread_attach",
      attached_thread_id: thread.id,
      cwd: thread.cwd ?? null,
      created_at: new Date().toISOString(),
      created_by: operatorId,
    });
    await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
      workspace_key: this.workspaceKey,
      project_key: projectKey,
      threadId: thread.id,
    });
    await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
      type: thread.status?.type ?? "idle",
      observed_at: new Date().toISOString(),
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
    await writeAtomicText(
      path.join(paths.stateDir, "current_goal.md"),
      `current_goal: ${displayName}\n`,
    );
    await writeAtomicText(
      path.join(paths.stateDir, "current_focus.md"),
      "current_focus: existing codex thread attached\n",
    );
    await writeAtomicText(
      path.join(paths.stateDir, "progress_axes.md"),
      "next_smallest_batch: main coordinator state refresh\n",
    );

    if (guildId && channelId) {
      await this.writeChannelBinding({
        guildId,
        channelId,
        projectKey,
        operatorId,
      });
    }

    const updatedCatalog = await this.listProjectCatalog();
    const project = updatedCatalog.find((entry) => entry.project_key === projectKey) ?? null;
    return {
      result: {
        route: "thread_attached",
        delivery_decision: "not_applicable",
        project_key: projectKey,
        thread_id: thread.id,
        project,
        projects: updatedCatalog,
        attachable_threads: await this.listAttachableThreads(),
        auto_bound_channel: Boolean(guildId && channelId),
      },
      response_plan: {
        initial_response: "component_update",
        followup_source: "thread_attached",
        project_key: projectKey,
      },
    };
  }

  async resolveAttachThreadId(threadRef) {
    const token = String(threadRef ?? "").trim();
    if (!token) return null;

    const existingBindings = await this.listProjectBindings();
    const exactBound = existingBindings.find((entry) => entry.thread_id === token);
    if (exactBound) return exactBound.thread_id;

    const normalized = token.toLowerCase();
    const boundPrefixMatches = existingBindings.filter((entry) =>
      String(entry.thread_id ?? "").toLowerCase().startsWith(normalized),
    );
    if (boundPrefixMatches.length === 1) return boundPrefixMatches[0].thread_id;

    const attachable = await this.listAttachableThreads({ scope: "all" });
    const exact = attachable.find((thread) => thread.thread_id === token);
    if (exact) return exact.thread_id;

    const prefixMatches = attachable.filter((thread) => String(thread.thread_id ?? "").toLowerCase().startsWith(normalized));
    if (prefixMatches.length === 1) return prefixMatches[0].thread_id;

    return token;
  }
}

function isCatalogProject(snapshot, projectKey) {
  const identityProjectKey = snapshot.project_identity?.project_key ?? null;
  if (!identityProjectKey) return false;
  if (identityProjectKey === "_unresolved") return false;
  return identityProjectKey === projectKey;
}

function buildResponsePlan(normalized, result) {
  if (result.route === "projects") {
    return {
      initial_response: "deferred_ephemeral",
      followup_source: "projects_catalog",
      project_key: null,
    };
  }

  if (result.route === "channel_binding") {
    return {
      initial_response: "deferred_ephemeral",
      followup_source: "channel_binding",
      project_key: result.project_key ?? null,
    };
  }

  if (result.route === "project_required" || result.route === "unknown_project") {
    return {
      initial_response: "deferred_ephemeral",
      followup_source: "project_resolution_help",
      project_key: null,
    };
  }

  if (result.route === "project_selected") {
    return {
      initial_response: "component_update",
      followup_source: "project_selected",
      project_key: result.project_key ?? null,
    };
  }

  if (result.route === "intent_modal") {
    return {
      initial_response: "modal",
      followup_source: "intent_modal",
      project_key: result.project_key ?? null,
    };
  }

  if (normalized.command_class === "status" && result.route === "status") {
    return {
      initial_response: "deferred_update",
      followup_source: "outbox_status_response",
      project_key: normalized.project_key,
    };
  }

  if (result.route === "quarantine") {
    return {
      initial_response: "deferred_ephemeral",
      followup_source: "quarantine",
      project_key: normalized.project_key ?? "_unresolved",
    };
  }

  if (result.route === "human_gate_candidate") {
    return {
      initial_response: "deferred_ephemeral",
      followup_source: "human_gate_candidate",
      project_key: normalized.project_key,
    };
  }

  return {
    initial_response: "deferred_ephemeral",
    followup_source: "inbox_or_dispatch",
    project_key: normalized.project_key,
  };
}

function extractModalTextValue(components, customId) {
  if (!Array.isArray(components)) return null;
  for (const item of components) {
    if (item?.component?.custom_id === customId && typeof item.component.value === "string") {
      return item.component.value;
    }
    if (item?.custom_id === customId && typeof item.value === "string") {
      return item.value;
    }
  }
  return null;
}

function buildProjectAliases(projectKey, projectIdentity = {}) {
  const aliases = new Set([projectKey]);
  if (projectKey.startsWith("project-")) {
    aliases.add(projectKey.slice("project-".length));
  }
  const identityAliases = projectIdentity?.aliases;
  if (Array.isArray(identityAliases)) {
    for (const alias of identityAliases) {
      if (alias) aliases.add(String(alias));
    }
  } else if (typeof identityAliases === "string" && identityAliases.trim()) {
    for (const alias of identityAliases.split(",")) {
      if (alias.trim()) aliases.add(alias.trim());
    }
  }
  for (const candidate of [projectIdentity?.display_name, projectIdentity?.name]) {
    if (candidate) aliases.add(String(candidate));
  }
  return [...aliases];
}

function normalizeProjectToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function matchProjectFromCatalog(requested, catalog) {
  const token = normalizeProjectToken(requested);
  if (!token) return null;
  const exact = catalog.find((entry) => normalizeProjectToken(entry.project_key) === token);
  if (exact) return exact;

  const exactAlias = catalog.filter((entry) =>
    entry.aliases.some((alias) => normalizeProjectToken(alias) === token),
  );
  if (exactAlias.length === 1) return exactAlias[0];

  const prefixMatches = catalog.filter((entry) => {
    const haystack = [entry.project_key, ...entry.aliases].map(normalizeProjectToken);
    return haystack.some((item) => item.startsWith(token));
  });
  if (prefixMatches.length === 1) return prefixMatches[0];

  return null;
}

function channelBindingKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function truncateChoiceName(value, maxLength = 100) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function isWorkspaceThread(thread, workspaceCwd) {
  if (!thread?.id) return false;
  if (!workspaceCwd) return true;
  return String(thread.cwd ?? "") === String(workspaceCwd);
}

async function listWorkspaceStoredThreads(client, workspaceCwd, limit = 100) {
  const collected = [];
  let cursor = null;
  while (collected.length < limit) {
    const page = await listStoredThreads(client, {
      limit: Math.min(50, limit - collected.length),
      archived: false,
      cwd: workspaceCwd,
      cursor,
    }).catch(() => ({ data: [], nextCursor: null }));
    const rows = page?.data ?? [];
    if (!rows.length) break;
    collected.push(...rows.filter((thread) => isWorkspaceThread(thread, workspaceCwd)));
    cursor = page?.nextCursor ?? null;
    if (!cursor) break;
  }
  return collected;
}

async function listStoredThreadsAcrossWorkspaces(client, limit = 200) {
  const collected = [];
  let cursor = null;
  while (collected.length < limit) {
    const page = await listStoredThreads(client, {
      limit: Math.min(50, limit - collected.length),
      archived: false,
      cursor,
    }).catch(() => ({ data: [], nextCursor: null }));
    const rows = page?.data ?? [];
    if (!rows.length) break;
    collected.push(...rows);
    cursor = page?.nextCursor ?? null;
    if (!cursor) break;
  }
  return collected;
}

async function readMaterializedThreadForAttach(client, threadId) {
  const threadRead = await client.request("thread/read", {
    threadId,
    includeTurns: true,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("includeTurns is unavailable before first user message")) {
      return null;
    }
    return null;
  });
  const thread = threadRead?.thread ?? null;
  if (!thread) return null;
  const preview = firstNonEmpty(thread.preview, extractThreadPromptFromTurns(thread.turns));
  return {
    thread: {
      ...thread,
      preview,
    },
  };
}

async function readAnyThreadForAttach(client, threadId) {
  const threadRead = await client.request("thread/read", {
    threadId,
    includeTurns: false,
  }).catch(() => null);
  const thread = threadRead?.thread ?? null;
  if (!thread) return null;
  return {
    thread,
  };
}

function mergeThreadMetadata(primary, secondary) {
  if (!primary && !secondary) return null;
  return {
    ...(secondary ?? {}),
    ...(primary ?? {}),
    status: primary?.status ?? secondary?.status ?? null,
    preview: firstNonEmpty(primary?.preview, secondary?.preview),
    name: firstNonEmpty(primary?.name, secondary?.name),
    cwd: firstNonEmpty(primary?.cwd, secondary?.cwd),
    updatedAt: primary?.updatedAt ?? secondary?.updatedAt ?? primary?.updated_at ?? secondary?.updated_at ?? null,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function buildAttachableThreadEntry(thread, isLoaded, currentWorkspaceCwd = null) {
  const displayName = inferThreadDisplayName(thread);
  const promptHint = summarizeThreadPrompt(thread);
  const workspaceLabel = summarizeThreadWorkspace(thread, currentWorkspaceCwd);
  const explicitName = String(thread?.name ?? "").trim();
  const isHumanCandidate = Boolean(promptHint || (explicitName && !looksGenericThreadName(explicitName)));
  return {
    thread_id: thread.id,
    display_name: displayName,
    is_loaded: isLoaded,
    status_type: thread.status?.type ?? "unknown",
    updated_at: thread.updatedAt ?? thread.updated_at ?? null,
    workspace_label: workspaceLabel,
    choice_name: buildAttachChoiceName(displayName, thread, isLoaded),
    attach_hint: buildAttachHint(thread, isLoaded, promptHint, workspaceLabel),
    preview: thread.preview ?? "",
    prompt_hint: promptHint,
    is_human_candidate: isHumanCandidate,
  };
}

function buildAttachChoiceName(displayName, thread, isLoaded) {
  const shortId = thread.id?.slice(0, 8) ?? "thread";
  return truncateChoiceName(`${displayName} [${shortId}]`);
}

function buildAttachHint(thread, isLoaded, promptHint = null, workspaceLabel = null) {
  const statusType = thread.status?.type ?? "unknown";
  const source = thread.source ?? "codex";
  const updatedText = formatThreadUpdatedAt(thread.updatedAt ?? thread.updated_at ?? null);
  const parts = [workspaceLabel, isLoaded ? "현재 열림" : "저장됨", statusType, source].filter(Boolean);
  if (updatedText) parts.push(updatedText);
  if (promptHint) parts.push(promptHint);
  return truncateChoiceName(parts.join(" · "), 100);
}

function normalizeRequestedProjectKey(requestedProjectKey, displayName) {
  const explicit = safeFileFragment(String(requestedProjectKey ?? "").trim()).toLowerCase();
  if (explicit) {
    return explicit.startsWith("project-") ? explicit : `project-${explicit}`;
  }
  const fromName = safeFileFragment(String(displayName ?? "").trim()).toLowerCase();
  if (fromName) {
    return fromName.startsWith("project-") ? fromName : `project-${fromName}`;
  }
  return `project-${Date.now().toString(36)}`;
}

function summarizeThreadWorkspace(thread, currentWorkspaceCwd = null) {
  const cwd = String(thread?.cwd ?? "").trim();
  if (!cwd) return "unknown-workspace";
  const label = path.basename(cwd) || cwd;
  if (currentWorkspaceCwd && cwd === currentWorkspaceCwd) {
    return `${label} (현재 저장소)`;
  }
  return label;
}

function normalizeAttachScope(value) {
  return value === "all" ? "all" : "recommended";
}

function buildBootstrapAliases(projectKey, displayName) {
  const aliases = new Set([projectKey]);
  if (projectKey.startsWith("project-")) {
    aliases.add(projectKey.slice("project-".length));
  }
  if (displayName) {
    aliases.add(String(displayName));
  }
  return [...aliases].filter(Boolean);
}

function inferThreadDisplayName(thread) {
  const explicit = String(thread?.name ?? "").trim();
  if (explicit && !looksGenericThreadName(explicit)) return truncateChoiceName(explicit, 80);
  const promptHint = summarizeThreadPrompt(thread);
  if (promptHint) {
    return truncateChoiceName(promptHint, 80);
  }
  return `Codex Thread ${String(thread?.id ?? "").slice(0, 8)}`;
}

function allocateProjectKeyForThread(thread, catalog) {
  const token = safeFileFragment(inferThreadDisplayName(thread)).toLowerCase();
  const base = token ? `project-${token}` : `project-${String(thread.id).slice(0, 8)}`;
  const used = new Set((catalog ?? []).map((entry) => entry.project_key));
  if (!used.has(base)) return base;
  const withId = `${base}-${String(thread.id).slice(0, 8).toLowerCase()}`;
  if (!used.has(withId)) return withId;
  let index = 2;
  while (used.has(`${withId}-${index}`)) {
    index += 1;
  }
  return `${withId}-${index}`;
}

function buildAttachedThreadAliases(projectKey, displayName, thread) {
  const aliases = new Set(buildBootstrapAliases(projectKey, displayName));
  aliases.add(String(thread.id).slice(0, 8));
  return [...aliases].filter(Boolean);
}

function looksGenericThreadName(name) {
  return /^codex thread\s+[0-9a-f]{8}$/i.test(String(name ?? "").trim());
}

function summarizeThreadPrompt(thread) {
  const preview = normalizePreviewText(thread?.preview);
  if (!preview) return null;
  const cleaned = preview
    .replace(/^automation:\s*/i, "")
    .replace(/^you are resuming as this project's main coordinator\.?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstSentence = cleaned.split(/[\n.!?]/).find((line) => line.trim()) ?? cleaned;
  return truncateChoiceName(firstSentence, 72);
}

function extractThreadPromptFromTurns(turns) {
  if (!Array.isArray(turns)) return null;
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      const candidate = firstNonEmpty(
        item?.text,
        item?.summary,
        item?.title,
        item?.rawInput,
        item?.prompt,
      );
      if (candidate) return candidate;
    }
  }
  return null;
}

function normalizePreviewText(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text;
}

function isAttachNoiseThread(thread) {
  const haystack = `${thread?.name ?? ""}\n${thread?.preview ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return (
    haystack.includes("automation:") ||
    haystack.includes("/verification/") ||
    haystack.includes("probe_") ||
    haystack.includes("probe ") ||
    haystack.includes("plugin://") ||
    haystack.includes("[@slack]") ||
    haystack.includes("you are resuming as this project's main coordinator") ||
    haystack.includes("automation id:")
  );
}

function parseThreadUpdatedAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function formatThreadUpdatedAt(value) {
  const timestamp = parseThreadUpdatedAt(value);
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function compareAttachableThreads(left, right) {
  const loadedDelta = Number(right.is_loaded) - Number(left.is_loaded);
  if (loadedDelta !== 0) return loadedDelta;
  const hintedDelta = Number(Boolean(right.prompt_hint)) - Number(Boolean(left.prompt_hint));
  if (hintedDelta !== 0) return hintedDelta;
  const namedDelta = Number(Boolean(right.display_name)) - Number(Boolean(left.display_name));
  if (namedDelta !== 0) return namedDelta;
  return parseThreadUpdatedAt(right.updated_at) - parseThreadUpdatedAt(left.updated_at);
}
