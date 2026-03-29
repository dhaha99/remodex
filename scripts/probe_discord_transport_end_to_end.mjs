import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const probeRoot = path.join(verificationDir, "discord_transport_end_to_end_probe");
const sharedRoot = path.join(probeRoot, "external-shared-memory", "remodex", "projects");
const routerRoot = path.join(probeRoot, "router");
const quarantineDir = path.join(routerRoot, "quarantine");
const ingressLogPath = path.join(routerRoot, "ingress_log.jsonl");
const summaryPath = path.join(verificationDir, "discord_transport_end_to_end_probe_summary.json");

await fs.mkdir(verificationDir, { recursive: true });

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function isoSafe(ts) {
  return ts.replaceAll(":", "-");
}

function correlationKey(payload) {
  return `${payload.guild_id}:${payload.channel_id}:${payload.id}`;
}

function signInteraction(privateKey, timestamp, body) {
  return crypto.sign(null, Buffer.from(`${timestamp}${body}`, "utf8"), privateKey).toString("hex");
}

class ReplayCache {
  constructor() {
    this.seen = new Set();
  }

  claim(key) {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}

function verifyDiscordStyleRequest({
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

function normalizeIntentPayload(payload) {
  const options = payload.data?.options ?? [];
  const projectOption = options.find((option) => option.name === "project")?.value ?? null;
  const requestOption = options.find((option) => option.name === "request")?.value ?? null;
  const artifactOption = options.find((option) => option.name === "artifact")?.value ?? null;

  return {
    source: "discord",
    operator_id: payload.member?.user?.id ?? null,
    operator_roles: payload.member?.roles ?? [],
    command_name: payload.data?.name ?? null,
    workspace_key: "remodex",
    project_key: projectOption,
    request: requestOption,
    artifact: artifactOption,
    source_ref: payload.id,
    correlation_key: correlationKey(payload),
    received_at: payload.timestamp,
  };
}

function evaluateAcl(intent) {
  const roles = new Set(intent.operator_roles);
  if (!intent.project_key) {
    return { decision: "quarantine", reason: "missing_project" };
  }
  if (!["project-alpha", "project-beta"].includes(intent.project_key)) {
    return { decision: "quarantine", reason: "unknown_project" };
  }
  if (intent.command_name === "approve" && !roles.has("ops-admin")) {
    return { decision: "quarantine", reason: "unauthorized_approval" };
  }
  return { decision: "route", reason: null };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function readDirSafe(dirPath) {
  try {
    return (await fs.readdir(dirPath)).sort();
  } catch {
    return [];
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function alphaInboxDir() {
  return path.join(sharedRoot, "project-alpha", "inbox");
}

function betaInboxDir() {
  return path.join(sharedRoot, "project-beta", "inbox");
}

async function routePayload(payload) {
  const intent = normalizeIntentPayload(payload);
  const acl = evaluateAcl(intent);
  const filename = `${isoSafe(payload.timestamp)}_${intent.command_name}_${intent.source_ref}.json`;

  if (acl.decision === "route") {
    const targetDir = intent.project_key === "project-alpha" ? alphaInboxDir() : betaInboxDir();
    const record = {
      ...intent,
      type: intent.command_name === "approve" ? "approval_intent" : "operator_intent",
      command_class: intent.command_name,
      route_decision: "route",
    };
    const filePath = path.join(targetDir, filename);
    await writeJson(filePath, record);
    return { route: "inbox", filePath, record };
  }

  const record = {
    ...intent,
    route_decision: "quarantine",
    quarantine_reason: acl.reason,
  };
  const filePath = path.join(quarantineDir, filename);
  await writeJson(filePath, record);
  return { route: "quarantine", filePath, record };
}

function makePayload({
  id,
  channelId,
  timestamp,
  userId,
  roles,
  commandName,
  options,
}) {
  return {
    id,
    type: 2,
    guild_id: "guild-1",
    channel_id: channelId,
    timestamp,
    member: {
      user: { id: userId },
      roles,
    },
    data: {
      name: commandName,
      options,
    },
  };
}

async function httpPost(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
  return {
    status: response.status,
    json: await response.json(),
  };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const summary = {
  startedAt: new Date().toISOString(),
  requests: [],
  files: {},
};

let server;

try {
  await fs.rm(probeRoot, { recursive: true, force: true });
  await fs.mkdir(routerRoot, { recursive: true });
  await fs.writeFile(ingressLogPath, "");

  server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/discord/interactions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "not_found" }));
      return;
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const timestamp = req.headers["x-signature-timestamp"];
    const signatureHex = req.headers["x-signature-ed25519"];

    let payload = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "invalid_json" }));
      return;
    }

    const verification = verifyDiscordStyleRequest({
      publicKey,
      signatureHex: Array.isArray(signatureHex) ? signatureHex[0] : signatureHex,
      timestamp: Array.isArray(timestamp) ? timestamp[0] : timestamp,
      rawBody,
      interactionId: payload.id,
      replayCache,
    });

