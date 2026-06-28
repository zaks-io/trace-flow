#!/bin/bash

set -e

# Verify we're in a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: Must be run inside a git repository"
  exit 1
fi

REPO_ROOT=$(git rev-parse --path-format=absolute --show-toplevel)
cd "$REPO_ROOT"

# Get the main worktree location (git-common-dir returns /path/to/main/.git)
MAIN_WORKTREE=$(git rev-parse --path-format=absolute --git-common-dir | sed 's|/.git$||')

echo "Setting up worktree..."
echo "Main worktree: $MAIN_WORKTREE"

# Install dependencies
echo "Installing dependencies with bun..."
bun install

# Copy a gitignored local-secret/env file from the main worktree into this one. These hold dev
# secrets that are never committed, so a fresh worktree starts without them.
copy_from_main() {
  local rel="$1"
  local src="$MAIN_WORKTREE/$rel"
  local dest="$REPO_ROOT/$rel"

  if [ "$src" = "$dest" ]; then
    echo "Already in main worktree, skipping $rel"
  elif [ -f "$src" ]; then
    echo "Copying $rel from main worktree..."
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "✓ $rel copied"
  else
    echo "⚠ Warning: $src not found, skipping copy"
  fi
}

copy_from_main ".env.local"
copy_from_main "apps/proxy-consumer/.dev.vars"
copy_from_main "apps/web/.env.local"
copy_from_main "apps/agent-ingest/.dev.vars"
copy_from_main "apps/agent-consumer/.dev.vars"
copy_from_main "packages/sdk-tests/.env"

echo "✓ Worktree setup complete!"
