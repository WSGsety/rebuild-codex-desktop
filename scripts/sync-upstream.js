#!/usr/bin/env node
/**
 * sync-upstream.js — Extract full upstream Codex resources
 *
 * Output structure per platform:
 *   src/{platform}/
 *     _asar/              Extracted app.asar content (patch target)
 *     app.asar.unpacked/  Native modules (kept as-is from upstream)
 *     codex|codex.exe     CLI binary (Windows build replaces it with official @openai/codex)
 *     rg|rg.exe           ripgrep binary (kept from upstream)
 *     plugins/            Bundled plugins
 *     native/             Platform native modules
 *     ...                 All other upstream resources
 *
 * Usage:
 *   node scripts/sync-upstream.js [--force] [--skip-mac] [--skip-win]
 */

const https = require("https");
const tls = require("tls");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// TLS certs for MS delivery CDN
const certsDir = path.join(__dirname, "certs");
const extraCAs = [...tls.rootCertificates];
for (const f of ["ms-root-ca.pem", "ms-update-ca.pem"]) {
  const p = path.join(certsDir, f);
  if (fs.existsSync(p)) extraCAs.push(fs.readFileSync(p, "utf-8"));
}
https.globalAgent.options.ca = extraCAs;

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const TEMP_DIR = path.join(require("os").tmpdir(), "codex-sync");
const VERSION_FILE = path.join(__dirname, ".versions.json");

const APPCAST_ARM64 = "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const APPCAST_X64 = "https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const CHECK_ONLY = args.includes("--check-only");
const SKIP_MAC = args.includes("--skip-mac");
const SKIP_WIN = args.includes("--skip-win");

// ─── Helpers ────────────────────────────────────────────────────

function httpGet(url) {
  const mod = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return httpGet(res.headers.location).then(resolve, reject);
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

function curlDownload(url, dest, label) {
  console.log(`  [dl] ${label}`);
  execSync(`curl -L --retry 3 --retry-delay 2 -o "${dest}" "${url}"`, { stdio: "inherit" });
}

function extractArchive(archive, dest) {
  if (process.platform === "darwin" && archive.endsWith(".zip")) {
    // ditto preserves macOS symlinks + resource forks (required for .app)
    execSync(`ditto -xk "${archive}" "${dest}"`);
  } else {
    // 7zz for Windows MSIX and Linux (symlinks don't matter — only ASAR content used)
    let lastError;
    for (const bin of ["7zz", "7z"]) {
      try {
        clearDir(dest);
        execSync(`${bin} x -y -o"${dest}" "${archive}"`, { stdio: "pipe" });
        return;
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`Failed to extract ${archive}: ${lastError?.message || "unknown error"}`);
  }
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) { const r = findFile(full, name); if (r) return r; }
  }
  return null;
}

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

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
    else n++;
  }
  return n;
}

function decodeMsixPaths(dir) {
  let renamed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const source = path.join(dir, entry.name);
    if (entry.isDirectory()) renamed += decodeMsixPaths(source);
    if (!entry.name.includes("%")) continue;

    const decoded = decodeURIComponent(entry.name);
    if (!decoded || decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) {
      throw new Error(`Unsafe decoded MSIX path segment: ${entry.name}`);
    }
    if (decoded === entry.name) continue;

    const target = path.join(dir, decoded);
    if (fs.existsSync(target)) throw new Error(`MSIX path collision: ${decoded}`);
    fs.renameSync(source, target);
    renamed++;
  }
  return renamed;
}

function validateMsixFiles(extractDir) {
  const { XMLParser } = require("fast-xml-parser");
  const blockMapPath = path.join(extractDir, "AppxBlockMap.xml");
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" })
    .parse(fs.readFileSync(blockMapPath, "utf-8"));
  const files = parsed.BlockMap?.File;
  if (!Array.isArray(files) || files.length === 0) throw new Error("MSIX block map is empty");

  for (const file of files) {
    const relativePath = file.Name.replace(/\\/g, path.sep);
    const absolutePath = path.resolve(extractDir, relativePath);
    if (path.relative(extractDir, absolutePath).startsWith("..")) {
      throw new Error(`Unsafe MSIX file path: ${file.Name}`);
    }
    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).size !== Number(file.Size)) {
      throw new Error(`MSIX file missing or truncated: ${file.Name}`);
    }
  }
}

