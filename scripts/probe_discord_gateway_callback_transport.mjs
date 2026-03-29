import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DiscordGatewaySession, GatewayOpcode } from "./lib/discord_gateway_session.mjs";
import { DiscordGatewayAdapterRuntime } from "./lib/discord_gateway_adapter_runtime.mjs";
import { DiscordInteractionCallbackTransport } from "./lib/discord_interaction_callback_transport.mjs";
import { processGatewayInteraction } from "./lib/discord_gateway_operator_responder.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
} from "./lib/shared_memory_runtime.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_gateway_callback_transport_probe");
const sharedBase = path.join(probeRoot, "external-shared-memory");
const workspaceKey = "remodex";
const projectKey = "project-alpha";
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_callback_transport_probe_summary.json",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

class FakeGatewaySocket {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
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
}) {
  const options = [{ name: "project", value: project }];
  if (request) {
    options.push({ name: "request", value: request });
  }
  return {
    id,
    application_id: "app-123",
    token: `token-${id}`,
    type: 2,
    timestamp: new Date().toISOString(),
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: {
      user: { id: "operator-1" },
      roles: ["operator"],
    },
    data: {
      name: commandName,
      options,
    },
  };
}

async function listenServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const bodyChunks = [];
    for await (const chunk of req) {
      bodyChunks.push(chunk);
    }
    const rawBody = Buffer.concat(bodyChunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return { server, requests, port: server.address().port };
}

const summary = {
  startedAt: new Date().toISOString(),
  ackRequests: [],
  editRequests: [],
  operatorMessages: [],
};

const sockets = [];
let runtime = null;
let session = null;
let server = null;

function wsFactory(url) {
  const socket = new FakeGatewaySocket(url);
  sockets.push(socket);
  return socket;
}

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });

  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  await ensureProjectDirs(paths);
  await fs.writeFile(path.join(paths.stateDir, "project_identity.md"), "workspace_key: remodex\nproject_key: project-alpha\n");
  await fs.writeFile(path.join(paths.stateDir, "coordinator_status.md"), "type: idle\n");
  await fs.writeFile(path.join(paths.stateDir, "background_trigger_toggle.md"), "background_trigger_enabled: true\nforeground_session_active: false\n");
  await fs.writeFile(path.join(paths.stateDir, "operator_acl.md"), "status_allow: operator\nintent_allow: operator\nreply_allow: operator\napproval_allow: ops-admin\n");

  const fakeApi = await listenServer();
  server = fakeApi.server;

  runtime = new DiscordGatewayAdapterRuntime({
    sharedBase,
    workspaceKey,
    wsUrl: null,
  });
  const callbackTransport = new DiscordInteractionCallbackTransport({
    apiBaseUrl: `http://127.0.0.1:${fakeApi.port}/api/v10`,
  });

  session = new DiscordGatewaySession({
    gatewayUrl: "wss://gateway.discord.example/?v=10&encoding=json",
    token: "Bot gateway-token",
    intents: 0,
    wsFactory,
    reconnectDelayMs: 10,
    onInteractionCreate: async (interaction) => {
      const result = await processGatewayInteraction({
        interaction,
        runtime,
        callbackTransport,
      });
      summary.operatorMessages.push(result.operator_message);
    },
  });

  await session.start();

  const socket = sockets[0];
  socket.open();
  socket.serverSend({
    op: GatewayOpcode.HELLO,
    d: { heartbeat_interval: 1000 },
  });
  await sleep(5);
  socket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 1,
    t: "READY",
    d: {
      session_id: "session-ready-transport",
      resume_gateway_url: "wss://resume.discord.example",
    },
  });
  socket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 2,
    t: "INTERACTION_CREATE",
    d: commandInteraction({
      id: "interaction-status-transport",
      commandName: "status",
    }),
  });
  socket.serverSend({
    op: GatewayOpcode.DISPATCH,
    s: 3,
    t: "INTERACTION_CREATE",
    d: commandInteraction({
      id: "interaction-intent-transport",
      commandName: "intent",
      request: "prioritize integration tests",
    }),
  });
  await waitFor(() => fakeApi.requests.length >= 4);

  summary.ackRequests = fakeApi.requests.filter((request) => request.url?.includes("/callback"));
  summary.editRequests = fakeApi.requests.filter((request) => request.url?.includes("/messages/@original"));
  const inboxRecord = await waitFor(async () => {
    const inboxFiles = await fs.readdir(paths.inboxDir);
    if (!inboxFiles.length) return null;
    return await readJsonIfExists(path.join(paths.inboxDir, inboxFiles[0]));
  });
  const outboxRecord = await waitFor(async () => {
    const outboxFiles = await fs.readdir(paths.outboxDir);
    if (!outboxFiles.length) return null;
    return await readJsonIfExists(path.join(paths.outboxDir, outboxFiles[0]));
  });
  summary.intentInboxRecord = inboxRecord;
  summary.outboxRecord = outboxRecord;
  const editContents = summary.editRequests
    .map((request) => request.body?.content)
    .filter((content) => typeof content === "string");
  const hasStatusPatch = editContents.some((content) =>
    content.includes("project: project-alpha") &&
    content.includes("status: ") &&
    content.includes("queue: 0"),
  );
  const hasIntentPatch = editContents.some((content) =>
    content.includes("route: inbox") &&
    content.includes("project: project-alpha"),
  );
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.ackRequests.length === 2 &&
    summary.ackRequests.every((request) => request.body?.type === 5 && request.body?.data?.flags === 64) &&
    summary.editRequests.length === 2 &&
    hasStatusPatch &&
    hasIntentPatch &&
    summary.intentInboxRecord?.request === "prioritize integration tests" &&
    summary.outboxRecord?.type === "status_response"
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await session?.stop().catch(() => {});
  await runtime?.close().catch(() => {});
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord gateway callback transport probe failed");
}
