import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "discord_signature_replay_probe_summary.json");

await fs.mkdir(verificationDir, { recursive: true });

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function signInteraction(privateKey, timestamp, body) {
  const payload = Buffer.from(`${timestamp}${body}`, "utf8");
  return crypto.sign(null, payload, privateKey).toString("hex");
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
  nowSeconds = nowEpochSeconds(),
}) {
  if (!signatureHex || !timestamp || !rawBody || !interactionId) {
    return { ok: false, reason: "missing_required_fields" };
  }

  if (Math.abs(nowSeconds - Number(timestamp)) > maxAgeSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const replayKey = `${interactionId}:${timestamp}:${signatureHex}`;
  if (!replayCache.claim(replayKey)) {
    return { ok: false, reason: "replay_detected" };
  }

  const verified = crypto.verify(
    null,
    Buffer.from(`${timestamp}${rawBody}`, "utf8"),
    publicKey,
    Buffer.from(signatureHex, "hex"),
  );
  if (!verified) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, reason: "accepted" };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const replayCache = new ReplayCache();
const baseBody = JSON.stringify({
  id: "discord-interaction-001",
  type: 2,
  data: {
    name: "intent",
    options: [
      { name: "project", value: "project-alpha" },
      { name: "text", value: "backend bug first" },
    ],
  },
});
const timestamp = String(nowEpochSeconds());
const validSignature = signInteraction(privateKey, timestamp, baseBody);

const validCase = verifyDiscordStyleRequest({
  publicKey,
  signatureHex: validSignature,
  timestamp,
  rawBody: baseBody,
  interactionId: "discord-interaction-001",
  replayCache,
});

const tamperedCase = verifyDiscordStyleRequest({
  publicKey,
  signatureHex: validSignature,
  timestamp,
  rawBody: baseBody.replace("backend bug first", "tampered"),
  interactionId: "discord-interaction-002",
  replayCache,
});

const replayCase = verifyDiscordStyleRequest({
  publicKey,
  signatureHex: validSignature,
  timestamp,
  rawBody: baseBody,
  interactionId: "discord-interaction-001",
  replayCache,
});

const staleTimestamp = String(Number(timestamp) - 600);
const staleSignature = signInteraction(privateKey, staleTimestamp, baseBody);
const staleCase = verifyDiscordStyleRequest({
  publicKey,
  signatureHex: staleSignature,
  timestamp: staleTimestamp,
  rawBody: baseBody,
  interactionId: "discord-interaction-003",
  replayCache,
  nowSeconds: Number(timestamp),
});

const summary = {
  startedAt: new Date().toISOString(),
  validCase,
  tamperedCase,
  replayCase,
  staleCase,
  acceptedExactlyOnce:
    validCase.ok === true &&
    tamperedCase.ok === false &&
    replayCase.ok === false &&
    staleCase.ok === false,
  finishedAt: new Date().toISOString(),
  status:
    validCase.ok === true &&
    tamperedCase.reason === "invalid_signature" &&
    replayCase.reason === "replay_detected" &&
    staleCase.reason === "stale_timestamp"
      ? "PASS"
      : "FAIL",
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (summary.status !== "PASS") {
  throw new Error("discord signature/replay probe failed");
}
