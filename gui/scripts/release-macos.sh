#!/usr/bin/env bash
# Build a local macOS release bundle of the iudex GUI, with the CLI sidecar
# baked in (beforeBuildCommand runs scripts/build-cli.mjs). Produces an
# UNSIGNED .app/.dmg — fine for your own machine and testers who run
# `xattr -cr` after download; real releases should be signed + notarized
# (export APPLE_CERTIFICATE / APPLE_SIGNING_IDENTITY etc. and Tauri picks
# them up — see https://tauri.app/distribute/sign/macos/).
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
# The DMG step styles the window via Finder/AppleScript; headless contexts
# (CI, sandboxed shells) can't do that — CI=true makes it skip the styling.
pnpm tauri build

bundle=src-tauri/target/release/bundle
echo
echo "artifacts:"
ls -1 "$bundle"/macos/*.app "$bundle"/dmg/*.dmg 2>/dev/null || true
echo
echo "note: unsigned build — downloaders must run:  xattr -cr /Applications/iudex.app"
