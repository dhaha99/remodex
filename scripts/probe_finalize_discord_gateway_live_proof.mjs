import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finalizeDiscordGatewayLiveProof } from "../ops/finalize_discord_gateway_live_proof.mjs";
import { writeAtomicJson } from "./lib/shared_memory_runtime.mjs";

const workspace = process.cwd();
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "discord_gateway_live_proof_finalizer_probe_summary.json",
);

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function buildFixture(rootDir, { expectInteraction, includeInteraction }) {
  const proofDir = path.join(rootDir, "runtime", "live-discord-proof");
  const sharedBase = path.join(rootDir, "runtime", "external-shared-memory");
  const routerRoot = path.join(sharedBase, "remodex", "router");
  const startedAt = "2026-03-28T10:00:00.000Z";

  await ensureDir(path.join(routerRoot, "outbox"));
  await ensureDir(path.join(routerRoot, "quarantine"));

  await writeJson(path.join(proofDir, "live-proof-bundle.json"), {
    started_at: startedAt,
    completed_at: "2026-03-28T10:00:10.000Z",
    ok: includeInteraction || expectInteraction === false,
    register_commands_result: "completed",
    expect_interaction: expectInteraction,
    preflight: { ok: true },
    proof: {
      ready_seen: true,
      interaction_observed: includeInteraction,
      timed_out: !includeInteraction && expectInteraction,
    },
  });

  await writeAtomicJson(path.join(routerRoot, "discord_gateway_adapter_state.json"), {
    observed_at: "2026-03-28T10:00:09.000Z",
    last_event_type: includeInteraction ? "interaction_create" : "ready",
    event_type: includeInteraction ? "INTERACTION_CREATE" : "READY",
    seq: includeInteraction ? 3 : 2,
    snapshot: {
      ready_seen: true,
    },
  });

  const events = [
    JSON.stringify({
      observed_at: "2026-03-28T10:00:01.000Z",
      type: "ready",
    }),
  ];
  if (includeInteraction) {
    events.push(
      JSON.stringify({
        observed_at: "2026-03-28T10:00:05.000Z",
        type: "interaction_create",
        interaction_id: "123456789012345678",
        command_class: "status",
        project_key: "project-alpha",
      }),
    );
    await writeJson(path.join(routerRoot, "outbox", "2026-03-28T10:00:06.000Z_status.json"), {
      emitted_at: "2026-03-28T10:00:06.000Z",
      type: "status_response",
      source_ref: "discord:interaction:123456789012345678",
      correlation_key: "corr-live-pass",
      summary: "status ok",
    });
  }
  await fs.writeFile(path.join(routerRoot, "discord_gateway_events.jsonl"), `${events.join("\n")}\n`);

  return {
    proofDir,
    sharedBase,
  };
}

await ensureDir(verificationDir);

const passRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-live-proof-pass-"));
const failRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-live-proof-fail-"));

const passFixture = await buildFixture(passRoot, {
  expectInteraction: true,
  includeInteraction: true,
});
const failFixture = await buildFixture(failRoot, {
  expectInteraction: true,
  includeInteraction: false,
});

const passResult = await finalizeDiscordGatewayLiveProof({
  workspace: passRoot,
  proofDir: passFixture.proofDir,
  sharedBase: passFixture.sharedBase,
  workspaceKey: "remodex",
});
const failResult = await finalizeDiscordGatewayLiveProof({
  workspace: failRoot,
  proofDir: failFixture.proofDir,
  sharedBase: failFixture.sharedBase,
  workspaceKey: "remodex",
});

const summary = {
  ok:
    passResult.ok === true &&
    failResult.ok === false &&
    passResult.counters.interaction_events_since_start === 1 &&
    failResult.blockers.includes("live_proof_bundle_not_ok") &&
    failResult.blockers.includes("interaction_not_observed"),
  pass_case: {
    ok: passResult.ok,
    output_path: passResult.output_path,
    outbox_records_since_start: passResult.counters.outbox_records_since_start,
    interaction_events_since_start: passResult.counters.interaction_events_since_start,
  },
  fail_case: {
    ok: failResult.ok,
    output_path: failResult.output_path,
    blockers: failResult.blockers,
    warnings: failResult.warnings,
  },
};

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
