// Compile the iudex Go CLI into src-tauri/binaries/iudex-cli-<triple>, the
// sidecar slot Tauri's externalBin bundles next to the app executable. Runs as
// part of beforeDevCommand/beforeBuildCommand so dev and release builds always
// carry a CLI pinned to the GUI's version (tauri.conf.json is the single
// version source; it is stamped into `iudex --version` via ldflags).
//
// The sidecar is named `iudex-cli` (not `iudex`) because the GUI executable
// itself is named `iudex` — both land in the same directory inside the bundle.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(guiDir, "..");

const conf = JSON.parse(
  readFileSync(join(guiDir, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = conf.version;

// Tauri exports the triple it is building for to its hook commands; outside a
// hook (manual `pnpm build:cli`) fall back to the host triple.
const triple =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    .split(":")[1]
    .trim();

const GO_TARGETS = {
  "aarch64-apple-darwin": { GOOS: "darwin", GOARCH: "arm64" },
  "x86_64-apple-darwin": { GOOS: "darwin", GOARCH: "amd64" },
  "x86_64-unknown-linux-gnu": { GOOS: "linux", GOARCH: "amd64" },
  "aarch64-unknown-linux-gnu": { GOOS: "linux", GOARCH: "arm64" },
};
const target = GO_TARGETS[triple];
if (!target) {
  console.error(`build-cli: no GOOS/GOARCH mapping for target triple ${triple}`);
  process.exit(1);
}

const outDir = join(guiDir, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `iudex-cli-${triple}`);

execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X iudex/internal/cmd.version=v${version}`,
    "-o",
    out,
    ".",
  ],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...target } },
);
console.log(`build-cli: v${version} → ${out}`);
