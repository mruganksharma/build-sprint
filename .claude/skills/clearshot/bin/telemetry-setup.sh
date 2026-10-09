#!/usr/bin/env bash
# Interactive telemetry opt-in picker for Clearshot
# Can run standalone or be sourced by other scripts

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_DIR="$HOME/.clearshot"
CONFIG_FILE="$STATE_DIR/config.yaml"
PROMPTED_FILE="$STATE_DIR/.telemetry-prompted"

mkdir -p "$STATE_DIR"

source "$SCRIPT_DIR/picker.sh"

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[32m'
RESET='\033[0m'

# ─── Header ───────────────────────────────────────────────────
echo
printf "  ${BOLD}clearshot telemetry${RESET}\n"
printf "  ${DIM}anonymous usage data to help improve the skill.${RESET}\n"
printf "  ${DIM}no screenshots, code, or content is ever sent.${RESET}\n"
echo
printf "  ${DIM}↑/↓ to select, enter to confirm${RESET}\n"
echo

OPTIONS=("anonymous" "off")
pick 1 \
  "Anonymous   usage events + hashed device ID (no PII, ever)" \
  "Off         nothing leaves your machine"

if [ "$PICK_INDEX" -eq -1 ]; then
  printf "\n  ${DIM}cancelled, keeping current setting${RESET}\n\n"
  exit 0
fi

CHOICE="${OPTIONS[$PICK_INDEX]}"

# ─── Write selection ─────────────────────────────────────────
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

_cs_set_config "telemetry" "$CHOICE"
touch "$PROMPTED_FILE"

echo
printf "  ${GREEN}${BOLD}✓${RESET} telemetry set to ${BOLD}${CHOICE}${RESET}\n"

if [ "$CHOICE" = "off" ]; then
  printf "  ${DIM}no data will be sent. you can change this anytime:${RESET}\n"
else
  printf "  ${DIM}you can change this anytime:${RESET}\n"
fi
printf "  ${DIM}re-run anytime: ! ${SCRIPT_DIR}/telemetry-setup.sh${RESET}\n"
echo
