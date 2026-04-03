#!/usr/bin/env bash
# ============================================================
# Linear Dev Cycle Pipeline — One-Click Setup
#
# This script prepares a fresh machine to run the
# "Linear Dev Cycle" pipeline in workflow-control.
#
# What it does:
#   1. Checks / clones the workflow-control repo
#   2. Verifies system prerequisites (Node >= 22.5, pnpm, Claude CLI)
#   3. Collects required credentials interactively
#   4. Writes .env.local & system-settings.yaml
#   5. Installs dependencies & builds
#   6. Prints the command to start the pipeline
# ============================================================

set -euo pipefail

# ---------- Colors ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
err()   { printf "${RED}[ERROR]${NC} %s\n" "$*"; }
ask()   { printf "${BOLD}%s${NC}" "$*"; }

divider() { printf "\n${CYAN}%s${NC}\n" "============================================================"; }

# portable lowercase
to_lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ============================================================
# Phase 1: Repository
# ============================================================
divider
printf "${BOLD}  Phase 1: workflow-control Repository${NC}\n"
divider

REPO_URL="https://github.com/ymh357/workflow-control.git"
REPO_DIR=""

ask "Do you already have the workflow-control repo cloned locally? (y/N): "
read -r HAS_REPO

if [[ "$(to_lower "$HAS_REPO")" == "y" ]]; then
  ask "Enter the absolute path to the repo: "
  read -r REPO_DIR
  REPO_DIR="${REPO_DIR/#\~/$HOME}"  # expand tilde
  if [[ ! -f "$REPO_DIR/package.json" ]]; then
    err "package.json not found at $REPO_DIR — not a valid repo."
    exit 1
  fi
  ok "Using existing repo at $REPO_DIR"
else
  DEFAULT_CLONE_DIR="$HOME/workflow-control"
  ask "Where should we clone? (default: $DEFAULT_CLONE_DIR): "
  read -r CLONE_DIR
  CLONE_DIR="${CLONE_DIR:-$DEFAULT_CLONE_DIR}"
  CLONE_DIR="${CLONE_DIR/#\~/$HOME}"

  if [[ -d "$CLONE_DIR/.git" ]]; then
    info "Repo already exists at $CLONE_DIR, pulling latest..."
    git -C "$CLONE_DIR" pull --ff-only || warn "Pull failed — continuing with existing version."
    REPO_DIR="$CLONE_DIR"
  else
    info "Cloning from $REPO_URL ..."
    git clone "$REPO_URL" "$CLONE_DIR"
    REPO_DIR="$CLONE_DIR"
  fi
  ok "Repo ready at $REPO_DIR"
fi

cd "$REPO_DIR"

# ============================================================
# Phase 2: System Prerequisites
# ============================================================
divider
printf "${BOLD}  Phase 2: System Prerequisites${NC}\n"
divider

PREREQS_OK=true

# --- Node.js ---
if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
  NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
  if (( NODE_MAJOR > 22 || (NODE_MAJOR == 22 && NODE_MINOR >= 5) )); then
    ok "Node.js $NODE_VER (>= 22.5 required)"
  else
    err "Node.js $NODE_VER found, but >= 22.5 is required (for node:sqlite)."
    echo "    Install: brew install node@22  OR  nvm install 22"
    PREREQS_OK=false
  fi
else
  err "Node.js not found."
  echo "    Install: brew install node@22  OR  https://nodejs.org"
  PREREQS_OK=false
fi

# --- pnpm ---
if command -v pnpm &>/dev/null; then
  ok "pnpm $(pnpm -v)"
else
  err "pnpm not found."
  echo "    Install: npm install -g pnpm  OR  brew install pnpm"
  PREREQS_OK=false
fi

# --- npx ---
if command -v npx &>/dev/null; then
  ok "npx available"
else
  err "npx not found (required for MCP servers)."
  echo "    npx should come with Node.js — check your PATH."
  PREREQS_OK=false
fi

# --- Agent engines (at least one required) ---
FOUND_ENGINE=false
CLAUDE_PATH=""
GEMINI_PATH=""
CODEX_PATH=""

