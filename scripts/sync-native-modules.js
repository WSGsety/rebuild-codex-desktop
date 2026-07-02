#!/usr/bin/env node
/**
 * sync-native-modules.js — Align src/node_modules/ with upstream ASAR layout
 *
 * The upstream ASAR only ships a small set of unbundleable modules in
 * node_modules/ (native addons + their deps). Everything else is Vite-bundled
 * into .vite/build/.
 *
 * This script:
 *   1. Reads the actual module list from upstream _asar/node_modules/
 *   2. For each module, copies from project node_modules/ (rebuilt for target)
 *   3. Skips macOS-only modules (objc-js) on Linux
 *
 * This ensures the ASAR gets Linux-compiled .node binaries instead of
 * macOS Mach-O ones from the upstream extract.
 *
 * Usage:
 *   node scripts/sync-native-modules.js --platform linux-x64
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const SRC = path.join(PROJECT_ROOT, "src");
const ROOT_MODULES = path.join(PROJECT_ROOT, "node_modules");
const SRC_MODULES = path.join(SRC, "node_modules");

const MACOS_ONLY = new Set(["objc-js"]);

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) { /* skip */ }
    else { fs.copyFileSync(s, d); count++; }
  }
  return count;
}

function hasNativeFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (hasNativeFiles(p)) return true; }
    else if (e.name.endsWith(".node")) return true;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;
  const isLinux = platform?.startsWith("linux");

  // Determine upstream _asar/node_modules/ to get the authoritative module list
  const sourceDir = isLinux
    ? path.join(SRC, platform === "linux-arm64" ? "mac-arm64" : "mac-x64")
    : null;

  const upstreamModulesDir = sourceDir
    ? path.join(sourceDir, "_asar", "node_modules")
    : null;

  if (!upstreamModulesDir || !fs.existsSync(upstreamModulesDir)) {
    console.error("[x] Cannot find upstream _asar/node_modules/");
    process.exit(1);
  }

  // Read the exact module list from upstream
  const upstreamModules = fs.readdirSync(upstreamModulesDir)
    .filter((name) => !name.startsWith("."));

  console.log(`-- sync-native-modules: ${platform}`);
  console.log(`   upstream modules: ${upstreamModules.join(", ")}`);

  // Clean and recreate src/node_modules/
  if (fs.existsSync(SRC_MODULES)) fs.rmSync(SRC_MODULES, { recursive: true });
  fs.mkdirSync(SRC_MODULES, { recursive: true });

  let totalCopied = 0;

  for (const mod of upstreamModules) {
    // Skip macOS-only modules on Linux
    if (isLinux && MACOS_ONLY.has(mod)) {
      console.log(`   [skip] ${mod} (macOS only)`);
      continue;
    }

    // Prefer rebuilt version from project node_modules/
    const rootDir = path.join(ROOT_MODULES, mod);
    // Fallback to upstream _asar version (pure JS modules like tslib)
    const upstreamDir = path.join(upstreamModulesDir, mod);

    let sourceLabel;
    let source;

    if (fs.existsSync(rootDir)) {
      source = rootDir;
      sourceLabel = hasNativeFiles(rootDir) ? "rebuilt" : "project";
    } else if (fs.existsSync(upstreamDir)) {
      source = upstreamDir;
      sourceLabel = "upstream";
    } else {
      console.log(`   [!] ${mod} not found in project or upstream`);
      continue;
    }

    const destDir = path.join(SRC_MODULES, mod);
    const count = copyRecursive(source, destDir);
    totalCopied += count;
    console.log(`   [${sourceLabel}] ${mod} (${count} files)`);
  }

  console.log(`   [ok] ${totalCopied} files total in src/node_modules/`);
}

main();
