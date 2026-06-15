#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/dev/_common.sh
source "$ROOT_DIR/scripts/dev/_common.sh"

source_dev_env
export_tinybird_sdk_env

bash "$ROOT_DIR/scripts/verify-tinybird-cost-contract.sh"
TB_VERSION_WARNING=0 tb --local build
TB_VERSION_WARNING=0 tb --local test run
