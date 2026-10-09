#!/usr/bin/env bash
# Interactive update prompt for Clearshot
# Shown when a new version is available and update_mode is "ask"
# Usage: update-prompt.sh <current_version> <new_version>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$HOME/.clearshot"
CONFIG_FILE="$STATE_DIR/config.yaml"

source "$SCRIPT_DIR/picker.sh"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
CYAN='\033[36m'
RESET='\033[0m'

CURRENT="${1:-?}"
NEW="${2:-?}"

# ─── Header ───────────────────────────────────────────────────
echo
printf "  ${BOLD}clearshot update available${RESET}\n"
printf "  ${DIM}${CURRENT} → ${NEW}${RESET}\n"
echo
printf "  ${DIM}↑/↓ to select, enter to confirm${RESET}\n"
echo

pick 0 \
  "Update now          pull this version" \
  "Always update       auto-update from now on, never ask again"

if [ "$PICK_INDEX" -eq -1 ]; then
  printf "\n  ${DIM}skipped, continuing with v${CURRENT}${RESET}\n\n"
  exit 0
fi

# ─── Helper ──────────────────────────────────────────────────
_cs_set_config() {
  local key="$1" val="$2"
  if [ -f "$CONFIG_FILE" ] && grep -qE "^${key}:" "$CONFIG_FILE" 2>/dev/null; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s/^${key}:.*/${key}: ${val}/" "$CONFIG_FILE"
    else
      sed -i "s/^${key}:.*/${key}: ${val}/" "$CONFIG_FILE"
    fi
  elif [ -f "$CONFIG_FILE" ]; then
    echo "${key}: ${val}" >> "$CONFIG_FILE"
  else
    echo "${key}: ${val}" > "$CONFIG_FILE"
  fi
}

# ─── Execute ─────────────────────────────────────────────────
echo

# Always update → switch mode so future updates are automatic
if [ "$PICK_INDEX" -eq 1 ]; then
  _cs_set_config "update_mode" "always"
  printf "  ${DIM}switched to auto-update — you won't be asked again${RESET}\n"
fi

# Pull the update
printf "  ${DIM}pulling...${RESET}\n"
cd "$SKILL_DIR"
git pull origin main --quiet 2>/dev/null

# Clear the cache so preamble sees fresh state
rm -f "$STATE_DIR/last-update-check"

NEW_VER="$(cat "$SKILL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "$NEW")"
echo
printf "  ${GREEN}${BOLD}✓${RESET} updated to v${BOLD}${NEW_VER}${RESET}\n\n"
