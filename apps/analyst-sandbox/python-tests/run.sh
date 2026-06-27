#!/usr/bin/env bash
# Verifies the generated Trace Flow Python client actually runs, in isolation.
#
# Generates the client from the real TOOL_DEFINITIONS, then runs the unittest
# behavior suite INSIDE the sandbox image (the client's real runtime: pandas +
# pydantic). A mock HTTP server stands in for the Data API, so there is no live
# data, database, or network. One command, fully repeatable.
#
#   bun run test:python        (from apps/analyst-sandbox)
#
# Locally this builds the sandbox image. In CI, set ANALYST_SANDBOX_IMAGE to an
# already-built (layer-cached) image tag to skip the local build.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS_DIR="$PKG_DIR/python-tests"
IMAGE_TAG="${ANALYST_SANDBOX_IMAGE:-trace-flow-analyst-sandbox:python-tests}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [[ -n "${ANALYST_SANDBOX_IMAGE:-}" ]]; then
  echo "==> Using prebuilt sandbox image: $IMAGE_TAG"
else
  echo "==> Building sandbox image (current Dockerfile, with pandas + pydantic)"
  docker build --platform linux/amd64 -t "$IMAGE_TAG" -f "$PKG_DIR/Dockerfile" "$PKG_DIR" >/dev/null
fi

echo "==> Generating client from real TOOL_DEFINITIONS"
( cd "$PKG_DIR" && bun python-tests/generate-client.mts "$WORK_DIR/traceflow_client.py" )

echo "==> Validating Python syntax"
python3 -c "import ast,sys; ast.parse(open('$WORK_DIR/traceflow_client.py').read()); print('   syntax OK')"

echo "==> Running behavior suite inside the sandbox image"
docker run --rm --platform linux/amd64 \
  -e TRACEFLOW_CLIENT_DIR=/work \
  -v "$WORK_DIR:/work:ro" \
  -v "$TESTS_DIR/test_client.py:/test_client.py:ro" \
  --entrypoint python3 \
  "$IMAGE_TAG" /test_client.py

echo "==> Python client verified"
