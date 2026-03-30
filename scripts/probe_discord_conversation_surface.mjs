import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildProjectPaths,
  ensureProjectDirs,
  readJsonIfExists,
  writeAtomicJson,
  writeAtomicText,
  writeOutboxRecord,
} from "./lib/shared_memory_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_conversation_surface_probe");
const summaryPath = path.join(verificationDir, "discord_conversation_surface_probe_summary.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function createMessagePayload({
  id,
  guildId,
  channelId,
  authorId,
  content,
  roles = [],
}) {
  return {
    id,
    guild_id: guildId,
    channel_id: channelId,
    timestamp: new Date().toISOString(),
    type: 0,
    content,
    author: {
      id: authorId,
      username: "operator",
      bot: false,
    },
    member: {
      user: {
        id: authorId,
      },
      roles,
    },
    mentions: [],
  };
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

async function seedProject(paths, { projectKey, displayName, goal, nextBatch, backgroundEnabled = false }) {
  await ensureProjectDirs(paths);
  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    display_name: displayName,
    aliases: [displayName.toLowerCase()],
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_binding.json"), {
    workspace_key: "remodex",
    project_key: projectKey,
    threadId: `thread-${projectKey}`,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
  });
  await writeAtomicJson(path.join(paths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: backgroundEnabled,
    foreground_session_active: false,
  });
  await writeAtomicJson(path.join(paths.stateDir, "operator_acl.json"), {
    status_allow: "operator",
    intent_allow: "operator",
    reply_allow: "operator",
    approval_allow: "ops-admin",
  });
  await writeAtomicText(path.join(paths.stateDir, "current_goal.md"), `current_goal: ${goal}\n`);
  await writeAtomicText(path.join(paths.stateDir, "progress_axes.md"), `next_smallest_batch: ${nextBatch}\n`);
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
    const body = bodyText ? JSON.parse(bodyText) : null;
    requests.push({
      method: req.method,
      url: req.url,
      body,
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

async function startFakeGatewayServer({ onReady }) {
  const events = [];
  const sockets = new Set();
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

    const sendPayload = (payload) => {
      if (socket.destroyed || !socket.writable) return;
      socket.write(encodeTextFrame(JSON.stringify(payload)));
    };

    sendPayload({
      op: 10,
      d: { heartbeat_interval: 200 },
    });
    events.push({ type: "hello_sent" });

    socket.on("data", async (chunk) => {
      rest = Buffer.concat([rest, chunk]);
      const parsed = decodeFrames(rest);
      rest = parsed.rest;
      for (const message of parsed.messages) {
        if (message === "__CLOSE__") {
          socket.end();
          continue;
        }
        const payload = JSON.parse(message);
        events.push({
          type: "client_payload",
          op: payload.op ?? null,
          t: payload.t ?? null,
        });

        if (payload.op === 1) {
          sendPayload({ op: 11 });
          continue;
        }

        if (payload.op === 2 && !identifySeen) {
          identifySeen = true;
          sendPayload({
            op: 0,
            t: "READY",
            s: 1,
            d: {
              session_id: "session-conversation-probe",
              user: { id: "bot-conversation", username: "Remodex Pilot" },
            },
          });
          events.push({ type: "ready_sent" });
          if (typeof onReady === "function") {
            void onReady(sendPayload, events);
          }
        }
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

  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const routerRoot = path.join(sharedBase, "remodex", "router");
  const conversationPaths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-conversation",
  });
  const secondaryPaths = buildProjectPaths({
    sharedBase,
    workspaceKey: "remodex",
    projectKey: "project-secondary",
  });

  await seedProject(conversationPaths, {
    projectKey: "project-conversation",
    displayName: "Conversation Demo",
    goal: "대화형 Discord surface 검증",
    nextBatch: "로그인 테스트부터 진행",
    backgroundEnabled: false,
  });
  await seedProject(secondaryPaths, {
    projectKey: "project-secondary",
    displayName: "Secondary",
    goal: "single-project default 방지",
    nextBatch: "none",
    backgroundEnabled: false,
  });

  await writeAtomicJson(path.join(routerRoot, "discord_channel_project_bindings.json"), {
    bindings: {
      "guild-conversation:channel-bound": {
        guild_id: "guild-conversation",
        channel_id: "channel-bound",
        project_key: "project-conversation",
        operator_id: "operator-1",
        updated_at: new Date().toISOString(),
      },
    },
  });

  restServer = await startFakeDiscordRest();

  gatewayServer = await startFakeGatewayServer({
    onReady: async (sendPayload, events) => {
      await sleep(150);
      sendPayload({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 2,
        d: createMessagePayload({
          id: "message-status-1",
          guildId: "guild-conversation",
          channelId: "channel-bound",
          authorId: "operator-1",
          content: "지금 어디까지 했어?",
          roles: [],
        }),
      });
      events.push({ type: "message_sent", id: "message-status-1" });

      await sleep(150);
      sendPayload({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 3,
        d: createMessagePayload({
          id: "message-intent-1",
          guildId: "guild-conversation",
          channelId: "channel-bound",
          authorId: "operator-1",
          content: "로그인 테스트부터 진행해",
          roles: [],
        }),
      });
      events.push({ type: "message_sent", id: "message-intent-1" });

      await sleep(150);
      sendPayload({
        op: 0,
        t: "MESSAGE_CREATE",
        s: 4,
        d: {
          ...createMessagePayload({
            id: "message-help-1",
            guildId: "guild-conversation",
            channelId: "channel-unbound",
            authorId: "operator-1",
            content: "<@bot-conversation> 지금 뭐부터 해야 해?",
            roles: [],
          }),
          mentions: [{ id: "bot-conversation" }],
        },
      });
      events.push({ type: "message_sent", id: "message-help-1" });

      await sleep(150);
      await writeOutboxRecord(
        conversationPaths,
        {
          workspace_key: "remodex",
          project_key: "project-conversation",
          type: "human_gate_notification",
          emitted_at: new Date().toISOString(),
          source_ref: "human-gate-1",
          summary: {
            coordinator_status: "waiting_on_approval",
            project_display_name: "Conversation Demo",
          },
          thread_id: "019dconvo0001",
        },
        null,
      );
      events.push({ type: "human_gate_record_written" });

      await sleep(150);
      await writeAtomicJson(
        path.join(
          conversationPaths.processedDir,
          "2026-03-29T18-00-00.000Z_consumed_conversation-1.json",
        ),
        {
          workspace_key: "remodex",
          project_key: "project-conversation",
          source_ref: "conversation-1",
          processed_at: new Date().toISOString(),
          disposition: "consumed",
          turn_id: "019dprocessed1",
          final_text: "로그인 테스트와 blocker 정리를 진행했고, 다음은 visual regression 확인입니다.",
        },
      );
      events.push({ type: "processed_record_written" });
    },
  });

  const adapterStdoutPath = path.join(probeRoot, "adapter.stdout.log");
  const adapterStderrPath = path.join(probeRoot, "adapter.stderr.log");
  const adapterStdout = await fs.open(adapterStdoutPath, "w");
  const adapterStderr = await fs.open(adapterStderrPath, "w");

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
        REMODEX_DISCORD_BOT_TOKEN: "probe-bot-token",
        REMODEX_DISCORD_OUTBOX_POLL_INTERVAL_MS: "100",
        REMODEX_OPERATOR_HTTP_HOST: "127.0.0.1",
        REMODEX_OPERATOR_HTTP_PORT: "8787",
        CODEX_APP_SERVER_WS_URL: "",
      },
      stdio: ["ignore", adapterStdout.fd, adapterStderr.fd],
    },
  );

  const replies = await waitFor(async () => {
    const channelPosts = restServer.requests.filter(
      (request) => request.method === "POST" && request.url?.includes("/channels/"),
    );
    return channelPosts.length >= 5 ? channelPosts : null;
  });

  const adapterState = await waitFor(
    async () => await readJsonIfExists(path.join(routerRoot, "discord_gateway_adapter_state.json")),
    { timeoutMs: 10000 },
  );

  const channelPosts = replies ?? [];
  const statusReply = channelPosts.find((request) =>
    String(request.body?.content ?? "").includes("Conversation Demo 현재 상태입니다."),
  );
  const intentReply = channelPosts.find((request) =>
    String(request.body?.content ?? "").includes("작업 요청을 기록했습니다."),
  );
  const helpReply = channelPosts.find((request) =>
    String(request.body?.content ?? "").includes("이 채널은 아직 프로젝트에 연결되지 않았습니다."),
  );
  const humanGateReply = channelPosts.find((request) =>
    String(request.body?.content ?? "").includes("승인 확인이 필요합니다."),
  );
  const processedReply = channelPosts.find((request) =>
    String(request.body?.content ?? "").includes("응답이 도착했습니다."),
  );

  const inboxFiles = await fs.readdir(conversationPaths.inboxDir);
  const dispatchFiles = await fs.readdir(conversationPaths.dispatchQueueDir);
  const inboxRecord = inboxFiles[0]
    ? await readJsonIfExists(path.join(conversationPaths.inboxDir, inboxFiles[0]))
    : null;
  const dispatchRecord = dispatchFiles[0]
    ? await readJsonIfExists(path.join(conversationPaths.dispatchQueueDir, dispatchFiles[0]))
    : null;
  const deliveryState = await readJsonIfExists(path.join(routerRoot, "discord_channel_delivery_state.json"));

  summary.adapter_state = adapterState;
  summary.gateway_events = gatewayServer.events;
  summary.channel_post_count = channelPosts.length;
  summary.status_reply = statusReply?.body ?? null;
  summary.intent_reply = intentReply?.body ?? null;
  summary.help_reply = helpReply?.body ?? null;
  summary.human_gate_reply = humanGateReply?.body ?? null;
  summary.processed_reply = processedReply?.body ?? null;
  summary.inbox_record = inboxRecord;
  summary.dispatch_record = dispatchRecord;
  summary.delivery_state = deliveryState;
  summary.finishedAt = new Date().toISOString();

  const passed =
    adapterState?.snapshot?.ready_seen === true &&
    statusReply &&
    intentReply &&
    helpReply &&
    humanGateReply &&
    processedReply &&
    inboxRecord?.request === "로그인 테스트부터 진행해" &&
    dispatchRecord?.project_key === "project-conversation";

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
