function renderConversationModeNote(conversationState = null) {
  if (!conversationState || conversationState.mode !== "mention_only") {
    return null;
  }
  const botName = conversationState.botUsername ?? "Remodex Pilot";
  return `대화 모드: mention_only. 평문 대화는 \`@${botName} 지금 어디까지 했어?\`처럼 멘션을 포함해야 합니다.`;
}

function pushConversationModeNote(lines, conversationState = null) {
  const note = renderConversationModeNote(conversationState);
  if (note) {
    lines.push(note);
  }
}

function summarizeStatus(summary, conversationState = null) {
  const lines = [];
  if (summary.project_display_name) {
    lines.push(`display: ${summary.project_display_name}`);
  }
  lines.push(`project: ${summary.project_key ?? "unknown"}`);
  if (summary.attached_thread_short_id) {
    lines.push(`thread: ${summary.attached_thread_short_id}`);
  }
  if (summary.attached_workspace_label) {
    lines.push(`workspace: ${summary.attached_workspace_label}`);
  }
  lines.push(`mode: ${renderProjectModeLabel(summary)}`);
  lines.push(`status: ${renderStatusLabel(summary.attached_thread_status ?? summary.coordinator_status)}`);
  if (summary.attached_thread_hint) {
    lines.push(`hint: ${summary.attached_thread_hint}`);
  }
  lines.push(`next: ${summary.next_smallest_batch ?? "none"}`);
  lines.push(`human_gate: ${summary.human_gate_candidate_count ?? 0}`);
  lines.push(`queue: ${summary.dispatch_queue_count ?? 0}`);
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function renderProjectModeLabel(summary) {
  if (summary.background_trigger_enabled === true && summary.foreground_session_active !== true) {
    return "background";
  }
  if (summary.background_trigger_enabled === false && summary.foreground_session_active === true) {
    return "foreground";
  }
  return "manual";
}

function renderStatusLabel(status) {
  const value = String(status ?? "unknown").trim();
  if (!value) return "unknown";
  if (value === "notLoaded") return "저장됨(notLoaded)";
  if (value === "idle") return "대기(idle)";
  if (value === "active") return "작업 중(active)";
  if (value === "waitingOnApproval") return "승인 대기(waitingOnApproval)";
  if (value === "waitingOnUserInput") return "입력 대기(waitingOnUserInput)";
  return value;
}

function summarizeProjects(projects, attachableThreads = [], attachScope = "recommended", conversationState = null) {
  if (!projects?.length && !attachableThreads?.length) {
    const lines = [
      "projects: none",
      "next: shared memory에 등록된 프로젝트가 없습니다.",
      "tip: 기존 thread는 직접 연결하거나, 새 프로젝트를 등록할 수 있습니다.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }

  const lines = [];
  if (projects?.length) {
    lines.push(`projects: ${projects.length}`);
    lines.push(
      ...projects.slice(0, 10).map((project) => {
        const hint = project.current_goal ?? project.current_focus ?? project.next_smallest_batch ?? "hint:none";
        const aliasText = (project.aliases ?? [])
          .filter((alias) => alias !== project.project_key)
          .slice(0, 3)
          .join(", ");
        const head = project.display_name && project.display_name !== project.project_key
          ? `${project.display_name} [${project.project_key}]`
          : project.project_key;
        return `- ${head}${aliasText ? ` (${aliasText})` : ""} — ${hint}`;
      }),
    );
  } else {
    lines.push("projects: none");
  }

  if (attachableThreads?.length) {
    lines.push(`attachable_threads: ${attachableThreads.length}`);
    lines.push(`attach_scope: ${attachScope}`);
    lines.push(
      ...attachableThreads.slice(0, 5).map((thread) => {
        const head = thread.display_name ?? `Codex Thread ${String(thread.thread_id ?? "").slice(0, 8)}`;
        const shortId = String(thread.thread_id ?? "").slice(0, 8);
        return `- ${head} [${shortId}] — ${thread.attach_hint ?? "attachable"}`;
      }),
    );
  }

  lines.push("tip: 추천 후보만 보거나, 다른 저장소를 포함한 전체 후보를 보거나, thread id로 직접 연결할 수 있습니다.");
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function truncateText(value, maxLength = 100) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function projectHint(project) {
  return project.current_goal ?? project.current_focus ?? project.next_smallest_batch ?? "hint:none";
}

function renderProjectPickerComponents(
  projects,
  selectedProjectKey = null,
  attachableThreads = [],
  attachScope = "recommended",
) {
  const selectedProject = (projects ?? []).find((project) => project.project_key === selectedProjectKey) ?? null;
  const selectedMode = selectedProject?.mode ?? "manual";
  const options = (projects ?? []).slice(0, 25).map((project) => ({
    label: truncateText(project.display_name ?? project.project_key, 100),
    description: truncateText(projectHint(project), 100),
    value: project.project_key,
    default: selectedProjectKey === project.project_key,
  }));

  const components = [];
  if (options.length) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "projects:select",
          placeholder: selectedProjectKey ? "다른 프로젝트 선택" : "프로젝트 선택",
          options,
          min_values: 1,
          max_values: 1,
        },
      ],
    });
  }

  const threadOptions = (attachableThreads ?? []).slice(0, 25).map((thread) => ({
    label: truncateText(thread.display_name ?? `Codex Thread ${String(thread.thread_id ?? "").slice(0, 8)}`, 100),
    description: truncateText(thread.attach_hint ?? "기존 Codex 스레드 연결", 100),
    value: thread.thread_id,
    default: false,
  }));
  if (threadOptions.length) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "projects:attach_select",
          placeholder: attachScope === "all" ? "기존 Codex 스레드 전체 보기 (다른 저장소 포함)" : "추천 Codex 스레드 연결",
          options: threadOptions,
          min_values: 1,
          max_values: 1,
        },
      ],
    });
  }

  if (selectedProjectKey) {
    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          custom_id: `projects:status:${selectedProjectKey}`,
          label: "상태 보기",
        },
        {
          type: 2,
          style: 2,
          custom_id: `projects:bind:${selectedProjectKey}`,
          label: "이 채널에 고정",
        },
        {
          type: 2,
          style: 1,
          custom_id: `projects:intent:${selectedProjectKey}`,
          label: "작업 지시",
        },
      ],
    });

    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: selectedMode === "background" ? 3 : 2,
          custom_id: `projects:background:${selectedProjectKey}`,
          label: "백그라운드 시작",
          disabled: selectedMode === "background",
        },
        {
          type: 2,
          style: selectedMode === "foreground" ? 1 : 2,
          custom_id: `projects:foreground:${selectedProjectKey}`,
          label: "앱 복귀",
          disabled: selectedMode === "foreground",
        },
      ],
    });
  }

  components.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: attachScope === "all" ? "projects:attach_scope_recommended" : "projects:attach_scope_all",
        label: attachScope === "all" ? "추천만 보기" : "다른 저장소 포함 전체 보기",
      },
      {
        type: 2,
        style: 2,
        custom_id: "projects:attach_manual",
        label: "직접 연결",
      },
      {
        type: 2,
        style: 2,
        custom_id: "projects:create",
        label: "새 프로젝트 등록",
      },
    ],
  });

  return components;
}

