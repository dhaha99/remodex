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
if (-not $env:REMODEX_OPERATOR_HTTP_HOST) { $env:REMODEX_OPERATOR_HTTP_HOST = "127.0.0.1" }
if (-not $env:REMODEX_OPERATOR_HTTP_PORT) { $env:REMODEX_OPERATOR_HTTP_PORT = "8787" }
if (-not $env:REMODEX_AUTO_CONSUME_HUMAN_GATE) { $env:REMODEX_AUTO_CONSUME_HUMAN_GATE = "false" }
if (-not $env:REMODEX_NODE_BIN) { $env:REMODEX_NODE_BIN = "node" }

& $env:REMODEX_NODE_BIN (Join-Path $env:REMODEX_WORKSPACE "scripts/remodex_bridge_daemon.mjs")
exit $LASTEXITCODE
