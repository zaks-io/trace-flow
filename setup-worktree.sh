#!/bin/bash

set -e

# Verify we're in a git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: Must be run inside a git repository"
  exit 1
fi

# Verify we're in a worktree (not the main repo)
# In a worktree, .git is a file pointing to the actual git dir, not a directory
if [ ! -f ".git" ]; then
  echo "Error: This script should only be run in a git worktree"
  exit 1
fi

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
  if [ -f "$MAIN_WORKTREE/$rel" ]; then
    echo "Copying $rel from main worktree..."
    mkdir -p "$(dirname "$rel")"
    cp "$MAIN_WORKTREE/$rel" "$rel"
    echo "✓ $rel copied"
  else
    echo "⚠ Warning: $MAIN_WORKTREE/$rel not found, skipping copy"
  fi
}

copy_from_main ".env.local"
copy_from_main "apps/proxy-consumer/.dev.vars"
copy_from_main "apps/web/.env.local"
copy_from_main "apps/agent-ingest/.dev.vars"
copy_from_main "apps/agent-consumer/.dev.vars"
copy_from_main "packages/sdk-tests/.env"

echo "✓ Worktree setup complete!"