if command -v claude &>/dev/null; then
  CLAUDE_PATH=$(which claude)
  ok "Claude CLI at $CLAUDE_PATH"
  FOUND_ENGINE=true
else
  warn "Claude CLI not found."
fi

if command -v gemini &>/dev/null; then
  GEMINI_PATH=$(which gemini)
  ok "Gemini CLI at $GEMINI_PATH"
  FOUND_ENGINE=true
else
  warn "Gemini CLI not found."
fi

if command -v codex &>/dev/null; then
  CODEX_PATH=$(which codex)
  ok "Codex CLI at $CODEX_PATH"
  FOUND_ENGINE=true
else
  warn "Codex CLI not found."
fi

if [[ "$FOUND_ENGINE" != "true" ]]; then
  err "No agent engine found. At least one of Claude, Gemini, or Codex CLI is required."
  echo "    Claude: https://docs.anthropic.com/en/docs/claude-code"
  echo "    Gemini: https://github.com/google-gemini/gemini-cli"
  echo "    Codex:  https://github.com/openai/codex"
  PREREQS_OK=false
fi

# --- git ---
if command -v git &>/dev/null; then
  ok "git $(git --version | awk '{print $3}')"
else
  err "git not found."
  PREREQS_OK=false
fi

# --- gh CLI (optional but recommended) ---
if command -v gh &>/dev/null; then
  ok "gh CLI $(gh --version | head -1 | awk '{print $3}')"
else
  warn "gh CLI not found (optional). Install: brew install gh"
fi

if [[ "$PREREQS_OK" != "true" ]]; then
  err "Some prerequisites are missing. Please install them and re-run."
  exit 1
fi

# ============================================================
# Phase 3: Collect Credentials
# ============================================================
divider
printf "${BOLD}  Phase 3: Credential Configuration${NC}\n"
divider

# --- 3a. GitLab (REQUIRED) ---
echo ""
printf "${BOLD}[GitLab — REQUIRED]${NC}\n"
echo "  The pipeline creates branches, verifies CI, and submits merge requests on GitLab."
echo ""
echo "  How to get your GitLab Personal Access Token:"
echo "    1. Log in to GitLab (gitlab.com or your self-hosted instance)"
echo "    2. Go to: Settings -> Access Tokens"
echo "       URL: https://gitlab.com/-/user_settings/personal_access_tokens"
echo "    3. Click 'Add new token'"
echo "       - Name: workflow-control"
echo "       - Scopes: api, read_repository, write_repository"
echo "       - Expiration: as needed"
echo "    4. Copy the generated token (starts with glpat-)"
echo ""

GITLAB_TOKEN=""
while [[ -z "$GITLAB_TOKEN" ]]; do
  ask "GitLab Personal Access Token: "
  read -rs GITLAB_TOKEN
  echo ""  # newline after silent read
  if [[ -z "$GITLAB_TOKEN" ]]; then
    err "GitLab token is required. The pipeline cannot create branches or MRs without it."
  fi
done

ok "GitLab token received."

echo ""
echo "  GitLab API URL:"
echo "    - For gitlab.com:         https://gitlab.com"
echo "    - For self-hosted:        https://your-gitlab-domain.com"
echo "    (Do NOT include /api/v4 — the MCP server appends it automatically)"
echo ""

ask "GitLab API URL (default: https://gitlab.com): "
read -r GITLAB_API_URL
GITLAB_API_URL="${GITLAB_API_URL:-https://gitlab.com}"

ok "GitLab configured: $GITLAB_API_URL"

# --- 3b. Linear (REQUIRED — OAuth) ---
echo ""
printf "${BOLD}[Linear — REQUIRED]${NC}\n"
echo "  The pipeline fetches tickets from Linear via OAuth (no token needed)."
echo "  On first use, a browser window will open for you to authorize."
echo ""
echo "  How it works:"
echo "    - The MCP server uses 'mcp-remote' to connect to https://mcp.linear.app/mcp"
echo "    - First connection opens a browser for OAuth consent"
echo "    - After authorization, credentials are cached locally (~/.mcp-auth/)"
echo ""
echo "  Pre-flight test (optional):"
echo "    Run: npx -y mcp-remote \"https://mcp.linear.app/mcp\""
echo "    If a browser opens and you authorize, you're all set."
echo ""
ask "Would you like to test Linear OAuth now? (y/N): "
read -r TEST_LINEAR

