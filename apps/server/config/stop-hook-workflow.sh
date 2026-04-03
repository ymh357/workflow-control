#!/usr/bin/env bash
# Stop Hook: Prevents Claude Code from stopping while a workflow pipeline is still running.
#
# Mechanism: Claude Code calls this hook whenever it's about to stop (no more tool_use blocks).
# If an active pipeline task exists and is not in a terminal state, this hook returns
# decision=block, which forces Claude Code's queryLoop to inject a blocking error and continue.
#
# Environment:
#   WFC_SERVER_URL  - workflow-control server URL (default: http://localhost:3001)
#
# Input: JSON on stdin (Claude Code hook protocol)
# Output: JSON on stdout

# Do NOT use set -e — grep/curl failures are handled explicitly below.
set -uo pipefail

# Read hook input from stdin (required by Claude Code hook protocol)
read -r HOOK_INPUT 2>/dev/null || true

SERVER_URL="${WFC_SERVER_URL:-http://localhost:3001}"

# Query for any active (non-terminal) pipeline task
STATUS_JSON=$(curl -sf --max-time 3 "${SERVER_URL}/api/edge/_active-pipeline" 2>/dev/null) || {
  # Server unreachable — allow stop (don't block the user)
  echo '{}'
  exit 0
}

# Check if pipeline is terminal. Use grep -q which sets exit code without output.
# If isTerminal is true, allow stop. If false (or field missing), block stop.
if echo "$STATUS_JSON" | grep -q '"isTerminal":true'; then
  # No active pipeline — allow stop
  echo '{}'
  exit 0
fi

# Active pipeline found — extract fields for the blocking message.
# Use parameter expansion as a safe fallback if extraction fails.
TASK_STATUS="unknown"
PROGRESS="?/?"
PIPELINE="unknown"

# Extract values with sed — failures are non-fatal due to defaults above
TASK_STATUS=$(echo "$STATUS_JSON" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p') || true
PROGRESS=$(echo "$STATUS_JSON" | sed -n 's/.*"progress":"\([^"]*\)".*/\1/p') || true
PIPELINE=$(echo "$STATUS_JSON" | sed -n 's/.*"pipelineName":"\([^"]*\)".*/\1/p') || true

# Use defaults if sed returned empty
: "${TASK_STATUS:=unknown}"
: "${PROGRESS:=?/?}"
: "${PIPELINE:=unknown}"

cat <<STOP_JSON
{
  "decision": "block",
  "reason": "Workflow pipeline '${PIPELINE}' is still running (status: ${TASK_STATUS}, progress: ${PROGRESS}). Call list_available_stages to pick up the next stage. Do NOT stop until the pipeline reaches a terminal state (completed/error/cancelled)."
}
STOP_JSON
