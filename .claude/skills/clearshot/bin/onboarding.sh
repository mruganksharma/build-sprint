#!/usr/bin/env bash
# First-run onboarding for Clearshot
# Asks update preference + telemetry in one flow
# Works regardless of install method (npx skills, curl, manual)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.clearshot"
CONFIG_FILE="$STATE_DIR/config.yaml"

mkdir -p "$STATE_DIR/analytics" "$STATE_DIR/feedback"

source "$SCRIPT_DIR/picker.sh"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
CYAN='\033[36m'
RESET='\033[0m'

# ─── Config helper ────────────────────────────────────────────
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

# ─── Header ───────────────────────────────────────────────────
echo
printf "  ${BOLD}clearshot — first run setup${RESET}\n"
printf "  ${DIM}two quick questions, then you're done${RESET}\n"
echo
printf "  ${DIM}↑/↓ to select, enter to confirm${RESET}\n"
echo

# ─── Question 1: Updates ─────────────────────────────────────
printf "  ${CYAN}①${RESET}  ${BOLD}how should clearshot update?${RESET}\n"
echo

pick 0 \
  "Always keep updated    auto-pull new versions" \
  "Ask me every time      prompt before updating"

if [ "$PICK_INDEX" -eq -1 ] || [ "$PICK_INDEX" -eq 1 ]; then
  _UPDATE_MODE="ask"
else
  _UPDATE_MODE="always"
fi
_cs_set_config "update_mode" "$_UPDATE_MODE"

echo
if [ "$_UPDATE_MODE" = "always" ]; then
  printf "  ${GREEN}✓${RESET}  updates: ${BOLD}auto${RESET}\n"
else
  printf "  ${GREEN}✓${RESET}  updates: ${BOLD}ask every time${RESET}\n"
fi
echo

# ─── Question 2: Telemetry ───────────────────────────────────
printf "  ${CYAN}②${RESET}  ${BOLD}anonymous telemetry?${RESET}\n"
printf "     ${DIM}usage events only. no screenshots, code, or content.${RESET}\n"
echo

pick 1 \
  "Anonymous              usage events + hashed device ID (no PII)" \
  "Off                    nothing leaves your machine"

if [ "$PICK_INDEX" -eq -1 ] || [ "$PICK_INDEX" -eq 1 ]; then
  _TEL_MODE="off"
else
  _TEL_MODE="anonymous"
fi
_cs_set_config "telemetry" "$_TEL_MODE"
touch "$STATE_DIR/.telemetry-prompted"

echo
if [ "$_TEL_MODE" = "anonymous" ]; then
  printf "  ${GREEN}✓${RESET}  telemetry: ${BOLD}anonymous${RESET}\n"
else
  printf "  ${GREEN}✓${RESET}  telemetry: ${BOLD}off${RESET}\n"
fi

echo
printf "  ${GREEN}${BOLD}done.${RESET} ${DIM}drop a UI screenshot and clearshot activates automatically.${RESET}\n"
printf "  ${DIM}re-run anytime: ! <skill-dir>/bin/onboarding.sh${RESET}\n"
echo