if [[ "$(to_lower "$TEST_LINEAR")" == "y" ]]; then
  info "Starting Linear OAuth flow... (a browser window should open)"
  info "After authorizing in the browser, press Ctrl+C to return here."
  # macOS has no `timeout`; use bash background + sleep fallback
  npx -y mcp-remote "https://mcp.linear.app/mcp" 2>&1 &
  NPX_PID=$!
  ( sleep 60 && kill "$NPX_PID" 2>/dev/null ) &
  TIMER_PID=$!
  wait "$NPX_PID" 2>/dev/null || true
  kill "$TIMER_PID" 2>/dev/null || true
  ok "If you authorized in the browser, Linear is ready."
else
  warn "Skipped. Linear OAuth will be triggered when the pipeline first runs."
fi

# --- 3c. Notion (OPTIONAL) ---
echo ""
printf "${BOLD}[Notion — OPTIONAL]${NC}\n"
echo "  Used to gather requirements from Notion docs linked in Linear tickets."
echo "  If not configured, the pipeline continues without Notion context."
echo ""
echo "  How to get your Notion Integration Token:"
echo "    1. Go to https://www.notion.so/profile/integrations"
echo "    2. Click '+ New integration'"
echo "       - Name: workflow-control"
echo "       - Associated workspace: select your workspace"
echo "       - Capabilities: Read content, Read comments"
echo "    3. Copy the Internal Integration Secret (starts with ntn_)"
echo "    4. IMPORTANT: In Notion, open the pages you want to access"
echo "       -> Click '...' -> 'Add connections' -> select 'workflow-control'"
echo "       (The integration can only see pages explicitly shared with it)"
echo ""

ask "Notion Integration Token (press Enter to skip): "
read -rs NOTION_TOKEN
echo ""

if [[ -n "$NOTION_TOKEN" ]]; then
  ok "Notion configured."
else
  warn "Skipped. gatherNotion stage will gracefully degrade."
fi

# --- 3d. Figma (OPTIONAL) ---
echo ""
printf "${BOLD}[Figma — OPTIONAL]${NC}\n"
echo "  Used to extract design specs from Figma URLs in Linear tickets."
echo "  If not configured, the pipeline continues without design context."
echo ""
echo "  How to get your Figma Access Token:"
echo "    1. Go to https://www.figma.com/developers/api#access-tokens"
echo "       Or: Figma -> Settings -> Personal Access Tokens"
echo "    2. Click 'Generate new token'"
echo "       - Description: workflow-control"
echo "       - Expiration: as needed"
echo "       - Scopes: File content (Read-only) is sufficient"
echo "    3. Copy the token (starts with figd_)"
echo ""

ask "Figma Access Token (press Enter to skip): "
read -rs FIGMA_TOKEN
echo ""

if [[ -n "$FIGMA_TOKEN" ]]; then
  ok "Figma configured."
else
  warn "Skipped. extractFigma stage will gracefully degrade."
fi

# --- 3e. Paths ---
echo ""
printf "${BOLD}[Paths]${NC}\n"
echo "  repos_base: The parent directory where your target git repos live."
echo "  For example, if your repo is at ~/projects/my-app, enter ~/projects"
echo ""

while true; do
  ask "Repos base directory (default: $HOME): "
  read -r REPOS_BASE
  REPOS_BASE="${REPOS_BASE:-$HOME}"
  REPOS_BASE="${REPOS_BASE/#\~/$HOME}"
  if [[ -d "$REPOS_BASE" ]]; then
    break
  else
    err "Directory '$REPOS_BASE' does not exist. Please enter a valid path."
  fi
done