// ─── Version detection ──────────────────────────────────────────

async function getAppcastVersion(url) {
  const { XMLParser } = require("fast-xml-parser");
  const res = await httpGet(url);
  if (res.status !== 200) throw new Error(`Appcast fetch failed: ${res.status}`);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  const parsed = parser.parse(res.body.toString());
  const items = parsed.rss?.channel?.item;
  const latest = Array.isArray(items) ? items[0] : items;
  let enc = latest.enclosure;
  if (Array.isArray(enc)) enc = enc[0];
  return {
    version: latest.shortVersionString || latest.title,
    build: String(latest.version || ""),
    url: enc?.["@_url"] || "",
  };
}

async function getWindowsVersion() {
  const msstore = require("./fetch-msstore");
  const cookie = await msstore.getCookie();
  const info = await msstore.getAppInfo("9plm9xgg6vks", "US");
  if (!info.categoryId) throw new Error("No CategoryID");
  const pkgs = await msstore.getFileList(cookie, info.categoryId, "Retail");
  if (pkgs.length === 0) throw new Error("No packages");
  const pkg = pkgs.find((p) => /_x64__.*\.msix$/i.test(p.name));
  if (!pkg) throw new Error("Windows: x64 MSIX package not found");
  const url = await msstore.getDownloadUrl(pkg.updateID, pkg.revisionNumber, "Retail", pkg.digest);
  const verMatch = pkg.name.match(/_(\d+\.\d+\.\d+(?:\.\d+)?)_/);
  return { version: verMatch?.[1] || "unknown", url, packageName: pkg.name };
}

// ─── Extract macOS ──────────────────────────────────────────────

async function syncMac(variant, appcastUrl, destDir) {
  const label = `macOS-${variant}`;
  console.log(`\n-- ${label}`);

  const info = await getAppcastVersion(appcastUrl);
  console.log(`   version: ${info.version} (build ${info.build})`);

  const zipPath = path.join(TEMP_DIR, `Codex-${variant}-${info.version}.zip`);
  const extractDir = path.join(TEMP_DIR, `${variant}-extract`);

  if (!fs.existsSync(zipPath)) {
    curlDownload(info.url, zipPath, label);
  } else {
    console.log(`   [cache] ${zipPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(zipPath, extractDir);

  const resourcesDir = findResourcesDir(extractDir);
  if (!resourcesDir) throw new Error(`${label}: Resources directory not found`);

  await assembleOutput(resourcesDir, destDir, label);
  return info;
}

// ─── Extract Windows ────────────────────────────────────────────

async function syncWin(destDir, info) {
  console.log("\n-- Windows");

  console.log(`   version: ${info.version}`);

  const msixPath = path.join(TEMP_DIR, info.packageName || `codex-win-${info.version}.msix`);
  const extractDir = path.join(TEMP_DIR, "win-extract");

  if (!fs.existsSync(msixPath)) {
    curlDownload(info.url, msixPath, "Windows MSIX");
  } else {
    console.log(`   [cache] ${msixPath}`);
  }

  console.log("   [unzip]");
  clearDir(extractDir);
  extractArchive(msixPath, extractDir);
  const renamed = decodeMsixPaths(extractDir);
  validateMsixFiles(extractDir);
  console.log(`   [paths] decoded ${renamed} MSIX path segments`);

  const resourcesDir = path.join(extractDir, "app", "resources");
  if (!fs.existsSync(resourcesDir)) {
    const alt = findFile(extractDir, "app.asar");
    throw new Error(`Windows: resources dir not found${alt ? `, app.asar at ${alt}` : ""}`);
  }

  await assembleOutput(resourcesDir, destDir, "Windows");
  return info;
}

// ─── Assemble output ────────────────────────────────────────────

async function extractAsar(asarPath, destDir) {
  const asar = await import("@electron/asar");
  asar.extractAll(asarPath, destDir);
}

async function assembleOutput(resourcesDir, destDir, label) {
  const asarPath = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: app.asar not found`);

  console.log(`   [assemble] -> ${path.relative(PROJECT_ROOT, destDir)}/`);
  const stagingDir = `${destDir}.staging`;
  clearDir(stagingDir);

  try {
    // 先完整组装到临时目录，避免失败后留下半包。
    const asarDest = path.join(stagingDir, "_asar");
    console.log("   [asar extract] -> _asar/");
    await extractAsar(asarPath, asarDest);

    const packagePath = path.join(asarDest, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    if (!pkg.version) throw new Error(`${label}: extracted package version missing`);

    // 2. Copy app.asar.unpacked/ as-is (native modules)
    const unpackedSrc = path.join(resourcesDir, "app.asar.unpacked");
    if (fs.existsSync(unpackedSrc)) {
      const n = copyRecursive(unpackedSrc, path.join(stagingDir, "app.asar.unpacked"));
      console.log(`   [copy] app.asar.unpacked/ (${n} files)`);
    }

    // 3. Copy all other resources (binaries, plugins, native, etc.)
    let extraCount = 0;
    for (const e of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
      if (e.name === "app.asar" || e.name === "app.asar.unpacked") continue;
      if (e.name.endsWith(".lproj")) continue;
      const s = path.join(resourcesDir, e.name);
      const d = path.join(stagingDir, e.name);
      if (e.isDirectory()) { extraCount += copyRecursive(s, d); }
      else if (!e.isSymbolicLink()) { fs.copyFileSync(s, d); extraCount++; }
    }
    console.log(`   [copy] ${extraCount} extra resource files`);

    const total = countFiles(stagingDir);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, destDir);
    console.log(`   [ok] ${total} files total`);
  } catch (e) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw e;
  }
}

