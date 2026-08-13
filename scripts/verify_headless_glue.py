#!/usr/bin/env python3
"""Fork-only guard: headless WebUI glue that upstream merges keep clobbering.

This is intentionally separate from scripts/verify_headless.py (dispatch
coverage vs command manifest). That script checks Rust command arms; this one
checks the browser-side glue that makes the same WebUI work against the
headless server:

  - multipart file upload (POST /api/files/import)
  - browser <input type=file> pick fallback
  - HeadlessFolderPicker wired through system_pick_folder
  - tauriBridge /api/invoke + /ws transport
  - shims re-exporting the bridge (no direct @tauri-apps in app entry paths)
  - backend multipart route still registered

Upstream LiveAgent has no headless runtime. Keep this script and its CI step
on the fork only — do not open an upstream PR for it.

Usage:
    python3 scripts/verify_headless_glue.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

errors: list[str] = []
warnings: list[str] = []


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO))
    except ValueError:
        return str(path)


def must_exist(path: Path) -> Path | None:
    if not path.is_file():
        errors.append(f"MISSING file: {rel(path)}")
        return None
    return path


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def require_contains(path: Path, needles: list[str], label: str) -> None:
    target = must_exist(path)
    if target is None:
        return
    text = read(target)
    missing = [n for n in needles if n not in text]
    if missing:
        errors.append(
            f"{label}: {rel(path)} missing required marker(s): {missing}"
        )


def require_regex(path: Path, pattern: str, label: str) -> None:
    target = must_exist(path)
    if target is None:
        return
    if re.search(pattern, read(target), re.M) is None:
        errors.append(f"{label}: {rel(path)} does not match /{pattern}/")


def forbid_regex(path: Path, pattern: str, label: str) -> None:
    target = must_exist(path)
    if target is None:
        return
    if re.search(pattern, read(target), re.M) is not None:
        errors.append(f"{label}: {rel(path)} matches forbidden /{pattern}/")


# ---------------------------------------------------------------------------
# 1) Core headless glue files must exist
# ---------------------------------------------------------------------------
GLUE_FILES = [
    REPO / "crates/agent-gui/src/lib/tauriBridge.ts",
    REPO / "crates/agent-gui/src/lib/uploadReadableFiles.ts",
    REPO / "crates/agent-gui/src/pages/chat/workspace/HeadlessFolderPicker.tsx",
    REPO / "crates/agent-gui/src/pages/chat/hooks/usePendingUploads.ts",
    REPO / "crates/agent-gui/src/shims/tauriCore.ts",
    REPO / "crates/agent-gui/src/shims/tauriEvent.ts",
    REPO / "crates/agent-gui/src/shims/tauriOpener.ts",
    REPO / "crates/agent-gui/src-tauri/src/headless.rs",
]

for path in GLUE_FILES:
    must_exist(path)

# ---------------------------------------------------------------------------
# 2) Upload glue: multipart helper + pending-uploads headless branch
# ---------------------------------------------------------------------------
require_contains(
    REPO / "crates/agent-gui/src/lib/uploadReadableFiles.ts",
    [
        "importReadableFilesViaMultipart",
        "/api/files/import",
        "FormData",
        "resolveHeadlessBaseUrl",
        "PendingUploadedFile",
    ],
    "upload helper",
)

# Prefer the shared ui package path after upstream extraction; accept either
# while the fork is mid-migration, but require a real PendingUploadedFile type.
upload_helper = REPO / "crates/agent-gui/src/lib/uploadReadableFiles.ts"
if upload_helper.is_file():
    text = read(upload_helper)
    if (
        "@liveagent/ui/lib/chat/uploadedFiles" not in text
        and "chat/messages/uploadedFiles" not in text
        and 'chat/uploadedFiles' not in text
    ):
        errors.append(
            "upload helper: PendingUploadedFile import path looks broken "
            f"({rel(upload_helper)})"
        )

require_contains(
    REPO / "crates/agent-gui/src/pages/chat/hooks/usePendingUploads.ts",
    [
        "importReadableFilesViaMultipart",
        "pickBrowserFiles",
        "isTauri",
        'from "../../../lib/uploadReadableFiles"',
        'from "../../../lib/tauriBridge"',
    ],
    "pending uploads imports",
)

require_regex(
    REPO / "crates/agent-gui/src/pages/chat/hooks/usePendingUploads.ts",
    r"function pickBrowserFiles\s*\(",
    "pending uploads browser picker",
)

require_regex(
    REPO / "crates/agent-gui/src/pages/chat/hooks/usePendingUploads.ts",
    r"if\s*\(\s*!isTauri\(\s*\)\s*\)[\s\S]{0,400}importReadableFilesViaMultipart",
    "pending uploads headless pick/multipart branch",
)

# Desktop path must still exist so Tauri builds are unchanged.
require_contains(
    REPO / "crates/agent-gui/src/pages/chat/hooks/usePendingUploads.ts",
    [
        "system_pick_readable_files",
        "system_import_uploaded_readable_files",
    ],
    "pending uploads desktop invoke path",
)

# ---------------------------------------------------------------------------
# 3) Folder picker glue: bridge intercept + component export
# ---------------------------------------------------------------------------
require_contains(
    REPO / "crates/agent-gui/src/lib/tauriBridge.ts",
    [
        "system_pick_folder",
        "openFolderPicker",
        "HeadlessFolderPicker",
        "/api/invoke",
        "resolveHeadlessBaseUrl",
        "isTauri",
    ],
    "tauriBridge folder-picker intercept",
)

require_regex(
    REPO / "crates/agent-gui/src/lib/tauriBridge.ts",
    r'cmd\s*===\s*"system_pick_folder"',
    "tauriBridge system_pick_folder branch",
)

require_contains(
    REPO / "crates/agent-gui/src/pages/chat/workspace/HeadlessFolderPicker.tsx",
    [
        "export function openFolderPicker",
        "fs_list_dirs",
        "fs_roots",
    ],
    "HeadlessFolderPicker",
)

# After upstream @liveagent/ui extraction, icons/i18n should come from the
# shared package (relative ../../../components/icons is the historical break).
picker = REPO / "crates/agent-gui/src/pages/chat/workspace/HeadlessFolderPicker.tsx"
if picker.is_file():
    text = read(picker)
    if 'from "../../../components/icons"' in text:
        errors.append(
            "HeadlessFolderPicker: stale relative icons import "
            '(use @liveagent/ui/components/IconSet)'
        )
    if 'from "../../../i18n/config"' in text:
        errors.append(
            "HeadlessFolderPicker: stale relative i18n import "
            "(use @liveagent/ui/i18n/index)"
        )

# ---------------------------------------------------------------------------
# 4) Shims must re-export the bridge (browser bundle must not hard-depend on
#    a separate tauri implementation path for invoke/listen/openUrl).
# ---------------------------------------------------------------------------
require_contains(
    REPO / "crates/agent-gui/src/shims/tauriCore.ts",
    ['from "../lib/tauriBridge"', "invoke"],
    "shim tauriCore",
)
require_contains(
    REPO / "crates/agent-gui/src/shims/tauriEvent.ts",
    ['from "../lib/tauriBridge"', "listen"],
    "shim tauriEvent",
)
require_contains(
    REPO / "crates/agent-gui/src/shims/tauriOpener.ts",
    ['from "../lib/tauriBridge"'],
    "shim tauriOpener",
)

# ---------------------------------------------------------------------------
# 5) Backend headless server still exposes multipart import + invoke + ws
# ---------------------------------------------------------------------------
require_contains(
    REPO / "crates/agent-gui/src-tauri/src/headless.rs",
    [
        '/api/files/import',
        "/api/invoke",
        "import_files_handler",
        "Multipart",
    ],
    "headless.rs multipart route",
)

# ---------------------------------------------------------------------------
# 6) No leftover conflict markers in glue files
# ---------------------------------------------------------------------------
for path in GLUE_FILES:
    if path.is_file() and re.search(r"^<<<<<<<|^>>>>>>>|^=======", read(path), re.M):
        errors.append(f"conflict markers left in {rel(path)}")

# ---------------------------------------------------------------------------
# 7) Soft checks / warnings (do not fail CI yet, but print)
# ---------------------------------------------------------------------------
# Direct static @tauri-apps imports outside tauriBridge are risky for the
# browser bundle. Dynamic import inside tauriBridge is expected.
src_root = REPO / "crates/agent-gui/src"
risky_files: list[str] = []
if src_root.is_dir():
    for path in src_root.rglob("*"):
        if path.suffix not in {".ts", ".tsx", ".js", ".jsx"}:
            continue
        if path.name == "tauriBridge.ts":
            continue
        # type-only and comments are hard to filter perfectly; flag static imports.
        text = read(path)
        if re.search(r"""from\s+["']@tauri-apps/""", text):
            # allow `import type` only
            if re.search(r"""^import\s+(?!type)[^;]*from\s+["']@tauri-apps/""", text, re.M):
                risky_files.append(rel(path))

if risky_files:
    warnings.append(
        "static non-type @tauri-apps imports outside tauriBridge "
        f"({len(risky_files)}): " + ", ".join(risky_files[:12])
        + (" ..." if len(risky_files) > 12 else "")
    )

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
print("verify_headless_glue (fork-only)")
print(f"repo: {REPO}")
print(f"glue files checked: {len(GLUE_FILES)}")

if warnings:
    print(f"\nWARNINGS ({len(warnings)}):")
    for w in warnings:
        print(f"  - {w}")

if errors:
    print(f"\nFAILED ({len(errors)}):")
    for e in errors:
        print(f"  - {e}")
    print(
        "\nHeadless glue drifted — usually after merging upstream/main.\n"
        "Restore upload/picker/bridge wiring before deploying headless.\n"
        "See commit history: fix(webui): restore headless ..."
    )
    sys.exit(1)

print("OK: headless WebUI glue markers present.")
sys.exit(0)
