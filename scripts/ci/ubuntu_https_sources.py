#!/usr/bin/env python3
"""Upgrade official Ubuntu APT source URLs to HTTPS without changing mirrors."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal
from urllib.parse import urlsplit

SourceKind = Literal["list", "sources", "mirror"]

URL_PATTERN = re.compile(r"\bhttps?://[^\s#]+", re.IGNORECASE)
BLACKSMITH_MIRRORS = "blacksmith-ubuntu-mirrors.txt"


@dataclass(frozen=True)
class UpgradeResult:
    files_changed: int
    replacements: int
    official_uris: int


def is_official_ubuntu_host(host: str) -> bool:
    normalized = host.lower()
    return normalized in {
        "archive.ubuntu.com",
        "security.ubuntu.com",
        "ports.ubuntu.com",
    } or normalized.endswith(".archive.ubuntu.com")


def classify_source_lines(text: str, kind: SourceKind) -> list[tuple[str, bool]]:
    classified: list[tuple[str, bool]] = []
    in_uris_field = False
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if kind == "list":
            eligible = re.match(r"deb(?:-src)?\s", stripped) is not None
        elif kind == "sources":
            if not line.strip():
                in_uris_field = False
                eligible = False
            elif line[:1].isspace():
                eligible = in_uris_field
            elif re.match(r"[A-Za-z][A-Za-z0-9-]*:", line):
                in_uris_field = line.lower().startswith("uris:")
                eligible = in_uris_field
            else:
                eligible = False
        else:
            eligible = bool(stripped) and not stripped.startswith("#")
        classified.append((line, eligible))
    return classified


def upgrade_source_text(text: str, kind: SourceKind) -> tuple[str, int, int]:
    replacements = 0
    official_uris = 0

    def upgrade_url(match: re.Match[str]) -> str:
        nonlocal replacements, official_uris
        uri = match.group(0)
        try:
            parsed = urlsplit(uri)
            hostname = parsed.hostname
            port = parsed.port
        except ValueError:
            raise RuntimeError("invalid APT source authority") from None
        if not hostname or not is_official_ubuntu_host(hostname):
            return uri
        if parsed.username is not None or parsed.password is not None or port is not None:
            raise RuntimeError("unsupported official Ubuntu source authority")
        official_uris += 1
        if parsed.scheme.lower() == "http":
            replacements += 1
            return "https://" + uri[7:]
        return uri

    def upgrade_active_line(line: str) -> str:
        active, marker, comment = line.partition("#")
        return URL_PATTERN.sub(upgrade_url, active) + marker + comment

    upgraded_lines: list[str] = []
    for line, eligible in classify_source_lines(text, kind):
        upgraded_lines.append(upgrade_active_line(line) if eligible else line)
    return "".join(upgraded_lines), replacements, official_uris


def discover_source_files(apt_root: Path) -> list[tuple[Path, SourceKind]]:
    files: list[tuple[Path, SourceKind]] = []
    traditional = apt_root / "sources.list"
    if traditional.is_file():
        files.append((traditional, "list"))
    source_directory = apt_root / "sources.list.d"
    if source_directory.is_dir():
        files.extend((path, "list") for path in sorted(source_directory.glob("*.list")))
        files.extend((path, "sources") for path in sorted(source_directory.glob("*.sources")))
    blacksmith = apt_root / BLACKSMITH_MIRRORS
    if blacksmith.is_file():
        files.append((blacksmith, "mirror"))
    elif any(
        "mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt" in line.partition("#")[0]
        for path, kind in files
        if kind == "sources"
        for line, eligible in classify_source_lines(path.read_text(encoding="utf-8"), kind)
        if eligible
    ):
        raise RuntimeError("referenced Blacksmith Ubuntu mirror configuration is missing")
    return files


def upgrade_source_files(files: Iterable[tuple[Path, SourceKind]]) -> UpgradeResult:
    prepared: list[tuple[Path, SourceKind, str, str]] = []
    replacements = 0
    official_uris = 0
    for path, kind in files:
        original = path.read_bytes().decode("utf-8")
        upgraded, file_replacements, file_official_uris = upgrade_source_text(original, kind)
        prepared.append((path, kind, original, upgraded))
        replacements += file_replacements
        official_uris += file_official_uris
    if not prepared:
        raise RuntimeError("Ubuntu APT source configuration is missing")
    if official_uris == 0:
        raise RuntimeError("Ubuntu APT source configuration has no recognized official source")

    files_changed = 0
    for path, kind, original, upgraded in prepared:
        if upgraded == original:
            continue
        path.write_bytes(upgraded.encode("utf-8"))
        if path.read_bytes().decode("utf-8") != upgraded:
            raise RuntimeError(f"Ubuntu APT source update did not persist: {path}")
        _, remaining_replacements, _ = upgrade_source_text(upgraded, kind)
        if remaining_replacements:
            raise RuntimeError(f"Ubuntu APT source update was incomplete: {path}")
        files_changed += 1
    return UpgradeResult(files_changed, replacements, official_uris)


def main() -> int:
    if len(sys.argv) != 1:
        raise RuntimeError("ubuntu_https_sources.py accepts no arguments")
    result = upgrade_source_files(discover_source_files(Path("/etc/apt")))
    print(
        f"Ubuntu APT HTTPS sources verified: {result.official_uris} official URIs, "
        f"{result.replacements} upgraded across {result.files_changed} files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