function renderIntentModal(projectKey) {
  return {
    custom_id: `projects:intent_modal:${projectKey}`,
    title: "작업 지시",
    components: [
      {
        type: 18,
        label: "메인에게 전달할 작업 지시",
        description: `${projectKey} 프로젝트에 기록됩니다.`,
        component: {
          type: 4,
          custom_id: "request",
          style: 2,
          min_length: 1,
          max_length: 1000,
          placeholder: "예: 로그인 테스트부터 진행하고 blocker만 보고해",
          required: true,
        },
      },
    ],
  };
}

function renderCreateProjectModal() {
  return {
    custom_id: "projects:create_modal",
    title: "새 프로젝트 등록",
    components: [
      {
        type: 18,
        label: "표시 이름",
        description: "Discord와 대시보드에 보일 프로젝트 이름입니다.",
        component: {
          type: 4,
          custom_id: "display_name",
          style: 1,
          min_length: 1,
          max_length: 100,
          placeholder: "예: 로그인 안정화",
          required: true,
        },
      },
      {
        type: 18,
        label: "프로젝트 키(선택)",
        description: "비워두면 이름에서 자동 생성합니다.",
        component: {
          type: 4,
          custom_id: "project_key",
          style: 1,
          min_length: 0,
          max_length: 100,
          placeholder: "예: project-login-stability",
          required: false,
        },
      },
      {
        type: 18,
        label: "초기 목표(선택)",
        description: "첫 상태 카드에 보일 목표입니다.",
        component: {
          type: 4,
          custom_id: "goal",
          style: 2,
          min_length: 0,
          max_length: 300,
          placeholder: "예: 로그인 흐름 안정화와 blocker 정리",
          required: false,
        },
      },
    ],
  };
}

