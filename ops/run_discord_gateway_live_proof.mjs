import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { runDiscordGatewayLivePreflight } from "./check_discord_gateway_live_preflight.mjs";

const workspace = process.env.REMODEX_WORKSPACE ?? process.cwd();
const nodeBin = process.env.REMODEX_NODE_BIN ?? "node";
const proofDir =
  process.env.REMODEX_DISCORD_LIVE_PROOF_DIR ?? path.join(workspace, "runtime", "live-discord-proof");
const adapterEntry =
  process.env.REMODEX_DISCORD_GATEWAY_ADAPTER_ENTRY ??
  path.join(workspace, "scripts", "remodex_discord_gateway_adapter.mjs");
const registerEntry =
  process.env.REMODEX_DISCORD_COMMAND_REGISTRAR_ENTRY ??
  path.join(workspace, "ops", "register_discord_commands.mjs");
const registerCommands = (process.env.REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS ?? "true") !== "false";
const expectInteraction = (process.env.REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION ?? "false") === "true";
const timeoutMs = Number.parseInt(process.env.REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS ?? "120000", 10);
const pollMs = Number.parseInt(process.env.REMODEX_DISCORD_LIVE_PROOF_POLL_MS ?? "1000", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function spawnLogged(command, args, { cwd, env, stdoutPath, stderrPath }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return Promise.all([
    ensureDir(path.dirname(stdoutPath)),
    ensureDir(path.dirname(stderrPath)),
  ]).then(async () => {
    const stdoutHandle = await fs.open(stdoutPath, "w");
    const stderrHandle = await fs.open(stderrPath, "w");
    child.stdout.pipe(stdoutHandle.createWriteStream());
    child.stderr.pipe(stderrHandle.createWriteStream());
    return {
      child,
      async closeLogs() {
        await stdoutHandle.close();
        await stderrHandle.close();
      },
    };
  });
}

async function runCommand(command, args, { cwd, env, stdoutPath, stderrPath }) {
  const { child, closeLogs } = await spawnLogged(command, args, {
    cwd,
    env,
    stdoutPath,
    stderrPath,
  });
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await closeLogs();
  if (exit.code !== 0) {
    const stderr = await readTextIfExists(stderrPath);
    throw new Error(
      `command failed: ${command} ${args.join(" ")} (code=${exit.code ?? "null"}${stderr ? `, stderr=${stderr.trim()}` : ""})`,
    );
  }
  return exit;
}

async function waitForProof({ statePath, eventsLogPath, expectInteraction, timeoutMs, pollMs }) {
  const startedAt = Date.now();
  let lastState = null;
  let interactionObserved = false;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readJsonIfExists(statePath);
    if (!interactionObserved) {
      const eventsText = await readTextIfExists(eventsLogPath);
      interactionObserved = Boolean(eventsText?.includes("\"type\":\"interaction_create\""));
    }
    const readySeen = lastState?.snapshot?.ready_seen === true;
    if (readySeen && (!expectInteraction || interactionObserved)) {
      return {
        ready_seen: readySeen,
        interaction_observed: interactionObserved,
        state: lastState,
      };
    }
    await sleep(pollMs);
  }
  return {
    ready_seen: lastState?.snapshot?.ready_seen === true,
    interaction_observed: interactionObserved,
    state: lastState,
    timed_out: true,
  };
}

async function main() {
  await ensureDir(proofDir);
  const outputPath = path.join(proofDir, "live-proof-bundle.json");
  const bundle = {
    started_at: new Date().toISOString(),
    proof_dir: proofDir,
    adapter_entry: adapterEntry,
    register_commands: registerCommands,
    expect_interaction: expectInteraction,
    timeout_ms: timeoutMs,
  };

  try {
  const preflight = await runDiscordGatewayLivePreflight({
    env: process.env,
    networkChecks: false,
  });
  bundle.preflight = preflight;

  if (!preflight.ok) {
    bundle.ok = false;
    bundle.phase = "preflight";
    bundle.completed_at = new Date().toISOString();
    await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
    console.error(JSON.stringify(bundle, null, 2));
    process.exit(1);
  }

  const statePath = path.join(
    process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory"),
    process.env.REMODEX_WORKSPACE_KEY ?? "remodex",
    "router",
    "discord_gateway_adapter_state.json",
  );
  const eventsLogPath = path.join(
    process.env.REMODEX_SHARED_BASE ?? path.join(workspace, "runtime", "external-shared-memory"),
    process.env.REMODEX_WORKSPACE_KEY ?? "remodex",
    "router",
    "discord_gateway_events.jsonl",
  );

  if (registerCommands) {
    await runCommand(nodeBin, [registerEntry], {
      cwd: workspace,
      env: process.env,
      stdoutPath: path.join(proofDir, "register-commands.stdout.log"),
      stderrPath: path.join(proofDir, "register-commands.stderr.log"),
    });
    bundle.register_commands_result = "completed";
  } else {
    bundle.register_commands_result = "skipped";
  }

  const adapterLogs = await spawnLogged(nodeBin, [adapterEntry], {
    cwd: workspace,
    env: process.env,
    stdoutPath: path.join(proofDir, "gateway-adapter.stdout.log"),
    stderrPath: path.join(proofDir, "gateway-adapter.stderr.log"),
  });
  bundle.phase = "adapter_wait";
  bundle.adapter_pid = adapterLogs.child.pid;

  const proof = await waitForProof({
    statePath,
    eventsLogPath,
    expectInteraction,
    timeoutMs,
    pollMs,
  });

  bundle.state_path = statePath;
  bundle.events_log_path = eventsLogPath;
  bundle.proof = proof;
  bundle.ok = proof.ready_seen && (!expectInteraction || proof.interaction_observed);
  bundle.completed_at = new Date().toISOString();

  if (adapterLogs.child.exitCode === null && adapterLogs.child.signalCode === null) {
    adapterLogs.child.kill("SIGTERM");
  }
  await waitForChildExit(adapterLogs.child);
  await adapterLogs.closeLogs();

  await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);

  if (!bundle.ok) {
    console.error(JSON.stringify(bundle, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(bundle, null, 2));
  } catch (error) {
    bundle.ok = false;
    bundle.phase = bundle.phase ?? "failed";
    bundle.completed_at = new Date().toISOString();
    bundle.error = {
      message: error.message,
      stack: error.stack,
    };
    await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`);
    console.error(JSON.stringify(bundle, null, 2));
    process.exit(1);
  }
}

await main();
