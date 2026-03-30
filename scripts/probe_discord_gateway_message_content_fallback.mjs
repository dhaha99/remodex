import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_gateway_message_content_fallback_probe");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_message_content_fallback_probe_summary.json",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function websocketAcceptValue(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, "utf8")
    .digest("base64");
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame(code, reason = "") {
  const reasonBuffer = Buffer.from(reason, "utf8");
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
  }
  throw new Error("close payload too large");
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
      throw new Error("64-bit websocket payloads are not supported");
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
    }

    offset += totalLength;
  }

  return {
    messages,
    rest: buffer.subarray(offset),
  };
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function startFakeDiscordRest() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.method,
      url: req.url,
      body: bodyText ? JSON.parse(bodyText) : null,
    });
    if (req.method === "POST" && req.url?.includes("/messages")) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: `message-${requests.length}` }));
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
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startFakeGatewayServer() {
  const sockets = new Set();
  const events = [];
  let identifyCount = 0;
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

    const sendPayload = (payload) => {
      if (socket.destroyed || !socket.writable) return;
      socket.write(encodeTextFrame(JSON.stringify(payload)));
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
        const payload = JSON.parse(message);
        events.push({ type: "client_payload", op: payload.op ?? null });
        if (payload.op === 1) {
          sendPayload({ op: 11 });
          continue;
        }
        if (payload.op !== 2) continue;

        identifyCount += 1;
        const requestedIntents = payload.d?.intents ?? null;
        events.push({
          type: "identify_received",
          identify_count: identifyCount,
          intents: requestedIntents,
        });

        if (identifyCount === 1 && requestedIntents === 33281) {
          socket.write(encodeCloseFrame(4014, "Disallowed intent(s)."));
          socket.end();
          events.push({ type: "close_sent", code: 4014 });
          continue;
        }

        sendPayload({
          op: 0,
          t: "READY",
          s: 1,
          d: {
            session_id: "session-fallback-ready",
            user: { id: "bot-fallback", username: "Remodex Pilot" },
          },
        });
        events.push({ type: "ready_sent" });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    gatewayUrl: `ws://127.0.0.1:${address.port}`,
    events,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const summary = {
  startedAt: new Date().toISOString(),
};

let restServer = null;
let gatewayServer = null;
let adapter = null;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.mkdir(probeRoot, { recursive: true });

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const routerRoot = path.join(sharedBase, "remodex", "router");

  restServer = await startFakeDiscordRest();
  gatewayServer = await startFakeGatewayServer();

  const stdoutPath = path.join(probeRoot, "adapter.stdout.log");
  const stderrPath = path.join(probeRoot, "adapter.stderr.log");
  const stdout = await fs.open(stdoutPath, "w");
  const stderr = await fs.open(stderrPath, "w");

  adapter = spawn(
    process.execPath,
    [path.join(workspace, "scripts", "remodex_discord_gateway_adapter.mjs")],
    {
      cwd: workspace,
      env: {
        ...process.env,
        REMODEX_WORKSPACE: workspace,
        REMODEX_SHARED_BASE: sharedBase,
        REMODEX_WORKSPACE_KEY: "remodex",
        REMODEX_DISCORD_GATEWAY_URL: gatewayServer.gatewayUrl,
        REMODEX_DISCORD_GATEWAY_INTENTS: "33281",
        REMODEX_DISCORD_API_BASE_URL: restServer.apiBaseUrl,
        REMODEX_DISCORD_BOT_TOKEN: "fallback-probe-token",
        REMODEX_DISCORD_OUTBOX_POLL_INTERVAL_MS: "100",
        REMODEX_OPERATOR_HTTP_HOST: "127.0.0.1",
        REMODEX_OPERATOR_HTTP_PORT: "8787",
        CODEX_APP_SERVER_WS_URL: "",
      },
      stdio: ["ignore", stdout.fd, stderr.fd],
    },
  );

  const adapterState = await waitFor(
    async () => {
      const state = await fs
        .readFile(path.join(routerRoot, "discord_gateway_adapter_state.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => null);
      return state?.snapshot?.ready_seen ? state : null;
    },
    { timeoutMs: 10000, intervalMs: 100 },
  );

  const eventsLog = await fs
    .readFile(path.join(routerRoot, "discord_gateway_events.jsonl"), "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);

  summary.adapter_state = adapterState;
  summary.gateway_events = gatewayServer.events;
  summary.events_log = eventsLog;
  summary.finishedAt = new Date().toISOString();

  const identifyEvents = gatewayServer.events.filter((event) => event.type === "identify_received");
  const fallbackEvent = eventsLog.find((event) => event.type === "gateway_intents_fallback");
  const passed =
    identifyEvents.length >= 2 &&
    identifyEvents[0]?.intents === 33281 &&
    identifyEvents[1]?.intents === 513 &&
    adapterState?.conversation_mode === "mention_only" &&
    adapterState?.conversation_blocker === "message_content_intent_disabled_or_unconfigured" &&
    adapterState?.active_intents === 513 &&
    adapterState?.snapshot?.ready_seen === true &&
    adapterState?.bot_user_id === "bot-fallback" &&
    adapterState?.app_server_log_path &&
    fallbackEvent?.active_intents === 513;

  summary.status = passed ? "PASS" : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  if (adapter && adapter.exitCode === null && adapter.signalCode === null) {
    adapter.kill("SIGTERM");
    await waitForChildExit(adapter);
  }
  await gatewayServer?.close().catch(() => {});
  await restServer?.close().catch(() => {});
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord gateway message content fallback probe failed");
}