WORKTREES_BASE="$HOME/wfc-worktrees"
ask "Worktrees directory (default: $WORKTREES_BASE): "
read -r CUSTOM_WORKTREES
WORKTREES_BASE="${CUSTOM_WORKTREES:-$WORKTREES_BASE}"
WORKTREES_BASE="${WORKTREES_BASE/#\~/$HOME}"

mkdir -p "$WORKTREES_BASE"
ok "Paths configured: repos=$REPOS_BASE, worktrees=$WORKTREES_BASE"

# ============================================================
# Phase 4: Write Configuration
# ============================================================
divider
printf "${BOLD}  Phase 4: Write Configuration Files${NC}\n"
divider

ENV_LOCAL="$REPO_DIR/apps/server/.env.local"

# Back up existing .env.local if present
if [[ -f "$ENV_LOCAL" ]]; then
  BACKUP="${ENV_LOCAL}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$ENV_LOCAL" "$BACKUP"
  warn "Existing .env.local backed up to $BACKUP"
fi

# Build .env.local (heredoc content must be unindented)
cat > "$ENV_LOCAL" <<EOF
# Generated by setup-linear-dev-cycle.sh on $(date +%Y-%m-%d)
REPOS_BASE_PATH=${REPOS_BASE}
WORKTREES_BASE_PATH=${WORKTREES_BASE}

# Agent engine paths (auto-detected)
EOF

[[ -n "$CLAUDE_PATH" ]] && echo "CLAUDE_PATH=${CLAUDE_PATH}" >> "$ENV_LOCAL"
[[ -n "$GEMINI_PATH" ]] && echo "GEMINI_PATH=${GEMINI_PATH}" >> "$ENV_LOCAL"
[[ -n "$CODEX_PATH" ]]  && echo "CODEX_PATH=${CODEX_PATH}" >> "$ENV_LOCAL"

cat >> "$ENV_LOCAL" <<EOF

# GitLab (required for Linear Dev Cycle)
GITLAB_PERSONAL_ACCESS_TOKEN=${GITLAB_TOKEN}
GITLAB_API_URL=${GITLAB_API_URL}
EOF

if [[ -n "$NOTION_TOKEN" ]]; then
  printf '\n# Notion\nSETTING_NOTION_TOKEN=%s\n' "$NOTION_TOKEN" >> "$ENV_LOCAL"
fi

if [[ -n "$FIGMA_TOKEN" ]]; then
  printf '\n# Figma\nSETTING_FIGMA_ACCESS_TOKEN=%s\n' "$FIGMA_TOKEN" >> "$ENV_LOCAL"
fi

ok "Written: $ENV_LOCAL"

# Write system-settings.yaml if not present
SETTINGS_YAML="$REPO_DIR/apps/server/config/system-settings.yaml"
if [[ ! -f "$SETTINGS_YAML" ]]; then
  # heredoc content must be unindented to produce valid YAML
  cat > "$SETTINGS_YAML" <<'YAML'
# Generated by setup-linear-dev-cycle.sh
paths:
  repos_base: ${REPOS_BASE_PATH}
  worktrees_base: ${WORKTREES_BASE_PATH}
  data_dir: /tmp/workflow-control-data
  claude_executable: claude
  gemini_executable: gemini
  codex_executable: codex
agent:
  default_model: claude-sonnet-4-6
  claude_model: claude-sonnet-4-6
  default_engine: claude
figma:
  access_token: ${SETTING_FIGMA_ACCESS_TOKEN}
sandbox:
  enabled: true
  auto_allow_bash: true
  allow_unsandboxed_commands: true
YAML
  ok "Written: $SETTINGS_YAML"
else
  ok "system-settings.yaml already exists, not overwriting."
fi

# ============================================================
# Phase 5: Install & Build
# ============================================================
divider
printf "${BOLD}  Phase 5: Install Dependencies & Build${NC}\n"
divider

info "Running pnpm install ..."
pnpm install

info "Building shared package ..."
pnpm --filter shared build

info "Building registry index ..."
if ! pnpm --filter server registry:build; then
  warn "Registry build failed (exit $?). Check registry/ for issues."
fi

info "Bootstrapping default pipeline configs ..."
if ! pnpm --filter server registry:bootstrap; then
  warn "Registry bootstrap failed (exit $?). May already be installed."
