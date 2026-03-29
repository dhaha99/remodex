import fs from "node:fs/promises";
import path from "node:path";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(
  verificationDir,
  "no_public_raw_bridge_exposure_probe_summary.json",
);

async function read(relativePath) {
  return await fs.readFile(path.join(workspace, relativePath), "utf8");
}

function expectMatch(text, pattern, reason) {
  if (!pattern.test(text)) {
    throw new Error(reason);
  }
}

const summary = {
  startedAt: new Date().toISOString(),
};

try {
  await fs.mkdir(verificationDir, { recursive: true });

  const bridgeDaemon = await read("scripts/remodex_bridge_daemon.mjs");
  const envExample = await read("ops/remodex.env.example");
  const readme = await read("README.md");
  const bootstrap = await read("PRODUCTION_BOOTSTRAP.md");
  const normalOps = await read("NORMAL_OPS_MANUAL.md");

  expectMatch(
    bridgeDaemon,
    /const host = process\.env\.REMODEX_OPERATOR_HTTP_HOST \?\? "127\.0\.0\.1";/,
    "bridge daemon default host is not loopback",
  );
  expectMatch(
    envExample,
    /REMODEX_OPERATOR_HTTP_HOST="127\.0\.0\.1"/,
    "env example does not pin operator host to loopback",
  );
  expectMatch(
    envExample,
    /REMODEX_DASHBOARD_HTTP_HOST="127\.0\.0\.1"/,
    "env example does not pin dashboard host to loopback",
  );
  expectMatch(
    readme,
    /canonical path는 \*\*Discord Gateway adapter\*\*다\./,
    "README does not declare Gateway adapter as canonical ingress",
  );
  expectMatch(
    readme,
    /bridge daemon` HTTP ingress는 loopback 내부\/probe용이다\./i,
    "README does not mark raw bridge ingress as internal-only",
  );
  expectMatch(
    bootstrap,
    /canonical path는 \*\*Discord Gateway adapter\*\*/i,
    "bootstrap doc does not declare canonical ingress",
  );
  expectMatch(
    normalOps,
    /Discord 실운영 연결은 Gateway adapter가 담당한다\./,
    "normal ops manual does not assign production ingress to Gateway adapter",
  );

  summary.evidence = {
    bridge_default_loopback: true,
    env_example_operator_loopback: true,
    env_example_dashboard_loopback: true,
    readme_gateway_canonical: true,
    readme_internal_probe_only: true,
    bootstrap_gateway_canonical: true,
    normal_ops_gateway_owner: true,
  };
  summary.finishedAt = new Date().toISOString();
  summary.status = "PASS";
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
}

await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

if (summary.status !== "PASS") {
  throw new Error(summary.error ?? "no public raw bridge exposure probe failed");
}
