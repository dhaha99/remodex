import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readHumanGateView,
  readIncidentView,
  readPortfolioOverview,
  readProjectDetail,
  readProjectTimeline,
} from "./lib/dashboard_read_model.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = process.env.REMODEX_WORKSPACE ?? path.resolve(scriptDir, "..");
const sharedBase = process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory");
const workspaceKey = process.env.REMODEX_WORKSPACE_KEY ?? "remodex";
const host = process.env.REMODEX_DASHBOARD_HTTP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.REMODEX_DASHBOARD_HTTP_PORT ?? "8790", 10);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function errorPayload(error) {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function appHtml() {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Remodex Dashboard</title>
  <style>
    :root {
      --bg: #f4f1ea;
      --paper: #fffdf8;
      --ink: #1f2a37;
      --muted: #677489;
      --line: #d9d1c4;
      --accent: #0f766e;
      --warn: #c2410c;
      --danger: #b91c1c;
      --shadow: 0 18px 50px rgba(31, 42, 55, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "SF Mono", "IBM Plex Sans KR", ui-sans-serif, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.12), transparent 28%),
        linear-gradient(180deg, #f7f4ee 0%, var(--bg) 100%);
    }
    .shell {
      max-width: 1440px;
      margin: 0 auto;
      padding: 28px 20px 40px;
    }
    .hero {
      display: grid;
      gap: 8px;
      margin-bottom: 20px;
    }
    h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
    .sub { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 18px;
    }
    .panel {
      background: rgba(255,253,248,0.88);
      border: 1px solid rgba(217,209,196,0.9);
      border-radius: 18px;
      box-shadow: var(--shadow);
      overflow: hidden;
      backdrop-filter: blur(10px);
    }
    .panel h2 {
      margin: 0;
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .panel-head {
      padding: 16px 18px 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .panel-body { padding: 14px 16px 18px; }
    .stack { display: grid; gap: 18px; }
    .cards { display: grid; gap: 12px; }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,252,245,0.98));
      cursor: pointer;
    }
    .card.active {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(15,118,110,0.18);
    }
    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
      margin-bottom: 10px;
    }
    .project {
      font-size: 16px;
      font-weight: 700;
    }
    .status {
      font-size: 12px;
      color: var(--paper);
      background: var(--accent);
      padding: 4px 8px;
      border-radius: 999px;
    }
    .status.warn { background: var(--warn); }
    .status.danger { background: var(--danger); }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    .mini-grid strong { color: var(--ink); display: block; font-size: 12px; margin-bottom: 2px; }
    .pill-row, .list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      background: #faf6ee;
    }
    .pill.incident { border-color: rgba(185,28,28,0.35); color: var(--danger); }
    .json-block, .timeline {
      font-size: 12px;
      line-height: 1.55;
      white-space: pre-wrap;
      background: #f9f6f0;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      overflow: auto;
      max-height: 420px;
    }
    .timeline-item {
      padding: 10px 0;
      border-bottom: 1px dashed var(--line);
    }
    .timeline-item:last-child { border-bottom: 0; }
    .timeline-item strong { display: block; margin-bottom: 4px; }
    .meta {
      color: var(--muted);
      font-size: 12px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .summary-box {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: #fcfaf5;
    }
    .summary-box strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    @media (max-width: 980px) {
      .grid { grid-template-columns: 1fr; }
      .summary-grid, .mini-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <h1>Remodex Observability</h1>
      <div class="sub">shared memory와 runtime truth만 읽는 운영 상황판</div>
      <div class="meta" id="refresh-meta">loading...</div>
    </section>
    <div class="grid">
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <h2>Portfolio</h2>
            <div class="meta" id="portfolio-meta"></div>
          </div>
          <div class="panel-body cards" id="portfolio-cards"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Timeline</h2>
            <div class="meta" id="timeline-meta"></div>
          </div>
          <div class="panel-body timeline" id="timeline"></div>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <h2>Project Detail</h2>
            <div class="meta" id="detail-meta"></div>
          </div>
          <div class="panel-body" id="project-detail"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Human Gates</h2>
          </div>
          <div class="panel-body" id="human-gates"></div>
        </section>
        <section class="panel">
          <div class="panel-head">
            <h2>Incidents</h2>
          </div>
          <div class="panel-body" id="incidents"></div>
        </section>
      </div>
    </div>
  </div>
  <script>
    const state = { selectedProject: null };

    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    }

    function statusClass(project) {
      if ((project.incidents ?? []).length > 0) return "danger";
      if (project.scheduler_decision === "blocked") return "warn";
      return "";
    }

    async function getJson(url) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(\`\${url} -> \${response.status}\`);
      return await response.json();
    }

    function renderPortfolio(data) {
      const container = document.getElementById("portfolio-cards");
      document.getElementById("portfolio-meta").textContent = \`\${data.project_count} projects\`;
      const gateway = data.gateway_adapter ?? {};
      if (!state.selectedProject && data.projects.length > 0) {
        state.selectedProject = data.projects[0].project_key;
      }
      container.innerHTML = data.projects.map((project) => \`
        <article class="card \${project.project_key === state.selectedProject ? "active" : ""}" data-project-key="\${escapeHtml(project.project_key)}">
          <div class="card-top">
            <div class="project">\${escapeHtml(project.project_key)}</div>
            <div class="status \${statusClass(project)}">\${escapeHtml(project.coordinator_status)}</div>
          </div>
          <div class="mini-grid">
            <div><strong>Scheduler</strong>\${escapeHtml(project.scheduler_decision)}</div>
            <div><strong>Blocked</strong>\${escapeHtml((project.blocked_reasons ?? []).join(", ") || "-")}</div>
            <div><strong>Queue</strong>dispatch \${project.dispatch_queue_count} / inbox \${project.inbox_count}</div>
            <div><strong>Human Gate</strong>\${project.human_gate_count} / approvals \${project.pending_approvals_count}</div>
            <div><strong>Gateway</strong>\${escapeHtml(project.gateway_adapter?.last_event_type ?? gateway.last_event_type ?? "-")}</div>
            <div><strong>Last Interaction</strong>\${escapeHtml(project.gateway_adapter?.last_project_interaction?.command_class ?? "-")}</div>
          </div>
          <div class="pill-row" style="margin-top: 10px;">
            \${(project.incidents ?? []).map((reason) => \`<span class="pill incident">\${escapeHtml(reason)}</span>\`).join("")}
          </div>
        </article>
      \`).join("");

      for (const node of container.querySelectorAll("[data-project-key]")) {
        node.addEventListener("click", () => {
          state.selectedProject = node.getAttribute("data-project-key");
          refreshProject();
          refreshPortfolioOnly();
        });
      }
    }

    function renderDetail(detail) {
      document.getElementById("detail-meta").textContent = detail.project_key;
      const summary = detail.summary ?? {};
      const incidents = detail.incidents ?? [];
      const gateway = detail.gateway_adapter ?? {};
      document.getElementById("project-detail").innerHTML = \`
        <div class="summary-grid">
          <div class="summary-box"><strong>Status</strong>\${escapeHtml(detail.coordinator?.status?.type ?? summary.coordinator_status ?? "-")}</div>
          <div class="summary-box"><strong>Next Batch</strong>\${escapeHtml(summary.next_smallest_batch ?? "-")}</div>
          <div class="summary-box"><strong>Last Blocked</strong>\${escapeHtml((detail.last_action?.last_blocked_reason ?? []).join(", ") || "-")}</div>
          <div class="summary-box"><strong>Last Processed</strong>\${escapeHtml(detail.last_action?.last_processed?.correlation_key ?? "-")}</div>
          <div class="summary-box"><strong>Gateway Event</strong>\${escapeHtml(gateway.last_event_type ?? "-")}</div>
          <div class="summary-box"><strong>Gateway Interaction</strong>\${escapeHtml(gateway.last_project_interaction?.command_class ?? "-")}</div>
        </div>
        <div class="pill-row" style="margin-bottom: 12px;">
          \${incidents.map((reason) => \`<span class="pill incident">\${escapeHtml(reason)}</span>\`).join("") || '<span class="pill">no incident</span>'}
        </div>
        <div class="json-block">\${escapeHtml(JSON.stringify(detail, null, 2))}</div>
      \`;
    }

    function renderTimeline(data) {
      document.getElementById("timeline-meta").textContent = \`\${data.entries.length} entries\`;
      document.getElementById("timeline").innerHTML = data.entries.map((entry) => \`
        <div class="timeline-item">
          <strong>\${escapeHtml(entry.kind)}</strong>
          <div>\${escapeHtml(entry.summary ?? "-")}</div>
          <div class="meta">\${escapeHtml(entry.timestamp ?? "-")} · \${escapeHtml(entry.source_path ?? "-")}</div>
        </div>
      \`).join("") || '<div class="meta">no entries</div>';
    }

    function renderHumanGates(data) {
      document.getElementById("human-gates").innerHTML = data.entries.map((entry) => \`
        <div class="timeline-item">
          <strong>\${escapeHtml(entry.project_key)} · \${escapeHtml(entry.method ?? "approval")}</strong>
          <div>\${escapeHtml(entry.source_ref ?? "-")}</div>
          <div class="meta">\${escapeHtml(entry.observed_at ?? "-")}</div>
        </div>
      \`).join("") || '<div class="meta">no pending human gate</div>';
    }

    function renderIncidents(data) {
      document.getElementById("incidents").innerHTML = data.entries.map((entry) => \`
        <div class="timeline-item">
          <strong>\${escapeHtml(entry.project_key)} · \${escapeHtml(entry.reason)}</strong>
          <div>\${escapeHtml(entry.coordinator_status ?? "-")} / \${escapeHtml(entry.scheduler_decision ?? "-")}</div>
          <div class="meta">\${escapeHtml((entry.blocked_reasons ?? []).join(", ") || "-")}</div>
        </div>
      \`).join("") || '<div class="meta">no incidents</div>';
    }

    async function refreshPortfolioOnly() {
      const portfolio = await getJson("/api/portfolio");
      renderPortfolio(portfolio);
      const gateway = portfolio.gateway_adapter ?? {};
      const gatewayText = gateway.last_event_type
        ? \`gateway \${gateway.last_event_type} / ready \${gateway.ready_seen ? "yes" : "no"}\`
        : "gateway not observed";
      document.getElementById("refresh-meta").textContent = \`\${gatewayText} · last refresh \${new Date().toLocaleTimeString()}\`;
    }

    async function refreshProject() {
      if (!state.selectedProject) return;
      const [detail, timeline] = await Promise.all([
        getJson(\`/api/projects/\${encodeURIComponent(state.selectedProject)}\`),
        getJson(\`/api/projects/\${encodeURIComponent(state.selectedProject)}/timeline\`),
      ]);
      renderDetail(detail);
      renderTimeline(timeline);
    }

    async function refreshSidePanels() {
      const [humanGates, incidents] = await Promise.all([
        getJson("/api/human-gates"),
        getJson("/api/incidents"),
      ]);
      renderHumanGates(humanGates);
      renderIncidents(incidents);
    }

    async function refreshAll() {
      await refreshPortfolioOnly();
      await Promise.all([refreshProject(), refreshSidePanels()]);
    }

    refreshAll().catch((error) => {
      document.body.innerHTML = "<pre>" + escapeHtml(String(error)) + "</pre>";
    });
    setInterval(() => {
      refreshAll().catch((error) => console.error(error));
    }, 5000);
  </script>
</body>
</html>`;
}

function parseRoute(url) {
  const pathname = new URL(url, "http://localhost").pathname;
  const timelineMatch = pathname.match(/^\/api\/projects\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    return { type: "project-timeline", projectKey: decodeURIComponent(timelineMatch[1]) };
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    return { type: "project-detail", projectKey: decodeURIComponent(projectMatch[1]) };
  }
  if (pathname === "/api/portfolio") return { type: "portfolio" };
  if (pathname === "/api/human-gates") return { type: "human-gates" };
  if (pathname === "/api/incidents") return { type: "incidents" };
  if (pathname === "/health") return { type: "health" };
  if (pathname === "/") return { type: "root" };
  return { type: "not-found" };
}

async function handler(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  const route = parseRoute(req.url ?? "/");
  try {
    if (route.type === "root") {
      sendHtml(res, 200, appHtml());
      return;
    }
    if (route.type === "health") {
      const portfolio = await readPortfolioOverview({ sharedBase, workspaceKey });
      sendJson(res, 200, {
        ok: true,
        workspace_key: workspaceKey,
        project_count: portfolio.project_count,
        generated_at: new Date().toISOString(),
      });
      return;
    }
    if (route.type === "portfolio") {
      sendJson(res, 200, await readPortfolioOverview({ sharedBase, workspaceKey }));
      return;
    }
    if (route.type === "project-detail") {
      sendJson(
        res,
        200,
        await readProjectDetail({ sharedBase, workspaceKey, projectKey: route.projectKey }),
      );
      return;
    }
    if (route.type === "project-timeline") {
      sendJson(
        res,
        200,
        await readProjectTimeline({ sharedBase, workspaceKey, projectKey: route.projectKey }),
      );
      return;
    }
    if (route.type === "human-gates") {
      sendJson(res, 200, await readHumanGateView({ sharedBase, workspaceKey }));
      return;
    }
    if (route.type === "incidents") {
      sendJson(res, 200, await readIncidentView({ sharedBase, workspaceKey }));
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    sendJson(res, 500, errorPayload(error));
  }
}

const server = http.createServer(handler);
server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      ok: true,
      host,
      port,
      workspace_key: workspaceKey,
      shared_base: sharedBase,
    }),
  );
});
