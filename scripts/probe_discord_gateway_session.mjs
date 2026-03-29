import fs from "node:fs/promises";
import path from "node:path";
import { DiscordGatewaySession, GatewayOpcode } from "./lib/discord_gateway_session.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_gateway_session_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const workspaceKey = "remodex";
const projectKey = "project-alpha";
const summaryPath = path.join(verificationDir, "discord_gateway_session_probe_summary.json");
const stateEventsPath = path.join(verificationDir, "discord_gateway_session_probe_events.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeGatewaySocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
  }

  addEventListener(type, handler) {
    const items = this.listeners.get(type) ?? [];
    items.push(handler);
    this.listeners.set(type, items);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000, reason = "closed") {
    this.closed = true;
    this.emit("close", { code, reason });
  }

  open() {
    this.emit("open", {});
  }

  serverSend(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

function commandInteraction({
  id,
  commandName,
  project = projectKey,
  request = null,
  roles = ["operator"],
}) {
  const options = [{ name: "project", value: project }];
  if (request) {
    options.push({ name: "request", value: request });
  }
  return {
    id,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: {
      user: { id: "operator-1" },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

const summary = {
  startedAt: new Date().toISOString(),
  sockets: [],
  readySessionId: null,
  resumeGatewayUrl: null,
  identifyPayload: null,
  resumePayload: null,
  statusOutboxSummary: null,
  intentInboxRecord: null,
  dispatchTicketCount: 0,
  sequenceAfterResume: null,
  stateEvents: [],
};

const socketList = [];
const stateEvents = [];
let runtime = null;
let session = null;

function wsFactory(url) {
  const socket = new FakeGatewaySocket(url);
  socketList.push(socket);
  summary.sockets.push({ url, sent: socket.sent });
  return socket;
}

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  await ensureProjectDirs(paths);
  await fs.writeFile(
    path.join(paths.stateDir, "project_identity.md"),
    "workspace_key: remodex\nproject_key: project-alpha\n",
  );
  await fs.writeFile(
    path.join(paths.stateDir, "coordinator_status.md"),
    "type: idle\n",
  );
  await fs.writeFile(
    path.join(paths.stateDir, "background_trigger_toggle.md"),
    "background_trigger_enabled: true\nforeground_session_active: false\n",
  );
  await fs.writeFile(
    path.join(paths.stateDir, "operator_acl.md"),
    "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n",
  );

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl: null,
    logPath: path.join(verificationDir, "discord_gateway_session_probe_events.jsonl"),
  });

  session = new DiscordGatewaySession({
    gatewayUrl: "wss://gateway.discord.example/?v=10&encoding=json",
    token: "Bot gateway-token",
    intents: 0,
    wsFactory,
    reconnectDelayMs: 10,
    heartbeatJitterMs: 0,
    onInteractionCreate: async (interaction) => {
      await runtime.handleInteractionPayload(interaction);
    },
    onStateChange: async (event) => {
      stateEvents.push({
        type: event.type,
        event_type: event.event_type ?? null,
        seq: event.seq ?? null,
      });
    },
    onReady: async (ready) => {
      summary.readySessionId = ready.session_id ?? null;
      summary.resumeGatewayUrl = ready.resume_gateway_url ?? null;
    },
  });

  await session.start();

  const firstSocket = socketList[0];
  firstSocket.open();
  firstSocket.serverSend({
    op: GatewayOpcode.HELLO,
    d: { heartbeat_interval: 20 },
  });
  await sleep(5);
  summary.identifyPayload = firstSocket.sent.find((payload) => payload.op === GatewayOpcode.IDENTIFY) ?? null;
  if (!summary.identifyPayload) {
    throw new Error("identify payload not sent after HELLO");
  }

  firstSocket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 1,
    t: "READY",
    d: {
      session_id: "session-ready-1",
      resume_gateway_url: "wss://resume.discord.example",
    },
  });
  firstSocket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 2,
    t: "INTERACTION_CREATE",
    d: commandInteraction({
      id: "interaction-status-1",
      commandName: "status",
    }),
  });
  await sleep(10);

  const outboxFiles = await fs.readdir(paths.outboxDir);
  const outboxRecord = outboxFiles.length
    ? await readJsonIfExists(path.join(paths.outboxDir, outboxFiles[0]))
    : null;
  summary.statusOutboxSummary = outboxRecord?.summary ?? null;
  if (!outboxRecord?.summary) {
    throw new Error("status interaction did not publish outbox summary");
  }

  firstSocket.serverSend({
    op: GatewayOpcode.RECONNECT,
    d: null,
  });
  await sleep(30);

  const secondSocket = socketList[1];
  if (!secondSocket) {
    throw new Error("reconnect did not open second socket");
  }
  secondSocket.open();
  secondSocket.serverSend({
    op: GatewayOpcode.HELLO,
    d: { heartbeat_interval: 20 },
  });
  await sleep(10);
  summary.resumePayload = secondSocket.sent.find((payload) => payload.op === GatewayOpcode.RESUME) ?? null;
  if (!summary.resumePayload) {
    throw new Error("resume payload not sent after reconnect HELLO");
  }

  secondSocket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 3,
    t: "RESUMED",
    d: {},
  });
  secondSocket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 4,
    t: "INTERACTION_CREATE",
    d: commandInteraction({
      id: "interaction-intent-2",
      commandName: "intent",
      request: "prioritize integration tests",
    }),
  });
  await sleep(10);

  const inboxFiles = await fs.readdir(paths.inboxDir);
  const dispatchFiles = await fs.readdir(paths.dispatchQueueDir);
  const inboxRecord = inboxFiles.length
    ? await readJsonIfExists(path.join(paths.inboxDir, inboxFiles[0]))
    : null;
  summary.intentInboxRecord = inboxRecord;
  summary.dispatchTicketCount = dispatchFiles.length;
  summary.sequenceAfterResume = session.snapshot().seq;
  summary.finishedAt = new Date().toISOString();
  summary.stateEvents = stateEvents;
  summary.status =
    summary.readySessionId === "session-ready-1" &&
    summary.resumeGatewayUrl === "wss://resume.discord.example" &&
    summary.identifyPayload?.d?.token === "Bot gateway-token" &&
    summary.resumePayload?.d?.session_id === "session-ready-1" &&
    summary.resumePayload?.d?.seq === 2 &&
    summary.statusOutboxSummary?.project_key === "project-alpha" &&
    summary.intentInboxRecord?.request === "prioritize integration tests" &&
    summary.dispatchTicketCount === 1 &&
    summary.sequenceAfterResume === 4 &&
    stateEvents.some((event) => event.type === "hello") &&
    stateEvents.some((event) => event.type === "dispatch" && event.event_type === "INTERACTION_CREATE")
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await session?.stop().catch(() => {});
  await runtime?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(stateEventsPath, `${JSON.stringify(stateEvents, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord gateway session probe failed");
}
