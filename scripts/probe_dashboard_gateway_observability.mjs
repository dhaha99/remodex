import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readPortfolioOverview,
  readProjectDetail,
  readProjectTimeline,
} from "./lib/dashboard_read_model.mjs";
import {
  buildProjectPaths,
  ensureProjectDirs,
  writeAtomicJson,
  writeAtomicText,
} from "./lib/shared_memory_runtime.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "remodex-dashboard-gateway-"));
  const sharedBase = path.join(probeRoot, "external-shared-memory");
  const workspaceKey = "remodex";
  const projectKey = "project-alpha";
  const paths = buildProjectPaths({ sharedBase, workspaceKey, projectKey });
  await ensureProjectDirs(paths);

  await writeAtomicJson(path.join(paths.stateDir, "project_identity.json"), {
    workspace_key: workspaceKey,
    project_key: projectKey,
  });
  await writeAtomicJson(path.join(paths.stateDir, "coordinator_status.json"), {
    type: "idle",
    observed_at: "2026-03-28T15:00:00+09:00",
  });
  await writeAtomicText(
    path.join(paths.stateDir, "roadmap_status.md"),
    "phase: gateway\ncurrent_point: observability\n",
  );

  const routerRoot = path.join(sharedBase, workspaceKey, "router");
  await fs.mkdir(routerRoot, { recursive: true });
  await writeAtomicJson(path.join(routerRoot, "discord_gateway_adapter_state.json"), {
    observed_at: "2026-03-28T15:00:05+09:00",
    last_event_type: "interaction_create",
    seq: 19,
    snapshot: {
      ready_seen: true,
      session_id: "gateway-session-1",
      seq: 19,
      is_stopped: false,
    },
  });
  await fs.writeFile(
    path.join(routerRoot, "discord_gateway_events.jsonl"),
    [
      JSON.stringify({
        observed_at: "2026-03-28T15:00:06+09:00",
        type: "interaction_create",
        interaction_id: "interaction-status-1",
        command_class: "status",
        project_key: projectKey,
        delivery_decision: "not_applicable",
      }),
      JSON.stringify({
        observed_at: "2026-03-28T15:00:07+09:00",
        type: "interaction_create",
        interaction_id: "interaction-intent-1",
        command_class: "intent",
        project_key: projectKey,
        delivery_decision: "deferred",
      }),
    ].join("\n") + "\n",
  );

  const portfolio = await readPortfolioOverview({ sharedBase, workspaceKey });
  const detail = await readProjectDetail({ sharedBase, workspaceKey, projectKey });
  const timeline = await readProjectTimeline({ sharedBase, workspaceKey, projectKey });

  assert(portfolio.gateway_adapter?.ready_seen === true, "portfolio should expose gateway ready_seen");
  assert(
    portfolio.gateway_adapter?.last_event_type === "interaction_create",
    "portfolio should expose gateway last_event_type",
  );
  assert(
    detail.gateway_adapter?.last_project_interaction?.command_class === "status",
    "detail should expose latest project interaction",
  );
  assert(
    timeline.entries.some((entry) => entry.kind === "gateway_adapter_state"),
    "timeline should include gateway_adapter_state",
  );
  assert(
    timeline.entries.some(
      (entry) =>
        entry.kind === "gateway_interaction" && entry.summary?.includes("intent deferred"),
    ),
    "timeline should include project gateway interaction",
  );

  const summary = {
    verdict: "PASS",
    workspace_key: workspaceKey,
    probe_root: probeRoot,
    portfolio_gateway: portfolio.gateway_adapter,
    detail_gateway: detail.gateway_adapter,
    timeline_kinds: timeline.entries.map((entry) => entry.kind).slice(0, 6),
  };

  const summaryPath = path.join(
    process.cwd(),
    "verification",
    "dashboard_gateway_observability_probe_summary.json",
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