fi

ok "Build complete."

# ============================================================
# Phase 6: Verification Summary
# ============================================================
divider
printf "${BOLD}  Phase 6: Setup Summary${NC}\n"
divider

echo ""
printf "  ${BOLD}%-23s Status${NC}\n" "Component"
echo "  ----------------------------------------"
printf "  %-23s ${GREEN}%s${NC}\n" "Node.js" "$(node -v)"
printf "  %-23s ${GREEN}%s${NC}\n" "pnpm" "$(pnpm -v)"

if [[ -n "$CLAUDE_PATH" ]]; then
  printf "  %-23s ${GREEN}%s${NC}\n" "Claude CLI" "$CLAUDE_PATH"
else
  printf "  %-23s ${YELLOW}%s${NC}\n" "Claude CLI" "not found"
fi
if [[ -n "$GEMINI_PATH" ]]; then
  printf "  %-23s ${GREEN}%s${NC}\n" "Gemini CLI" "$GEMINI_PATH"
else
  printf "  %-23s ${YELLOW}%s${NC}\n" "Gemini CLI" "not found"
fi
if [[ -n "$CODEX_PATH" ]]; then
  printf "  %-23s ${GREEN}%s${NC}\n" "Codex CLI" "$CODEX_PATH"
else
  printf "  %-23s ${YELLOW}%s${NC}\n" "Codex CLI" "not found"
fi

printf "  %-23s ${GREEN}%s${NC}\n" "GitLab Token" "configured (hidden)"
printf "  %-23s ${GREEN}%s${NC}\n" "GitLab URL" "$GITLAB_API_URL"
printf "  %-23s ${YELLOW}%s${NC}\n" "Linear OAuth" "browser auth on first use"

if [[ -n "$NOTION_TOKEN" ]]; then
  printf "  %-23s ${GREEN}%s${NC}\n" "Notion Token" "configured (hidden)"
else
  printf "  %-23s ${YELLOW}%s${NC}\n" "Notion Token" "skipped (optional)"
fi

if [[ -n "$FIGMA_TOKEN" ]]; then
  printf "  %-23s ${GREEN}%s${NC}\n" "Figma Token" "configured (hidden)"
else
  printf "  %-23s ${YELLOW}%s${NC}\n" "Figma Token" "skipped (optional)"
fi

printf "  %-23s ${GREEN}%s${NC}\n" "Repos Base" "$REPOS_BASE"
printf "  %-23s ${GREEN}%s${NC}\n" "Worktrees Dir" "$WORKTREES_BASE"
echo ""

# ============================================================
# Phase 7: Output Startup Commands
# ============================================================
divider
printf "${BOLD}  Ready to Run!${NC}\n"
divider

cat <<USAGE

  Step 1: Start the server + dashboard

    cd $REPO_DIR
    pnpm dev

  Step 2: Open the dashboard

    http://localhost:3004

  Step 3: Trigger the Linear Dev Cycle pipeline

  Option A -- From the dashboard:
    1. Go to http://localhost:3004
    2. Click 'New Task'
    3. Select pipeline: 'linear-dev-cycle'
    4. Enter a Linear ticket URL or ID as the task text
    5. Click 'Start'

  Option B -- From Claude Code CLI:
    claude
    > /workflow
    > Run the Linear Dev Cycle pipeline for ticket LIN-123

  Option C -- Via curl:
    curl -X POST http://localhost:3001/api/tasks \\
      -H 'Content-Type: application/json' \\
      -d '{"text": "LIN-123", "pipeline": "linear-dev-cycle"}'

  Pipeline flow:
    fetchTicket -> [confirm] -> gatherContext(Notion+Figma)
    -> planImplementation -> [confirm] -> createBranch
    -> setupWorktree -> implement -> testAndFix
    -> verifyCI -> [confirm] -> submitMergeRequest

USAGE

printf "  ${YELLOW}Note: The pipeline has 3 human confirmation gates.${NC}\n"
printf "  ${YELLOW}Check the dashboard or Slack for approval prompts.${NC}\n\n"
