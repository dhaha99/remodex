const GatewayOpcode = Object.freeze({
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
});

function defaultWsFactory(url) {
  return new WebSocket(url);
}

function defaultProperties() {
  return {
    os: process.platform,
    browser: "remodex_gateway_adapter",
    device: "remodex_gateway_adapter",
  };
}

function attachSocketListener(socket, type, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(type, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(type, handler);
    return;
  }
  socket[`on${type}`] = handler;
}

function normalizeCloseEvent(event) {
  return {
    code: event?.code ?? null,
    reason: event?.reason ?? null,
  };
}

function normalizeMessageData(event) {
  if (typeof event === "string") return event;
  if (event?.data) return String(event.data);
  return String(event ?? "");
}

async function maybeAwait(callback, ...args) {
  if (typeof callback !== "function") return null;
  return await callback(...args);
}

export class DiscordGatewaySession {
  constructor({
    gatewayUrl,
    token,
    intents = 0,
    properties = defaultProperties(),
    wsFactory = defaultWsFactory,
    heartbeatJitterMs = 0,
    reconnectDelayMs = 250,
    onDispatch = null,
    onInteractionCreate = null,
    onReady = null,
    onResumed = null,
    onStateChange = null,
    log = () => {},
  }) {
    if (!gatewayUrl) throw new Error("gatewayUrl is required");
    if (!token) throw new Error("token is required");
    this.gatewayUrl = gatewayUrl;
    this.token = token;
    this.intents = intents;
    this.properties = properties;
    this.wsFactory = wsFactory;
    this.heartbeatJitterMs = heartbeatJitterMs;
    this.reconnectDelayMs = reconnectDelayMs;
    this.onDispatch = onDispatch;
    this.onInteractionCreate = onInteractionCreate;
    this.onReady = onReady;
    this.onResumed = onResumed;
    this.onStateChange = onStateChange;
    this.log = log;

    this.socket = null;
    this.socketGeneration = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.helloReceived = false;
    this.awaitingHeartbeatAck = false;
    this.heartbeatIntervalMs = null;
    this.lastHeartbeatSentAt = null;
    this.lastHeartbeatAckAt = null;
    this.lastClose = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.isStopped = true;
    this.isStarted = false;
    this.resumeRequested = false;
    this.readySeen = false;
  }

  snapshot() {
    return {
      gateway_url: this.gatewayUrl,
      active_gateway_url: this.activeGatewayUrl ?? null,
      heartbeat_interval_ms: this.heartbeatIntervalMs,
      awaiting_heartbeat_ack: this.awaitingHeartbeatAck,
      last_heartbeat_sent_at: this.lastHeartbeatSentAt,
      last_heartbeat_ack_at: this.lastHeartbeatAckAt,
      session_id: this.sessionId,
      resume_gateway_url: this.resumeGatewayUrl,
      seq: this.seq,
      hello_received: this.helloReceived,
      ready_seen: this.readySeen,
      resume_requested: this.resumeRequested,
      is_started: this.isStarted,
      is_stopped: this.isStopped,
      last_close: this.lastClose,
      socket_generation: this.socketGeneration,
    };
  }

  async start() {
    if (this.isStarted && !this.isStopped) return this.snapshot();
    this.isStopped = false;
    this.isStarted = true;
    await this.connect(this.gatewayUrl, { resume: false, reason: "start" });
    return this.snapshot();
  }

  async stop({ code = 1000, reason = "shutdown" } = {}) {
    this.isStopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeatLoop();
    if (this.socket) {
      try {
        this.socket.close(code, reason);
      } catch {
        // no-op
      }
    }
    this.socket = null;
    await maybeAwait(this.onStateChange, { type: "stopped", snapshot: this.snapshot() });
    return this.snapshot();
  }

  async connect(url, { resume = false, reason = "manual" } = {}) {
    this.activeGatewayUrl = url;
    this.resumeRequested = resume;
    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.clearHeartbeatLoop();

    const socket = await this.wsFactory(url);
    this.socket = socket;
    this.log("gateway_connect", { url, resume, reason, generation });

    attachSocketListener(socket, "open", async () => {
      if (generation !== this.socketGeneration || this.isStopped) return;
      await maybeAwait(this.onStateChange, {
        type: "socket_open",
        generation,
        url,
        snapshot: this.snapshot(),
      });
    });

    attachSocketListener(socket, "message", async (event) => {
      if (generation !== this.socketGeneration || this.isStopped) return;
      await this.handlePayload(normalizeMessageData(event));
    });

    attachSocketListener(socket, "error", async (event) => {
      if (generation !== this.socketGeneration || this.isStopped) return;
      this.log("gateway_error", { generation, message: event?.message ?? String(event ?? "unknown_error") });
      await maybeAwait(this.onStateChange, {
        type: "socket_error",
        generation,
        error: event?.message ?? String(event ?? "unknown_error"),
        snapshot: this.snapshot(),
      });
    });

    attachSocketListener(socket, "close", async (event) => {
      if (generation !== this.socketGeneration) return;
      this.lastClose = normalizeCloseEvent(event);
      this.log("gateway_close", { generation, ...this.lastClose });
      await maybeAwait(this.onStateChange, {
        type: "socket_close",
        generation,
        close: this.lastClose,
        snapshot: this.snapshot(),
      });
      this.clearHeartbeatLoop();
      if (!this.isStopped) {
        this.scheduleReconnect({
          resume: Boolean(this.sessionId),
          reason: "socket_close",
        });
      }
    });
  }

