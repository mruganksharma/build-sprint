#!/usr/bin/env bash
# Reusable arrow-key picker for clearshot scripts
# Source this file, then call: pick <default_index> "Label 1" "Label 2" ...
# After pick returns, PICK_INDEX holds the selected index (0-based)

_PICK_BOLD='\033[1m'
_PICK_DIM='\033[2m'
_PICK_RESET='\033[0m'
_PICK_CYAN='\033[36m'
_PICK_BG='\033[48;5;236m'

pick() {
  local selected="$1"
  shift
  local labels=("$@")
  local count=${#labels[@]}

  tput civis 2>/dev/null  # hide cursor

  _pick_draw() {
    if [ "$1" = "redraw" ]; then
      tput cuu "$count" 2>/dev/null
    fi
    for i in "${!labels[@]}"; do
      tput el 2>/dev/null
      if [ "$i" -eq "$selected" ]; then
        printf "  ${_PICK_BG}${_PICK_CYAN}${_PICK_BOLD} › ${labels[$i]} ${_PICK_RESET}\n"
      else
        printf "  ${_PICK_DIM}   ${labels[$i]}${_PICK_RESET}\n"
      fi
    done
  }

  _pick_draw "first"

  while true; do
    IFS= read -rsn1 key
    case "$key" in
      $'\x1b')
        read -rsn1 -t 0.1 _bracket
        read -rsn1 -t 0.1 _arrow
        case "$_arrow" in
          A) [ "$selected" -gt 0 ] && selected=$((selected - 1)) && _pick_draw "redraw" ;;
          B) [ "$selected" -lt $((count - 1)) ] && selected=$((selected + 1)) && _pick_draw "redraw" ;;
        esac
        ;;
      "") break ;;
      k) [ "$selected" -gt 0 ] && selected=$((selected - 1)) && _pick_draw "redraw" ;;
      j) [ "$selected" -lt $((count - 1)) ] && selected=$((selected + 1)) && _pick_draw "redraw" ;;
      q) tput cnorm 2>/dev/null; PICK_INDEX=-1; return ;;
    esac
  done

  tput cnorm 2>/dev/null  # restore cursor
  PICK_INDEX=$selected
}
