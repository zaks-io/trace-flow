#!/usr/bin/env python3

import traceback
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from ubuntu_https_sources import discover_source_files, upgrade_source_files, upgrade_source_text


class UbuntuHttpsSourcesTest(unittest.TestCase):
    def test_upgrades_supported_apt_formats_and_preserves_unrelated_sources(self) -> None:
        with TemporaryDirectory() as directory:
            apt_root = Path(directory)
            source_directory = apt_root / "sources.list.d"
            source_directory.mkdir()
            traditional = apt_root / "sources.list"
            deb822 = source_directory / "ubuntu.sources"
            blacksmith = apt_root / "blacksmith-ubuntu-mirrors.txt"
            traditional.write_text(
                "deb http://archive.ubuntu.com/ubuntu noble main restricted "
                "# http://security.ubuntu.com/comment\n"
                "deb-src [signed-by=/usr/share/keyrings/ubuntu.gpg] "
                "http://us.archive.ubuntu.com/ubuntu noble-updates main\n"
                "deb http://mirrors.sonic.net/ubuntu noble universe\n"
                "# deb http://security.ubuntu.com/ubuntu noble-security main\n",
                encoding="utf-8",
            )
            deb822.write_text(
                "Types: deb\n"
                "URIs: mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt "
                "http://archive.ubuntu.com/ubuntu\n"
                "  http://ports.ubuntu.com/ubuntu-ports\n"
                "Suites: noble noble-updates\n"
                "Components: main restricted\n"
                "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n"
                "Types: deb\n"
                "URIs: http://security.ubuntu.com/ubuntu/\n"
                "Suites: noble-security\n"
                "Components: main\n",
                encoding="utf-8",
            )
            deb822.chmod(0o640)
            blacksmith.write_text(
                "http://archive.ubuntu.com/ubuntu/ # http://security.ubuntu.com/comment\n"
                "http://mirrors.sonic.net/ubuntu/\n",
                encoding="utf-8",
            )

            result = upgrade_source_files(discover_source_files(apt_root))

            self.assertEqual(result.files_changed, 3)
            self.assertEqual(result.replacements, 6)
            self.assertEqual(result.official_uris, 6)
            self.assertEqual(
                traditional.read_text(encoding="utf-8"),
                "deb https://archive.ubuntu.com/ubuntu noble main restricted "
                "# http://security.ubuntu.com/comment\n"
                "deb-src [signed-by=/usr/share/keyrings/ubuntu.gpg] "
                "https://us.archive.ubuntu.com/ubuntu noble-updates main\n"
                "deb http://mirrors.sonic.net/ubuntu noble universe\n"
                "# deb http://security.ubuntu.com/ubuntu noble-security main\n",
            )
            self.assertEqual(
                deb822.read_text(encoding="utf-8"),
                "Types: deb\n"
                "URIs: mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt "
                "https://archive.ubuntu.com/ubuntu\n"
                "  https://ports.ubuntu.com/ubuntu-ports\n"
                "Suites: noble noble-updates\n"
                "Components: main restricted\n"
                "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\n"
                "Types: deb\n"
                "URIs: https://security.ubuntu.com/ubuntu/\n"
                "Suites: noble-security\n"
                "Components: main\n",
            )
            self.assertEqual(deb822.stat().st_mode & 0o777, 0o640)
            self.assertEqual(
                blacksmith.read_text(encoding="utf-8"),
                "https://archive.ubuntu.com/ubuntu/ # http://security.ubuntu.com/comment\n"
                "http://mirrors.sonic.net/ubuntu/\n",
            )

            repeated = upgrade_source_files(discover_source_files(apt_root))
            self.assertEqual(repeated.files_changed, 0)
            self.assertEqual(repeated.replacements, 0)
            self.assertEqual(repeated.official_uris, 6)

    def test_refuses_missing_or_unrecognized_ubuntu_configuration(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "configuration is missing"):
            upgrade_source_files([])
        with TemporaryDirectory() as directory:
            source = Path(directory) / "sources.list"
            original = "deb https://packages.microsoft.com/repos/code stable main\n"
            source.write_text(original, encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "no recognized official source"):
                upgrade_source_files([(source, "list")])
            self.assertEqual(source.read_text(encoding="utf-8"), original)

    def test_refuses_a_missing_referenced_blacksmith_mirror_file(self) -> None:
        with TemporaryDirectory() as directory:
            apt_root = Path(directory)
            source_directory = apt_root / "sources.list.d"
            source_directory.mkdir()
            source = source_directory / "ubuntu.sources"
            original = (
                "Types: deb\n"
                "URIs: https://security.ubuntu.com/ubuntu\n"
                "  mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt\n"
                "Suites: noble\n"
            )
            source.write_text(original, encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "Blacksmith Ubuntu mirror"):
                discover_source_files(apt_root)
            self.assertEqual(source.read_text(encoding="utf-8"), original)

    def test_workflows_upgrade_sources_before_installing_packages(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        upgrade = 'sudo "$(command -v python3)" scripts/ci/ubuntu_https_sources.py'
        for name in ("ci.yml", "deploy.yml"):
            workflow = (repo_root / ".github" / "workflows" / name).read_text(encoding="utf-8")
            self.assertIn(upgrade, workflow)
            self.assertLess(workflow.index(upgrade), workflow.index("sudo apt-get update"))

    def test_preserves_complete_lines_without_terminal_newlines(self) -> None:
        upgraded, replacements, official_uris = upgrade_source_text(
            "URIs: http://ports.ubuntu.com/ubuntu-ports", "sources"
        )
        self.assertEqual(upgraded, "URIs: https://ports.ubuntu.com/ubuntu-ports")
        self.assertEqual(replacements, 1)
        self.assertEqual(official_uris, 1)

    def test_uses_the_complete_uri_authority_and_rejects_unsupported_official_authorities(
        self,
    ) -> None:
        text = (
            "deb http://archive.ubuntu.com@other.example/ubuntu noble main "
            "# http://archive.ubuntu.com/comment\n"
        )
        upgraded, replacements, official_uris = upgrade_source_text(text, "list")
        self.assertEqual(upgraded, text)
        self.assertEqual(replacements, 0)
        self.assertEqual(official_uris, 0)

        for uri in (
            "http://archive.ubuntu.com:80/ubuntu",
            "http://archive.ubuntu.com:not-a-port/ubuntu",
        ):
            with self.subTest(uri=uri):
                with self.assertRaisesRegex(RuntimeError, "source authority"):
                    upgrade_source_text(f"deb {uri} noble main\n", "list")

        for secret_uri, message in (
            (
                "http://user:secret@archive.ubuntu.com/ubuntu",
                "unsupported official Ubuntu source authority",
            ),
            (
                "http://user:secret@archive.ubuntu.com：80/ubuntu",
                "invalid APT source authority",
            ),
        ):
            with self.subTest(secret_uri=secret_uri):
                with self.assertRaises(RuntimeError) as caught:
                    upgrade_source_text(f"deb {secret_uri} noble main\n", "list")
                rendered = "".join(
                    traceback.format_exception(
                        type(caught.exception), caught.exception, caught.exception.__traceback__
                    )
                )
                self.assertNotIn("user", rendered)
                self.assertNotIn("secret", rendered)
                self.assertEqual(str(caught.exception), message)


if __name__ == "__main__":
    unittest.main()
