#!/usr/bin/env bash
# clearshot installer — curl -fsSL https://raw.githubusercontent.com/udayanwalvekar/clearshot/main/install.sh | bash
set -e

if ! command -v git &>/dev/null; then
  echo "error: git is required. install it first." >&2
  exit 1
fi

SKILL_DIR="$HOME/.claude/skills/clearshot"

# Handle broken symlinks
if [ -L "$SKILL_DIR" ] && [ ! -e "$SKILL_DIR" ]; then
  rm "$SKILL_DIR"
fi

if [ -L "$SKILL_DIR" ]; then
  # Symlink to a local clone — pull in the target
  TARGET="$(readlink "$SKILL_DIR")"
  if [ -d "$TARGET/.git" ]; then
    echo "updating clearshot..."
    cd "$TARGET" && git pull origin main --quiet 2>/dev/null || echo "  (offline — using cached version)"
    cd "$TARGET" && bash ./setup
  else
    echo "reinstalling clearshot..."
    rm "$SKILL_DIR"
    git clone --quiet https://github.com/udayanwalvekar/clearshot.git "$SKILL_DIR"
    cd "$SKILL_DIR" && bash ./setup
  fi
elif [ -d "$SKILL_DIR/.git" ]; then
  echo "updating clearshot..."
  cd "$SKILL_DIR" && git pull origin main --quiet 2>/dev/null || echo "  (offline — using cached version)"
  cd "$SKILL_DIR" && bash ./setup
else
  # Clean install
  [ -d "$SKILL_DIR" ] && rm -rf "$SKILL_DIR"
  echo "installing clearshot..."
  mkdir -p "$HOME/.claude/skills"
  git clone --quiet https://github.com/udayanwalvekar/clearshot.git "$SKILL_DIR" || {
    echo "error: could not clone clearshot. check your network connection." >&2
    exit 1
  }
  cd "$SKILL_DIR" && bash ./setup
fi
