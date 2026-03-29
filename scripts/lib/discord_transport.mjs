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
  if (commandName === "use-project") return "use-project";
  if (commandName === "status" || commandName === "refresh-status") return "status";
  if (commandName === "reply") return "reply";
  if (commandName === "approve" || commandName === "approve-candidate") return "approve-candidate";
  return "intent";
}

export function normalizeDiscordInteraction(payload, workspaceKey = "remodex") {
  const commandName = payload.data?.name ?? null;
  const commandClass = normalizeCommandClass(commandName);
  return {
    source: "discord",
    verified_identity: "signature_verified",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: payload.member?.roles ?? [],
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