  async handlePayload(rawText) {
    const payload = JSON.parse(rawText);
    if (Number.isInteger(payload.s)) {
      this.seq = payload.s;
    }
    switch (payload.op) {
      case GatewayOpcode.HELLO:
        await this.handleHello(payload);
        return;
      case GatewayOpcode.HEARTBEAT_ACK:
        this.awaitingHeartbeatAck = false;
        this.lastHeartbeatAckAt = new Date().toISOString();
        await maybeAwait(this.onStateChange, {
          type: "heartbeat_ack",
          snapshot: this.snapshot(),
        });
        return;
      case GatewayOpcode.DISPATCH:
        await this.handleDispatch(payload);
        return;
      case GatewayOpcode.RECONNECT:
        this.scheduleReconnect({ resume: true, reason: "server_reconnect" });
        return;
      case GatewayOpcode.INVALID_SESSION:
        if (!payload.d) {
          this.sessionId = null;
          this.resumeGatewayUrl = null;
          this.seq = null;
        }
        this.scheduleReconnect({
          resume: Boolean(payload.d && this.sessionId),
          reason: "invalid_session",
        });
        return;
      default:
        await maybeAwait(this.onStateChange, {
          type: "gateway_payload",
          opcode: payload.op,
          event_type: payload.t ?? null,
          snapshot: this.snapshot(),
        });
    }
  }

  async handleHello(payload) {
    this.helloReceived = true;
    this.heartbeatIntervalMs = payload.d?.heartbeat_interval ?? null;
    this.startHeartbeatLoop();
    if (this.resumeRequested && this.sessionId) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
    await maybeAwait(this.onStateChange, {
      type: "hello",
      heartbeat_interval_ms: this.heartbeatIntervalMs,
      snapshot: this.snapshot(),
    });
  }

  startHeartbeatLoop() {
    this.clearHeartbeatLoop();
    if (!this.heartbeatIntervalMs) return;
    const firstDelay = this.heartbeatIntervalMs + this.heartbeatJitterMs;
    this.heartbeatTimer = setTimeout(() => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat();
      }, this.heartbeatIntervalMs);
    }, firstDelay);
  }

  clearHeartbeatLoop() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingHeartbeatAck = false;
  }

  send(payload) {
    if (!this.socket) throw new Error("gateway socket is not connected");
    this.socket.send(JSON.stringify(payload));
    return payload;
  }

  sendHeartbeat() {
    this.awaitingHeartbeatAck = true;
    this.lastHeartbeatSentAt = new Date().toISOString();
    const payload = {
      op: GatewayOpcode.HEARTBEAT,
      d: this.seq,
    };
    this.send(payload);
    return payload;
  }

  sendIdentify() {
    const payload = {
      op: GatewayOpcode.IDENTIFY,
      d: {
        token: this.token,
        intents: this.intents,
        properties: this.properties,
      },
    };
    this.send(payload);
    return payload;
  }

  sendResume() {
    const payload = {
      op: GatewayOpcode.RESUME,
      d: {
        token: this.token,
        session_id: this.sessionId,
        seq: this.seq,
      },
    };
    this.send(payload);
    return payload;
  }

  scheduleReconnect({ resume = true, reason = "reconnect" } = {}) {
    if (this.isStopped) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      const nextUrl = resume && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.gatewayUrl;
      void this.connect(nextUrl, { resume, reason });
    }, this.reconnectDelayMs);
  }

  async handleDispatch(payload) {
    if (payload.t === "READY") {
      this.sessionId = payload.d?.session_id ?? this.sessionId;
      this.resumeGatewayUrl = payload.d?.resume_gateway_url ?? this.resumeGatewayUrl;
      this.readySeen = true;
      await maybeAwait(this.onReady, payload.d, payload);
    } else if (payload.t === "RESUMED") {
      await maybeAwait(this.onResumed, payload.d ?? null, payload);
    } else if (payload.t === "INTERACTION_CREATE") {
      await maybeAwait(this.onInteractionCreate, payload.d, payload);
    }

    await maybeAwait(this.onDispatch, payload.t, payload.d, payload);
    await maybeAwait(this.onStateChange, {
      type: "dispatch",
      event_type: payload.t,
      seq: payload.s ?? null,
      snapshot: this.snapshot(),
    });
  }
}

export { GatewayOpcode };
