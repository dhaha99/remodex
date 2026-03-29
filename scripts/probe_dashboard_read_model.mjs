import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readHumanGateView,
  readIncidentView,
  readPortfolioOverview,
  readProjectDetail,
  readProjectTimeline,
} from "./lib/dashboard_read_model.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  markProcessed,
  writeAtomicJson,
  writeDispatchTicket,
  writeHumanGateCandidate,
  writeInboxEvent,
  writeOutboxRecord,
} from "./lib/shared_memory_runtime.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-dashboard-probe-"));
  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const workspaceKey = "remodex";

  const alphaPaths = buildProjectPaths({ sharedBase, workspaceKey, projectKey: "project-alpha" });
  const betaPaths = buildProjectPaths({ sharedBase, workspaceKey, projectKey: "project-beta" });
  await ensureProjectDirs(alphaPaths);
  await ensureProjectDirs(betaPaths);

  await writeAtomicJson(path.join(alphaPaths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
  });
  await writeAtomicJson(path.join(betaPaths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: "project-beta",
  });

  await writeAtomicJson(path.join(alphaPaths.stateDir, "coordinator_binding.json"), {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
    threadId: "thread-alpha",
  });
  await writeAtomicJson(path.join(betaPaths.stateDir, "coordinator_binding.json"), {
    workspace_key: workspaceKey,
    project_key: "project-beta",
    threadId: "thread-beta",
  });

  await writeAtomicJson(path.join(alphaPaths.stateDir, "coordinator_status.json"), {
    type: "waiting_on_approval",
    observed_at: "2026-03-27T10:30:00+09:00",
    active_approval_source_ref: "discord-approve-001",
  });
  await writeAtomicJson(path.join(betaPaths.stateDir, "coordinator_status.json"), {
    type: "idle",
    observed_at: "2026-03-27T10:32:00+09:00",
  });

  await writeAtomicJson(path.join(alphaPaths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: true,
    foreground_session_active: false,
  });
  await writeAtomicJson(path.join(betaPaths.stateDir, "background_trigger_toggle.json"), {
    background_trigger_enabled: false,
    foreground_session_active: true,
  });

  await writeAtomicJson(path.join(alphaPaths.stateDir, "stop_conditions.json"), {
    must_human_check: true,
    pending_human_gate: true,
  });
  await writeAtomicJson(path.join(betaPaths.stateDir, "stop_conditions.json"), {
    must_human_check: false,
    pending_human_gate: false,
  });

  await writeAtomicJson(path.join(alphaPaths.runtimeDir, "scheduler_runtime.json"), {
    project_key: "project-alpha",
    decision: "blocked",
    reasons: ["pending_human_gate"],
    recorded_at: "2026-03-27T10:31:00+09:00",
  });
  await writeAtomicJson(path.join(betaPaths.runtimeDir, "scheduler_runtime.json"), {
    project_key: "project-beta",
    decision: "noop",
    reasons: ["no_pending_work"],
    recorded_at: "2026-03-27T10:33:00+09:00",
  });

  await writeAtomicJson(path.join(alphaPaths.runtimeDir, "inflight_delivery.json"), {
    source_ref: "discord-intent-001",
    correlation_key: "alpha-correlation-001",
    started_at: "2026-03-27T09:00:00+09:00",
  });

  const alphaReply = {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
    command_class: "reply",
    source_ref: "discord-reply-001",
    correlation_key: "alpha-reply-001",
    received_at: "2026-03-27T10:31:05+09:00",
    operator_answer: "승인 전에 상태 확인",
  };
  await writeInboxEvent(alphaPaths, alphaReply);
  await writeDispatchTicket(alphaPaths, {
    ...alphaReply,
    route_decision: "dispatch_queue",
  });
  await writeHumanGateCandidate(alphaPaths, {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
    source_ref: "discord-approve-001",
    correlation_key: "discord-approve-001",
    method: "item/fileChange/requestApproval",
    thread_id: "thread-alpha",
    received_at: "2026-03-27T10:30:30+09:00",
  });

  const betaIntent = {
    workspace_key: workspaceKey,
    project_key: "project-beta",
    command_class: "intent",
    source_ref: "discord-intent-002",
    correlation_key: "beta-correlation-001",
    received_at: "2026-03-27T10:32:30+09:00",
    request: "beta continue",
  };
  const betaInbox = await writeInboxEvent(betaPaths, betaIntent);
  await markProcessed(betaPaths, {
    record: betaIntent,
    sourcePath: betaInbox.filePath,
    disposition: "consumed",
    origin: "foreground_same_thread",
    processedBy: "probe_dashboard",
    extra: {
      processed_at: "2026-03-27T10:33:30+09:00",
    },
  });

  await writeOutboxRecord(alphaPaths, {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
    type: "human_gate_notification",
    source_ref: "discord-approve-001",
    correlation_key: "human-gate:project-alpha:discord-approve-001",
    emitted_at: "2026-03-27T10:30:45+09:00",
    summary: { coordinator_status: "waiting_on_approval" },
  });
  await writeOutboxRecord(betaPaths, {
    workspace_key: workspaceKey,
    project_key: "project-beta",
    type: "status_response",
    source_ref: "discord-status-002",
    correlation_key: "status:project-beta:discord-status-002",
    emitted_at: "2026-03-27T10:33:45+09:00",
    summary: { coordinator_status: "idle" },
  });

  const routerRoot = path.join(sharedBase, workspaceKey, "router");
  await fs.mkdir(routerRoot, { recursive: true });
  await writeAtomicJson(path.join(routerRoot, "pending_approvals.json"), {
    approvals: [
      {
        id: "approval-1",
        method: "item/fileChange/requestApproval",
        source_ref: "discord-approve-001",
        thread_id: "thread-alpha",
        project_key: "project-alpha",
        turn_id: "turn-alpha-1",
        observed_at: "2026-03-27T10:30:35+09:00",
        responded: false,
      },
    ],
  });
  await writeAtomicJson(path.join(routerRoot, "quarantine", "2026-03-27T10-34-00+09-00_quarantine_alpha.json"), {
    workspace_key: workspaceKey,
    project_key: "project-alpha",
    source_ref: "bad-input-001",
    correlation_key: "bad-input-001",
    received_at: "2026-03-27T10:34:00+09:00",
  });

  const portfolio = await readPortfolioOverview({ sharedBase, workspaceKey });
  const detailAlpha = await readProjectDetail({ sharedBase, workspaceKey, projectKey: "project-alpha" });
  const timelineAlpha = await readProjectTimeline({ sharedBase, workspaceKey, projectKey: "project-alpha" });
  const humanGates = await readHumanGateView({ sharedBase, workspaceKey });
  const incidents = await readIncidentView({ sharedBase, workspaceKey });

  const alphaCard = portfolio.projects.find((project) => project.project_key === "project-alpha");
  const betaCard = portfolio.projects.find((project) => project.project_key === "project-beta");

  assert(portfolio.project_count === 2, "portfolio should report 2 projects");
  assert(alphaCard?.scheduler_decision === "blocked", "alpha should be blocked");
  assert(alphaCard?.pending_approvals_count === 1, "alpha should have one pending approval");
  assert(alphaCard?.human_gate_count === 1, "alpha should have one human gate candidate");
  assert(alphaCard?.incidents.includes("must_human_check"), "alpha should include must_human_check");
  assert(alphaCard?.incidents.includes("pending_human_gate"), "alpha should include pending_human_gate");
  assert(alphaCard?.incidents.includes("stale_inflight_delivery"), "alpha should include stale inflight");
  assert(betaCard?.last_processed?.correlation_key === "beta-correlation-001", "beta last processed correlation mismatch");
  assert(detailAlpha.approvals.pending_approvals.length === 1, "detail alpha should include pending approval");
  assert(detailAlpha.approvals.human_gate_candidates.length === 1, "detail alpha should include candidate");
  assert(
    timelineAlpha.entries.some((entry) => entry.kind === "scheduler_decision"),
    "timeline should include scheduler decision",
  );
  assert(
    timelineAlpha.entries.some((entry) => entry.kind === "human_gate_candidate"),
    "timeline should include human gate candidate",
  );
  assert(
    timelineAlpha.entries.some((entry) => entry.kind === "outbox:human_gate_notification"),
    "timeline should include outbox notification",
  );
  assert(humanGates.entries.length >= 1, "human gate view should not be empty");
  assert(
    incidents.entries.some((entry) => entry.project_key === "project-alpha" && entry.reason === "pending_human_gate"),
    "incident view should include alpha pending_human_gate",
  );

  const summary = {
    verdict: "PASS",
    workspace_key: workspaceKey,
    probe_root: probeRoot,
    project_count: portfolio.project_count,
    alpha_incidents: alphaCard.incidents,
    beta_last_processed: betaCard.last_processed,
    timeline_kinds: timelineAlpha.entries.map((entry) => entry.kind).slice(0, 6),
    human_gate_count: humanGates.entries.length,
    incident_count: incidents.entries.length,
  };

  const summaryPath = path.join(process.cwd(), "verification", "dashboard_read_model_probe_summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