function findResourcesDir(extractDir) {
  const appDir = findFile(extractDir, "app.asar");
  return appDir ? path.dirname(appDir) : null;
}

// ─── Version state ──────────────────────────────────────────────

function loadVersions() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, "utf-8")); } catch { return {}; }
}
function saveVersions(v) {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n");
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("== Codex upstream sync ==\n");
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const results = {};
  const failures = [];

  // Detect versions
  if (!SKIP_MAC) {
    try {
      const arm64Info = await getAppcastVersion(APPCAST_ARM64);
      console.log(`\n   mac-arm64: ${arm64Info.version} (build ${arm64Info.build})`);
      results["mac-arm64"] = arm64Info;
    } catch (e) { failures.push("mac-arm64 check"); console.error(`   [x] mac-arm64 check: ${e.message}`); }

    try {
      const x64Info = await getAppcastVersion(APPCAST_X64);
      console.log(`   mac-x64:   ${x64Info.version} (build ${x64Info.build})`);
      results["mac-x64"] = x64Info;
    } catch (e) { failures.push("mac-x64 check"); console.error(`   [x] mac-x64 check: ${e.message}`); }
  }

  if (!SKIP_WIN) {
    try {
      const winInfo = await getWindowsVersion();
      console.log(`   win:       ${winInfo.version}`);
      results.win = winInfo;
    } catch (e) { failures.push("win check"); console.error(`   [x] win check: ${e.message}`); }
  }

  if (CHECK_ONLY) {
    console.log("\n== Check only, skipping download ==");
    if (failures.length) throw new Error(`Sync failed: ${failures.join(", ")}`);
    return;
  }

  // Download and extract
  if (!SKIP_MAC && results["mac-arm64"]) {
    try {
      results["mac-arm64"] = await syncMac("arm64", APPCAST_ARM64, path.join(SRC_DIR, "mac-arm64"));
    } catch (e) { failures.push("mac-arm64"); console.error(`   [x] mac-arm64: ${e.message}`); }
  }
  if (!SKIP_MAC && results["mac-x64"]) {
    try {
      results["mac-x64"] = await syncMac("x64", APPCAST_X64, path.join(SRC_DIR, "mac-x64"));
    } catch (e) { failures.push("mac-x64"); console.error(`   [x] mac-x64: ${e.message}`); }
  }
  if (!SKIP_WIN && results.win) {
    try {
      results.win = await syncWin(path.join(SRC_DIR, "win"), results.win);
    } catch (e) { failures.push("win"); console.error(`   [x] win: ${e.message}`); }
  }

  if (failures.length) throw new Error(`Sync failed: ${failures.join(", ")}`);

  const saved = loadVersions();
  for (const [key, info] of Object.entries(results)) {
    saved[key] = { version: info.version, build: info.build || "", checkedAt: new Date().toISOString() };
  }
  saveVersions(saved);

  console.log("\n== Done ==");
  for (const [key, info] of Object.entries(results)) {
    console.log(`   ${key}: ${info.version}`);
  }
}

main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
