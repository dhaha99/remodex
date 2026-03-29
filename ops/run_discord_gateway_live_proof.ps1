Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir "lib/RemodexEnv.ps1")

$WorkspaceDir = Resolve-RemodexWorkspaceDir -ScriptRoot $ScriptDir
$EnvFile = if ($env:REMODEX_ENV_FILE) { $env:REMODEX_ENV_FILE } else { Join-Path $WorkspaceDir "ops/remodex.env" }

Import-RemodexEnvFile -Path $EnvFile

if (-not $env:REMODEX_WORKSPACE) { $env:REMODEX_WORKSPACE = $WorkspaceDir }
if (-not $env:REMODEX_SHARED_BASE) { $env:REMODEX_SHARED_BASE = Join-Path $env:REMODEX_WORKSPACE "runtime/external-shared-memory" }
if (-not $env:REMODEX_WORKSPACE_KEY) { $env:REMODEX_WORKSPACE_KEY = "remodex" }
if (-not $env:REMODEX_NODE_BIN) { $env:REMODEX_NODE_BIN = "node" }
if (-not $env:REMODEX_DISCORD_LIVE_PROOF_DIR) { $env:REMODEX_DISCORD_LIVE_PROOF_DIR = Join-Path $env:REMODEX_WORKSPACE "runtime/live-discord-proof" }
if (-not $env:REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS) { $env:REMODEX_DISCORD_LIVE_PROOF_REGISTER_COMMANDS = "true" }
if (-not $env:REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION) { $env:REMODEX_DISCORD_LIVE_PROOF_EXPECT_INTERACTION = "false" }
if (-not $env:REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS) { $env:REMODEX_DISCORD_LIVE_PROOF_TIMEOUT_MS = "120000" }

& $env:REMODEX_NODE_BIN (Join-Path $env:REMODEX_WORKSPACE "ops/run_discord_gateway_live_proof.mjs")
$runnerExitCode = $LASTEXITCODE

& $env:REMODEX_NODE_BIN (Join-Path $env:REMODEX_WORKSPACE "ops/finalize_discord_gateway_live_proof.mjs")
$finalizeExitCode = $LASTEXITCODE

if ($runnerExitCode -ne 0) {
  exit $runnerExitCode
}

exit $finalizeExitCode
