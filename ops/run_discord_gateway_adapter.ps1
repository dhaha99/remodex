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
if (-not $env:REMODEX_DISCORD_GATEWAY_URL) { $env:REMODEX_DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json" }
if (-not $env:REMODEX_DISCORD_GATEWAY_INTENTS) { $env:REMODEX_DISCORD_GATEWAY_INTENTS = "0" }
if (-not $env:REMODEX_DISCORD_API_BASE_URL) { $env:REMODEX_DISCORD_API_BASE_URL = "https://discord.com/api/v10" }

if (-not $env:REMODEX_DISCORD_BOT_TOKEN -and -not $env:REMODEX_DISCORD_BOT_TOKEN_PATH) {
  throw "REMODEX_DISCORD_BOT_TOKEN or REMODEX_DISCORD_BOT_TOKEN_PATH is required"
}

& $env:REMODEX_NODE_BIN (Join-Path $env:REMODEX_WORKSPACE "scripts/remodex_discord_gateway_adapter.mjs")
exit $LASTEXITCODE
