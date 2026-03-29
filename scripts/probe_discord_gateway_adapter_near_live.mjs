import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildProjectPaths,
  ensureProjectDirs,
  listFilesSafe,
  readStructuredIfExists,
  readTextIfExists,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_adapter_near_live_probe_summary.json",
);

await fs.mkdir(verificationDir, { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createInteractionPayload({ id, token, commandName, projectKey, request = null }) {
  const options = [{ name: "project", value: projectKey }];
  if (request) {
    options.push({ name: "request", value: request });
  }
  return {
    id,
    application_id: "123456789012345678",
    token,
    type: 2,
    guild_id: "guild-near-live",
    channel_id: "channel-near-live",
    timestamp: new Date().toISOString(),
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

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([
      Buffer.from([0x81, payload.length]),
      payload,
    ]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      throw new Error("64-bit websocket payloads are not supported in probe");
    }

    const maskLength = masked ? 4 : 0;
    const totalLength = headerLength + maskLength + payloadLength;
    if (offset + totalLength > buffer.length) break;

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    let payload = buffer.subarray(payloadOffset, payloadOffset + payloadLength);

    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const decoded = Buffer.alloc(payloadLength);
      for (let index = 0; index < payloadLength; index += 1) {
        decoded[index] = payload[index] ^ mask[index % 4];
      }
      payload = decoded;
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      messages.push("__CLOSE__");
    }

    offset += totalLength;
  }

  return {
    messages,
    rest: buffer.subarray(offset),
  };
}

function websocketAcceptValue(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8")
    .digest("base64");
}

async function waitFor(check, { timeoutMs = 10000, intervalMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function readJsonIfExistsSafe(filePath) {
  const text = await readTextIfExists(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function startFakeCallbackApi() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({
      method: req.method,
      url: req.url,
      body,
    });

    if (req.method === "POST" && req.url?.includes("/callback")) {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "PATCH" && req.url?.includes("/messages/@original")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    apiBaseUrl: `http://127.0.0.1:${address.port}/api/v10`,
    requests,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startFakeGatewayServer() {
  const events = [];
  const sockets = new Set();
  const interactions = [
    createInteractionPayload({
      id: "interaction-status-1",
      token: "token-status-1",
      commandName: "status",
      projectKey: "project-alpha",
    }),
    createInteractionPayload({
      id: "interaction-intent-1",
      token: "token-intent-1",
      commandName: "intent",
      projectKey: "project-alpha",
      request: "run queued delivery",
    }),
  ];

  const server = http.createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAcceptValue(key)}`,
        "\r\n",
      ].join("\r\n"),
    );

    let rest = Buffer.alloc(0);
    let identifySeen = false;
    let interactionIndex = 0;

    socket.on("error", (error) => {
      events.push({
        type: "socket_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });

    const sendPayload = (payload) => {
      if (socket.destroyed || !socket.writable) {
        events.push({
          type: "socket_write_skipped",
          reason: "socket_not_writable",
          payload_type: payload.t ?? payload.op,
        });
        return false;
      }
      try {
        socket.write(encodeTextFrame(JSON.stringify(payload)));
        return true;
      } catch (error) {
        events.push({
          type: "socket_write_failed",
          message: error instanceof Error ? error.message : String(error),
          payload_type: payload.t ?? payload.op,
        });
        return false;
      }
    };

    const dispatchNextInteraction = () => {
      if (interactionIndex >= interactions.length) return;
      const interaction = interactions[interactionIndex];
      interactionIndex += 1;
      const seq = interactionIndex + 1;
      events.push({
        type: "interaction_sent",
        interaction_id: interaction.id,
        command: interaction.data.name,
        seq,
      });
      const sent = sendPayload({
        op: 0,
        t: "INTERACTION_CREATE",
        s: seq,
        d: interaction,
      });
      if (!sent) {
        events.push({
          type: "interaction_send_failed",
          interaction_id: interaction.id,
        });
      }
    };

    sendPayload({
      op: 10,
      d: { heartbeat_interval: 200 },
    });
    events.push({ type: "hello_sent" });

    socket.on("data", (chunk) => {
      rest = Buffer.concat([rest, chunk]);
      const parsed = decodeFrames(rest);
      rest = parsed.rest;
      for (const message of parsed.messages) {
        if (message === "__CLOSE__") {
          socket.end();
          return;
        }
        const payload = JSON.parse(message);
        events.push({ type: "client_payload", op: payload.op, event: payload.d ?? null });
        if (payload.op === 2 && !identifySeen) {
          identifySeen = true;
          sendPayload({
            op: 0,
            t: "READY",
            s: 1,
            d: {
              session_id: "near-live-session",
              resume_gateway_url: req.url
                ? `ws://127.0.0.1:${server.address().port}${req.url}`
                : `ws://127.0.0.1:${server.address().port}/`,
            },
          });
          events.push({ type: "ready_sent" });
          setTimeout(dispatchNextInteraction, 60);
          setTimeout(dispatchNextInteraction, 180);
        }

        if (payload.op === 1) {
          sendPayload({ op: 11, d: null });
          events.push({ type: "heartbeat_ack_sent" });
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    gatewayUrl: `ws://127.0.0.1:${address.port}/?v=10&encoding=json`,
    events,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-near-live-"));
  const sharedBase = path.join(tempRoot, "shared");
  const logsDir = path.join(tempRoot, "logs");
  const tokenPath = path.join(tempRoot, "discord-bot-token.txt");
  const stdoutPath = path.join(logsDir, "adapter.stdout.log");
  const stderrPath = path.join(logsDir, "adapter.stderr.log");
  const eventsLogPath = path.join(sharedBase, "remodex", "router", "discord_gateway_events.jsonl");
  const statePath = path.join(sharedBase, "remodex", "router", "discord_gateway_adapter_state.json");

  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(tokenPath, "discord-bot-token-placeholder\n");

  const paths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-alpha",
  });
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: "project-alpha",
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
    observed_at: new Date().toISOString(),
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(
    path.join(paths.stateDir, "strategy_binding.md"),
    "version: near-live-probe\ncurrent_focus: gateway-ingress-validation\n",
  );
  await writeAtomicText(
    path.join(paths.stateDir, "roadmap_status.md"),
    "phase: ingress\ncurrent_point: fake-discord-near-live\n",
  );

  const callbackApi = await startFakeCallbackApi();
  const gatewayServer = await startFakeGatewayServer();

  const child = spawn("node", ["scripts/remodex_discord_gateway_adapter.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      REMODEX_WORKSPACE: workspace,
      REMODEX_SHARED_BASE: sharedBase,
      REMODEX_WORKSPACE_KEY: "remodex",
      REMODEX_DISCORD_BOT_TOKEN_PATH: tokenPath,
      REMODEX_DISCORD_GATEWAY_URL: gatewayServer.gatewayUrl,
      REMODEX_DISCORD_API_BASE_URL: callbackApi.apiBaseUrl,
      REMODEX_DISCORD_GATEWAY_RECONNECT_DELAY_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", async (chunk) => {
    await fs.appendFile(stdoutPath, chunk);
  });
  child.stderr.on("data", async (chunk) => {
    await fs.appendFile(stderrPath, chunk);
  });

  const readyState = await waitFor(async () => {
    const state = await readJsonIfExistsSafe(statePath);
    if (!state) return null;
    if (
      state.snapshot?.ready_seen === true ||
      state.last_event_type === "ready" ||
      state.last_event_type === "interaction_create"
    ) {
      return state;
    }
    return null;
  });

  const observed = await waitFor(async () => {
    const outboxFiles = await listFilesSafe(paths.outboxDir, ".json");
    const dispatchFiles = await listFilesSafe(paths.dispatchQueueDir, ".json");
    const processedFiles = await listFilesSafe(paths.processedDir, ".json");
    if (outboxFiles.length < 1 || dispatchFiles.length < 1) return null;
    if (callbackApi.requests.filter((request) => request.method === "POST").length < 2) return null;
    if (callbackApi.requests.filter((request) => request.method === "PATCH").length < 2) return null;
    return { outboxFiles, dispatchFiles, processedFiles };
  }, { timeoutMs: 12000, intervalMs: 150 });

  child.kill("SIGTERM");
  const exit = await waitForChildExit(child);

  await gatewayServer.close();
  await callbackApi.close();

  const outboxFiles = await listFilesSafe(paths.outboxDir, ".json");
  const dispatchFiles = await listFilesSafe(paths.dispatchQueueDir, ".json");
  const quarantineFiles = await listFilesSafe(paths.quarantineDir, ".json");
  const processedFiles = await listFilesSafe(paths.processedDir, ".json");
  const latestOutboxPath = outboxFiles[0] ? path.join(paths.outboxDir, outboxFiles[0]) : null;
  const latestDispatchPath = dispatchFiles[0]
    ? path.join(paths.dispatchQueueDir, dispatchFiles[0])
    : null;
  const latestOutbox = latestOutboxPath ? await readStructuredIfExists(latestOutboxPath) : null;
  const latestDispatch = latestDispatchPath ? await readStructuredIfExists(latestDispatchPath) : null;
  const callbackPosts = callbackApi.requests.filter((request) => request.method === "POST");
  const callbackPatches = callbackApi.requests.filter((request) => request.method === "PATCH");
  const nearLiveOk =
    Boolean(readyState) &&
    Boolean(observed) &&
    callbackPosts.length >= 2 &&
    callbackPatches.length >= 2 &&
    outboxFiles.length >= 1 &&
    dispatchFiles.length >= 1 &&
    quarantineFiles.length === 0 &&
    exit.code === 0;

  const summary = {
    ok: nearLiveOk,
    shared_base: sharedBase,
    gateway_url: gatewayServer.gatewayUrl,
    callback_api_base_url: callbackApi.apiBaseUrl,
    adapter_exit: exit,
    ready_state_seen: Boolean(readyState),
    interaction_events_seen: gatewayServer.events.filter((event) => event.type === "interaction_sent").length,
    heartbeat_acks_seen: gatewayServer.events.filter((event) => event.type === "heartbeat_ack_sent").length,
    callback_post_count: callbackPosts.length,
    callback_patch_count: callbackPatches.length,
    outbox_count: outboxFiles.length,
    dispatch_queue_count: dispatchFiles.length,
    quarantine_count: quarantineFiles.length,
    processed_count: processedFiles.length,
    latest_outbox: latestOutbox,
    latest_dispatch_ticket: latestDispatch,
    callback_patch_contents: callbackPatches.map((request) => request.body?.content ?? null),
    evidence: {
      state_path: statePath,
      events_log_path: eventsLogPath,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
    },
  };

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
