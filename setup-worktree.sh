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
echo "Installing dependencies with pnpm..."
pnpm install

if [ -f "$MAIN_WORKTREE/.env.local" ]; then
  echo "Copying .env.local from main worktree..."
  cp "$MAIN_WORKTREE/.env.local" .env.local
  echo "✓ .env.local file copied"
else
  echo "⚠ Warning: $MAIN_WORKTREE/.env.local not found, skipping .env.local copy"
fi

if [ -f "$MAIN_WORKTREE/workers/proxy-consumer/.dev.vars" ]; then
  echo "Copying workers/proxy-consumer/.dev.vars from main worktree..."
  cp "$MAIN_WORKTREE/workers/proxy-consumer/.dev.vars" workers/proxy-consumer/.dev.vars
  echo "✓ workers/proxy-consumer/.dev.vars file copied"
else
  echo "⚠ Warning: $MAIN_WORKTREE/workers/proxy-consumer/.dev.vars not found, skipping copy"
fi


if [ -f "$MAIN_WORKTREE/workers/web/.env.local" ]; then
  echo "Copying workers/web/.env.local from main worktree..."
  cp "$MAIN_WORKTREE/workers/web/.env.local" workers/web/.env.local
  echo "✓ workers/web/.env.local file copied"
else
  echo "⚠ Warning: $MAIN_WORKTREE/workers/web/.env.local not found, skipping copy"
fi

echo "✓ Worktree setup complete!"
