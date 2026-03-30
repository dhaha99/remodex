import crypto from "node:crypto";

export class ReplayCache {
  constructor() {
    this.seen = new Set();
  }

  claim(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

export function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function correlationKey(payload) {
  return `${payload.guild_id}:${payload.channel_id}:${payload.id}`;
}

export function verifyDiscordStyleRequest({
  publicKey,
  signatureHex,
  timestamp,
  rawBody,
  interactionId,
  replayCache,
  maxAgeSeconds = 300,
}) {
  if (!signatureHex || !timestamp || !rawBody || !interactionId) {
    return { ok: false, reason: "missing_required_fields", httpStatus: 400 };
  }

  if (Math.abs(nowEpochSeconds() - Number(timestamp)) > maxAgeSeconds) {
    return { ok: false, reason: "stale_timestamp", httpStatus: 401 };
  }

  const replayKey = `${interactionId}:${timestamp}:${signatureHex}`;
  if (!replayCache.claim(replayKey)) {
    return { ok: false, reason: "replay_detected", httpStatus: 409 };
  }

  const verified = crypto.verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`, "utf8"),
    publicKey,
    Buffer.from(signatureHex, "hex"),
  );
  if (!verified) {
    return { ok: false, reason: "invalid_signature", httpStatus: 401 };
  }

  return { ok: true, reason: "accepted", httpStatus: 202 };
}

function interactionOptionValue(payload, name) {
  return payload.data?.options?.find((option) => option.name === name)?.value ?? null;
}

export function focusedInteractionOption(payload) {
  return payload.data?.options?.find((option) => option.focused) ?? null;
}

function normalizeCommandClass(commandName) {
  if (commandName === "projects") return "projects";
  if (commandName === "create-project") return "create-project";
  if (commandName === "attach-thread") return "attach-thread";
  if (commandName === "background-on" || commandName === "foreground-on") return "set-mode";
  if (commandName === "use-project") return "use-project";
  if (commandName === "status" || commandName === "refresh-status") return "status";
  if (commandName === "reply") return "reply";
  if (commandName === "approve" || commandName === "approve-candidate") return "approve-candidate";
  return "intent";
}

export function resolveDiscordOperatorRoles(payload, commandClass = null) {
  const rawRoles = Array.isArray(payload.member?.roles)
    ? payload.member.roles.map((role) => String(role)).filter(Boolean)
    : [];
  const roles = new Set(rawRoles);
  if (roles.size === 0 && commandClass !== "approve-candidate") {
    roles.add("operator");
  }
  return [...roles];
}

function stripBotMentionPrefix(content, botUserId = null) {
  let text = String(content ?? "").trim();
  if (!text || !botUserId) return text;
  const mentionPatterns = [
    new RegExp(`^<@!?${botUserId}>\\s*`, "i"),
  ];
  for (const pattern of mentionPatterns) {
    text = text.replace(pattern, "");
  }
  return text.trim();
}

function isStatusLikeText(content) {
  const text = String(content ?? "").trim();
  if (!text) return false;
  const directPatterns = [
    /(^|\s)status(\s|$|\?)/i,
    /(^|\s)progress(\s|$|\?)/i,
    /진행\s*상황/,
    /진행\s*상태/,
    /현재\s*상태/,
    /상태가?\s*어때/,
    /지금\s*뭐/,
    /뭐하고\s*있/,
    /어디까지/,
    /현황/,
    /how far/i,
    /what(?:'s| is).*(status|progress)/i,
    /what are you doing/i,
  ];
  return directPatterns.some((pattern) => pattern.test(text));
}

function normalizeConversationText(content, botUserId = null) {
  return stripBotMentionPrefix(content, botUserId).trim();
}

function normalizeMessageCommandClass(content) {
  const text = String(content ?? "").trim();
  if (!text) return null;

  const backgroundPatterns = [
    /^\/background-on\b/i,
    /^(백그라운드\s*시작|백그라운드\s*켜|크론\s*시작)$/i,
    /백그라운드.*(시작|켜|on|활성화|전환)/i,
    /(스케줄러|스케쥴러|크론).*(시작|켜|on|활성화|가동)/i,
  ];
  if (backgroundPatterns.some((pattern) => pattern.test(text))) {
    return { commandClass: "set-mode", commandName: "conversation-background-on", modeTarget: "background" };
  }
  const foregroundPatterns = [
    /^\/foreground-on\b/i,
    /^(앱\s*복귀|포그라운드\s*복귀|foreground)$/i,
    /(앱|포그라운드|foreground).*(복귀|전환|켜|on)/i,
  ];
  if (foregroundPatterns.some((pattern) => pattern.test(text))) {
    return { commandClass: "set-mode", commandName: "conversation-foreground-on", modeTarget: "foreground" };
  }
  if (/^\/status\b/i.test(text) || isStatusLikeText(text)) {
    return { commandClass: "status", commandName: "conversation-status", modeTarget: null };
  }
  if (/^\/reply\b/i.test(text)) {
    return { commandClass: "reply", commandName: "conversation-reply", modeTarget: null };
  }
  return { commandClass: "intent", commandName: "conversation-intent", modeTarget: null };
}

export function normalizeDiscordInteraction(payload, workspaceKey = "remodex") {
  const commandName = payload.data?.name ?? null;
  const commandClass = normalizeCommandClass(commandName);
  return {
    source: "discord",
    verified_identity: "signature_verified",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: resolveDiscordOperatorRoles(payload, commandClass),
    command_name: commandName,
    command_class: commandClass,
    auth_class:
      commandClass === "approve-candidate"
        ? "approval"
        : commandClass === "projects" || commandClass === "status"
          ? "status"
          : "intent",
    workspace_key: workspaceKey,
    project_key:
      commandClass === "create-project"
        ? interactionOptionValue(payload, "key")
        : interactionOptionValue(payload, "project"),
    display_name:
      commandClass === "create-project"
        ? interactionOptionValue(payload, "name")
        : null,
    goal:
      commandClass === "create-project"
        ? interactionOptionValue(payload, "goal")
        : null,
    mode_target:
      commandName === "background-on"
        ? "background"
        : commandName === "foreground-on"
          ? "foreground"
          : null,
    thread_id:
      commandClass === "attach-thread"
        ? interactionOptionValue(payload, "thread_id")
        : null,
    source_ref: interactionOptionValue(payload, "source_ref") ?? payload.id,
    request: interactionOptionValue(payload, "request"),
    artifact: interactionOptionValue(payload, "artifact"),
    correlation_key: correlationKey(payload),
    received_at: payload.timestamp ?? new Date().toISOString(),
    raw_interaction_id: payload.id,
    raw_guild_id: payload.guild_id ?? null,
    raw_channel_id: payload.channel_id ?? null,
  };
}

export function normalizeDiscordMessageCreate(
  payload,
  workspaceKey = "remodex",
  { botUserId = null } = {},
) {
  const content = normalizeConversationText(payload.content, botUserId);
  const command = normalizeMessageCommandClass(content);
  if (!command) return null;

  let request = content;
  if (command.commandClass === "status" || command.commandClass === "set-mode") {
    request = null;
  } else if (command.commandClass === "reply") {
    request = content.replace(/^\/reply\b/i, "").trim() || content;
  } else if (command.commandClass === "intent" && /^\/intent\b/i.test(content)) {
    request = content.replace(/^\/intent\b/i, "").trim() || content;
  }

  return {
    source: "discord",
    verified_identity: "gateway_session",
    operator_id: payload.author?.id ?? payload.member?.user?.id ?? null,
    operator_roles: resolveDiscordOperatorRoles(payload, command.commandClass),
    command_name: command.commandName,
    command_class: command.commandClass,
    auth_class:
      command.commandClass === "status"
        ? "status"
        : command.commandClass === "approve-candidate"
          ? "approval"
          : "intent",
    workspace_key: workspaceKey,
    project_key: null,
    display_name: null,
    goal: null,
    mode_target: command.modeTarget,
    thread_id: null,
    source_ref: payload.id,
    request,
    artifact: null,
    correlation_key: `${payload.guild_id}:${payload.channel_id}:${payload.id}`,
    received_at: payload.timestamp ?? new Date().toISOString(),
    raw_interaction_id: null,
    raw_message_id: payload.id,
    raw_guild_id: payload.guild_id ?? null,
    raw_channel_id: payload.channel_id ?? null,
  };
}

export function discordMessageMentionsBot(payload, botUserId = null) {
  if (!botUserId) return false;
  const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
  if (mentions.some((entry) => String(entry?.id ?? "") === String(botUserId))) {
    return true;
  }
  const text = String(payload.content ?? "");
  return text.includes(`<@${botUserId}>`) || text.includes(`<@!${botUserId}>`);
}
