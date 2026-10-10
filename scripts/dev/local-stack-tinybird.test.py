"""Run with the Python interpreter used by the installed tb CLI. No services start."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from tinybird.tb.modules import local_common


ROOT = Path(__file__).resolve().parents[2]


class TinybirdWorkspaceTests(unittest.TestCase):
    def test_live_token_lookup_cannot_redirect_verification_build(self):
        with tempfile.TemporaryDirectory(prefix="trace-flow-tinybird-") as directory:
            base = Path(directory)
            config_path = base / "used-config"
            env = {
                **os.environ,
                "TEST_CONFIG": str(config_path),
            }
            subprocess.run(
                [
                    "bash",
                    "-c",
                    f"""
source '{ROOT}/scripts/dev/_common.sh'
source '{ROOT}/scripts/dev/_tinybird.sh'
STACK_DIR='{base}/stack'
TINYBIRD_WORKSPACE_TOKEN=fixture-live-token
TRACE_FLOW_TINYBIRD_HOST=http://127.0.0.1:17181
tb() {{ cp .tinyb "$TEST_CONFIG"; }}
tinybird_cli build
""",
                ],
                env=env,
                check=True,
                capture_output=True,
            )
            generated = json.loads(config_path.read_text())
            cli_dir = base / "stack/tinybird-verify-cli"
            # cli.py refreshes this context name from the supplied live token.
            # Keep the real .tinyb reader and local workspace selection in the test.
            context = {
                "path": generated["cwd"],
                "name": "Tinybird_Local_Testing",
            }
            workspaces = [
                {
                    "name": "Tinybird_Local_Testing",
                    "id": "live",
                    "token": "fixture-live-token",
                },
                {
                    "name": "Trace_Flow_Local_Verification",
                    "id": "verify",
                    "token": "fixture-verify-token",
                },
            ]
            tokens = {
                "user_token": "fixture-user",
                "admin_token": "fixture-admin",
                "workspace_admin_token": "fixture-live-token",
            }
            response = Mock()
            response.json.return_value = {
                "workspaces": workspaces, "organization_id": "fixture-org"
            }
            user_client = Mock()
            previous = Path.cwd()
            try:
                os.chdir(cli_dir)
                with (
                    patch.object(local_common, "get_local_tokens", return_value=tokens),
                    patch.object(local_common.CLIConfig, "get_client", return_value=user_client),
                    patch.object(local_common.requests, "get", return_value=response),
                ):
                    config, created = local_common.get_tinybird_local_config(context, silent=True)
            finally:
                os.chdir(previous)
            user_client.create_workspace.assert_not_called()
            self.assertFalse(created)
            self.assertEqual(context["local_workspace_name"], "Trace_Flow_Local_Verification")
            self.assertEqual(config.get("token"), "fixture-verify-token")


if __name__ == "__main__":
    unittest.main()