function renderAttachThreadModal() {
  return {
    custom_id: "projects:attach_manual_modal",
    title: "기존 Codex thread 연결",
    components: [
      {
        type: 18,
        label: "Thread ID",
        description: "알고 있는 Codex thread id를 그대로 넣으세요.",
        component: {
          type: 4,
          custom_id: "thread_id",
          style: 1,
          min_length: 8,
          max_length: 100,
          placeholder: "예: 019cea08-0a5e-7193-98ad-4c13164bc7ec",
          required: true,
        },
      },
    ],
  };
}

function summarizeSelectedProject(project, conversationState = null) {
  if (!project) {
    const lines = ["project: unknown", "hint: 선택한 프로젝트 정보를 찾지 못했습니다."];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }
  const lines = [
    `project: ${project.project_key}`,
    `display: ${project.display_name ?? project.project_key}`,
    `mode: ${project.mode ?? "manual"}`,
    `goal: ${project.current_goal ?? "none"}`,
    `focus: ${project.current_focus ?? "none"}`,
    `next: ${project.next_smallest_batch ?? "none"}`,
    "tip: 버튼으로 상태 조회, 채널 고정, 작업 지시, background 시작, 앱 복귀를 이어갈 수 있습니다.",
  ];
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function summarizeModeUpdate(result, conversationState = null) {
  if (result.route === "project_mode_invalid") {
    const lines = [
      "route: project_mode_invalid",
      `project: ${result.project_key ?? "unknown"}`,
      `reason: ${result.reason ?? "invalid_mode_target"}`,
      "tip: background 시작 또는 앱 복귀 중 하나로 다시 시도하세요.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }

  const lines = ["route: project_mode_updated"];
  if (result.project?.display_name) {
    lines.push(`display: ${result.project.display_name}`);
  }
  lines.push(`project: ${result.project_key ?? "unknown"}`);
  lines.push(`mode: ${result.mode_target ?? "unknown"}`);
  if (result.mode_target === "background") {
    lines.push(`scheduler: ${result.scheduler_gate?.ready ? "armed" : "blocked"}`);
    if (result.summary?.coordinator_status) {
      lines.push(`status: ${renderStatusLabel(result.summary.coordinator_status)}`);
    }
    if (typeof result.summary?.inbox_count === "number") {
      lines.push(`inbox: ${result.summary.inbox_count}`);
    }
    if (typeof result.summary?.dispatch_queue_count === "number") {
      lines.push(`queue: ${result.summary.dispatch_queue_count}`);
    }
    if (result.scheduler_gate?.reasons?.length) {
      lines.push(`blocked_reasons: ${result.scheduler_gate.reasons.join(", ")}`);
    }
    if (
      result.scheduler_gate?.ready &&
      (result.summary?.inbox_count ?? 0) === 0 &&
      (result.summary?.dispatch_queue_count ?? 0) === 0
    ) {
      lines.push("tip: background는 켜졌고, 지금은 대기 요청이 없어 바로 처리할 일만 없습니다.");
    } else if (result.wake_strategy === "resume_attached_thread") {
      lines.push("tip: 다음 scheduler tick에서 기존 Codex 스레드를 다시 로드하고, 이후 inbox/dispatch 작업을 이어서 받을 수 있게 합니다.");
    } else {
      lines.push("tip: approval 대기나 must_human_check가 있으면 background는 계속 차단됩니다.");
    }
  } else if (result.mode_target === "foreground") {
    lines.push("scheduler: blocked_expected");
    lines.push("tip: 이제 이 채널의 작업은 foreground 메인 기준으로 이어집니다.");
  }
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function summarizeProjectResolutionHelp(result, conversationState = null) {
  const projects = result.available_projects ?? [];
  const lines = [];
  if (result.route === "unknown_project") {
    lines.push(`route: unknown_project`);
    if (result.requested_project) {
      lines.push(`requested: ${result.requested_project}`);
    }
  } else {
    lines.push(`route: project_required`);
  }
  if (result.bound_project_key) {
    lines.push(`current_channel_project: ${result.bound_project_key}`);
  }
  if (projects.length) {
    lines.push(`available: ${projects.slice(0, 8).map((project) => project.project_key).join(", ")}`);
  } else {
    lines.push("available: none");
  }
  lines.push("tip: /projects 또는 project 자동완성을 사용하세요.");
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function summarizeCreateProjectResult(result, conversationState = null) {
  if (result.route === "project_created") {
    const lines = [
      "route: project_created",
      `project: ${result.project_key}`,
      `display: ${result.display_name ?? result.project?.display_name ?? result.project_key}`,
      `goal: ${result.project?.current_goal ?? "none"}`,
      `channel_bound: ${result.auto_bound_channel ? "yes" : "no"}`,
      "tip: 이제 /status 또는 상태 보기 버튼으로 바로 확인할 수 있습니다.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }
  if (result.route === "create_project_conflict") {
    const lines = [
      "route: create_project_conflict",
      `project: ${result.project_key ?? "unknown"}`,
      "reason: 같은 project_key 가 이미 등록돼 있습니다.",
      "tip: 다른 키를 쓰거나 /projects 에서 기존 프로젝트를 선택하세요.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }
  const lines = [
    "route: create_project_invalid",
    `reason: ${result.reason ?? "invalid_request"}`,
    "tip: 표시 이름을 넣고, project key 는 비워두거나 영문 키를 지정하세요.",
  ];
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function summarizeThreadAttachResult(result, conversationState = null) {
  if (result.route === "thread_attached" || result.route === "thread_attached_existing") {
    const lines = [
      `route: ${result.route}`,
      ...(result.project?.display_name ? [`display: ${result.project.display_name}`] : []),
      `project: ${result.project_key ?? "unknown"}`,
      `thread: ${String(result.thread_id ?? "").slice(0, 8) || "unknown"}`,
      `channel_bound: ${result.auto_bound_channel ? "yes" : "no"}`,
      "tip: 이제 이 채널에서 /status, 상태 보기, 작업 지시를 바로 사용할 수 있습니다.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }
  const lines = [
    "route: thread_attach_invalid",
    `reason: ${result.reason ?? "invalid_request"}`,
    "tip: /projects 의 전체 보기나 /attach-thread thread_id:<...> 로 다시 시도하세요.",
  ];
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

function summarizeIngress(normalized, result, conversationState = null) {
  const resolvedProjectKey = result.project_key ?? normalized.project_key ?? "_unresolved";
  const displayName = result.project_display_name ?? result.project?.display_name ?? null;

  if (result.route === "projects") {
    return summarizeProjects(
      result.projects,
      result.attachable_threads ?? [],
      result.attach_scope ?? "recommended",
      conversationState,
    );
  }

  if (
    result.route === "project_created" ||
    result.route === "create_project_conflict" ||
    result.route === "create_project_invalid"
  ) {
    return summarizeCreateProjectResult(result, conversationState);
  }

  if (
    result.route === "thread_attached" ||
    result.route === "thread_attached_existing" ||
    result.route === "thread_attach_invalid"
  ) {
    return summarizeThreadAttachResult(result, conversationState);
  }

  if (result.route === "project_mode_updated" || result.route === "project_mode_invalid") {
    return summarizeModeUpdate(result, conversationState);
  }

  if (result.route === "channel_binding") {
    const lines = [
      "route: channel_binding",
      ...(displayName ? [`display: ${displayName}`] : []),
      `project: ${resolvedProjectKey}`,
      `resolved_via: ${result.resolved_via ?? "explicit"}`,
      "tip: 이제 같은 채널에서는 /status, /intent 에서 project를 생략할 수 있습니다.",
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }

  if (result.route === "project_required" || result.route === "unknown_project") {
    return summarizeProjectResolutionHelp(result, conversationState);
  }

  if (result.route === "quarantine") {
    const lines = [
      `route: quarantine`,
      ...(displayName ? [`display: ${displayName}`] : []),
      `project: ${resolvedProjectKey}`,
      `reason: ${result.quarantine_reason ?? "unknown"}`,
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }

  if (result.route === "human_gate_candidate") {
    const lines = [
      `route: human_gate_candidate`,
      ...(displayName ? [`display: ${displayName}`] : []),
      `project: ${resolvedProjectKey}`,
      `source_ref: ${normalized.source_ref}`,
      `state: await_human_gate`,
    ];
    pushConversationModeNote(lines, conversationState);
    return lines.join("\n");
  }

  const lines = [
    `route: ${result.route}`,
    ...(displayName ? [`display: ${displayName}`] : []),
    `project: ${resolvedProjectKey}`,
    `delivery: ${result.delivery_decision ?? "unknown"}`,
    `source_ref: ${normalized.source_ref}`,
  ];
  pushConversationModeNote(lines, conversationState);
  return lines.join("\n");
}

export function renderGatewayOperatorMessage({ normalized, result, conversationState = null }) {
  if (result.route === "project_selected") {
    return summarizeSelectedProject(result.project, conversationState);
  }
  if (normalized.command_class === "status" && result.route === "status") {
    return summarizeStatus(result.summary, conversationState);
  }
  return summarizeIngress(normalized, result, conversationState);
}

export async function processGatewayInteraction({
  interaction,
  runtime,
  callbackTransport,
  conversationState = null,
}) {
  if (interaction.type === 4) {
    const outcome = await runtime.handleInteractionPayload(interaction);
    await callbackTransport.respondAutocomplete(interaction, outcome.result.choices ?? []);
    return {
      ...outcome,
      operator_message: null,
      interaction_kind: "autocomplete",
    };
  }

  if (interaction.type === 3) {
    const shouldDeferUpdate = shouldDeferComponentInteraction(interaction);
    if (shouldDeferUpdate) {
      await callbackTransport.deferUpdateMessage(interaction);
    }
    const outcome = await runtime.handleInteractionPayload(interaction);
    const messageBody = buildComponentMessageBody(outcome, conversationState);
    if (outcome.response_plan?.initial_response === "modal") {
      await callbackTransport.openModal(interaction, messageBody);
    } else if (shouldDeferUpdate) {
      await callbackTransport.editOriginalResponse(interaction, messageBody);
    } else {
      await callbackTransport.updateMessage(interaction, messageBody);
    }
    return {
      ...outcome,
      operator_message: messageBody.content ?? null,
      interaction_kind: "component",
    };
  }

  await callbackTransport.deferChannelMessage(interaction, { ephemeral: true });
  const outcome = await runtime.handleInteractionPayload(interaction);
  const content = renderGatewayOperatorMessage({ ...outcome, conversationState });
  await callbackTransport.editOriginalResponse(
    interaction,
    buildDeferredMessageBody(outcome, content, conversationState),
  );
  return {
    ...outcome,
    operator_message: content,
    interaction_kind: interaction.type === 5 ? "modal_submit" : "command",
  };
}

function shouldDeferComponentInteraction(interaction) {
  const customId = String(interaction?.data?.custom_id ?? "");
  if (!customId) return true;
  if (customId.startsWith("projects:intent:")) return false;
  if (customId === "projects:create") return false;
  if (customId === "projects:attach_manual") return false;
  return true;
}

function buildDeferredMessageBody(outcome, content, conversationState = null) {
  const messageBody = {
    content,
    allowed_mentions: { parse: [] },
  };
  if (
    outcome.result.route === "projects" ||
    outcome.result.route === "project_required" ||
    outcome.result.route === "unknown_project" ||
    outcome.result.route === "project_created" ||
    outcome.result.route === "create_project_conflict" ||
    outcome.result.route === "create_project_invalid" ||
    outcome.result.route === "thread_attached" ||
    outcome.result.route === "thread_attached_existing" ||
    outcome.result.route === "thread_attach_invalid" ||
    outcome.result.route === "channel_binding" ||
    outcome.result.route === "project_mode_updated" ||
    outcome.result.route === "project_mode_invalid" ||
    outcome.result.route === "status"
  ) {
    const selectedProjectKey = outcome.result.project_key ?? null;
    messageBody.components = renderProjectPickerComponents(
      outcome.result.projects ?? outcome.result.available_projects ?? [],
      selectedProjectKey,
      outcome.result.attachable_threads ?? [],
      outcome.result.attach_scope ?? "recommended",
    );
  }
  return messageBody;
}

function buildComponentMessageBody(outcome, conversationState = null) {
  if (outcome.response_plan?.initial_response === "modal") {
    if (outcome.result.route === "create_project_modal") {
      return renderCreateProjectModal();
    }
    if (outcome.result.route === "attach_thread_modal") {
      return renderAttachThreadModal();
    }
    return renderIntentModal(outcome.result.project_key ?? outcome.normalized.project_key);
  }

  const content = renderGatewayOperatorMessage({ ...outcome, conversationState });
  const messageBody = {
    content,
    allowed_mentions: { parse: [] },
  };
  if (outcome.result.route === "project_selected") {
    messageBody.components = renderProjectPickerComponents(
      outcome.result.projects ?? [],
      outcome.result.project_key ?? null,
      outcome.result.attachable_threads ?? [],
      outcome.result.attach_scope ?? "recommended",
    );
    return messageBody;
  }
  if (
    outcome.result.route === "projects" ||
    outcome.result.route === "project_required" ||
    outcome.result.route === "unknown_project" ||
    outcome.result.route === "channel_binding" ||
    outcome.result.route === "status" ||
    outcome.result.route === "project_created" ||
    outcome.result.route === "create_project_conflict" ||
    outcome.result.route === "create_project_invalid" ||
    outcome.result.route === "thread_attached" ||
    outcome.result.route === "thread_attached_existing" ||
    outcome.result.route === "thread_attach_invalid" ||
    outcome.result.route === "project_mode_updated" ||
    outcome.result.route === "project_mode_invalid"
  ) {
    const selectedProjectKey =
      outcome.result.project_key ??
      outcome.normalized.project_key ??
      null;
    const projects = outcome.result.projects ?? outcome.result.available_projects ?? [];
    if (projects.length) {
      messageBody.components = renderProjectPickerComponents(
        projects,
        selectedProjectKey,
        outcome.result.attachable_threads ?? [],
        outcome.result.attach_scope ?? "recommended",
      );
    } else if ((outcome.result.attachable_threads ?? []).length) {
      messageBody.components = renderProjectPickerComponents(
        [],
        selectedProjectKey,
        outcome.result.attachable_threads ?? [],
        outcome.result.attach_scope ?? "recommended",
      );
    }
  }
  return messageBody;
}