    if (!verification.ok) {
      await appendJsonl(ingressLogPath, {
        at: new Date().toISOString(),
        interaction_id: payload.id,
        verification,
      });
      res.writeHead(verification.httpStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: verification.reason }));
      return;
    }

    const routed = await routePayload(payload);
    await appendJsonl(ingressLogPath, {
      at: new Date().toISOString(),
      interaction_id: payload.id,
      verification,
      route: routed.route,
      filePath: routed.filePath,
    });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, route: routed.route, filePath: routed.filePath }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address missing");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/discord/interactions`;
  summary.baseUrl = baseUrl;

  const validIntentPayload = makePayload({
    id: "discord-http-001",
    channelId: "alpha-ops",
    timestamp: "2026-03-26T10:30:00+09:00",
    userId: "ops-user-1",
    roles: ["ops-admin", "operator"],
    commandName: "intent",
    options: [
      { name: "project", value: "project-alpha" },
      { name: "request", value: "backend bug first" },
    ],
  });
  const unauthorizedApprovalPayload = makePayload({
    id: "discord-http-002",
    channelId: "shared-ops",
    timestamp: "2026-03-26T10:31:00+09:00",
    userId: "viewer-user-2",
    roles: ["viewer"],
    commandName: "approve",
    options: [
      { name: "project", value: "project-alpha" },
      { name: "artifact", value: "artifact-204" },
    ],
  });
  const missingProjectPayload = makePayload({
    id: "discord-http-003",
    channelId: "shared-ops",
    timestamp: "2026-03-26T10:32:00+09:00",
    userId: "ops-user-3",
    roles: ["ops-admin", "operator"],
    commandName: "intent",
    options: [{ name: "request", value: "frontend spacing check" }],
  });

  const validBody = JSON.stringify(validIntentPayload);
  const validTimestamp = String(nowEpochSeconds());
  const validSignature = signInteraction(privateKey, validTimestamp, validBody);
  summary.requests.push({
    case: "valid_intent",
    response: await httpPost(baseUrl, validBody, {
      "x-signature-timestamp": validTimestamp,
      "x-signature-ed25519": validSignature,
    }),
  });

  summary.requests.push({
    case: "replay_same_request",
    response: await httpPost(baseUrl, validBody, {
      "x-signature-timestamp": validTimestamp,
      "x-signature-ed25519": validSignature,
    }),
  });

  const unauthorizedBody = JSON.stringify(unauthorizedApprovalPayload);
  const unauthorizedTimestamp = String(nowEpochSeconds());
  const unauthorizedSignature = signInteraction(privateKey, unauthorizedTimestamp, unauthorizedBody);
  summary.requests.push({
    case: "unauthorized_approval",
    response: await httpPost(baseUrl, unauthorizedBody, {
      "x-signature-timestamp": unauthorizedTimestamp,
      "x-signature-ed25519": unauthorizedSignature,
    }),
  });

  const missingProjectBody = JSON.stringify(missingProjectPayload);
  const missingProjectTimestamp = String(nowEpochSeconds());
  const missingProjectSignature = signInteraction(privateKey, missingProjectTimestamp, missingProjectBody);
  summary.requests.push({
    case: "missing_project",
    response: await httpPost(baseUrl, missingProjectBody, {
      "x-signature-timestamp": missingProjectTimestamp,
      "x-signature-ed25519": missingProjectSignature,
    }),
  });

  const tamperedTimestamp = String(nowEpochSeconds());
  const tamperedSignature = signInteraction(privateKey, tamperedTimestamp, validBody);
  const tamperedBody = validBody.replace("backend bug first", "tampered");
  summary.requests.push({
    case: "tampered_signature",
    response: await httpPost(baseUrl, tamperedBody, {
      "x-signature-timestamp": tamperedTimestamp,
      "x-signature-ed25519": tamperedSignature,
    }),
  });

  const alphaInboxFiles = await readDirSafe(alphaInboxDir());
  const betaInboxFiles = await readDirSafe(betaInboxDir());
  const quarantineFiles = await readDirSafe(quarantineDir);

  summary.files = {
    alphaInboxFiles,
    betaInboxFiles,
    quarantineFiles,
    alphaInboxRecord:
      alphaInboxFiles.length > 0 ? await readJson(path.join(alphaInboxDir(), alphaInboxFiles[0])) : null,
    quarantineRecords: await Promise.all(quarantineFiles.map((name) => readJson(path.join(quarantineDir, name)))),
  };

  const validIntent = summary.requests.find((entry) => entry.case === "valid_intent")?.response;
  const replayIntent = summary.requests.find((entry) => entry.case === "replay_same_request")?.response;
  const unauthorizedApproval = summary.requests.find((entry) => entry.case === "unauthorized_approval")?.response;
  const missingProject = summary.requests.find((entry) => entry.case === "missing_project")?.response;
  const tampered = summary.requests.find((entry) => entry.case === "tampered_signature")?.response;

  summary.finishedAt = new Date().toISOString();
  summary.status =
    validIntent?.status === 202 &&
    replayIntent?.status === 409 &&
    unauthorizedApproval?.status === 202 &&
    missingProject?.status === 202 &&
    tampered?.status === 401 &&
    alphaInboxFiles.length === 1 &&
    betaInboxFiles.length === 0 &&
    quarantineFiles.length === 2 &&
    summary.files.alphaInboxRecord?.project_key === "project-alpha" &&
    summary.files.alphaInboxRecord?.route_decision === "route" &&
    summary.files.quarantineRecords.some((record) => record.quarantine_reason === "unauthorized_approval") &&
    summary.files.quarantineRecords.some((record) => record.quarantine_reason === "missing_project")
      ? "PASS"
      : "FAIL";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = String(error);
} finally {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "discord transport end-to-end probe failed");
}
