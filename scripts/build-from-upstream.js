#!/usr/bin/env node
/**
 * build-from-upstream.js — Patch upstream Codex and repackage
 *
 * For macOS and Windows: no forge needed.
 * Takes the upstream app, patches ASAR in-place, replaces codex CLI, outputs distributable.
 *
 * Usage:
 *   node scripts/build-from-upstream.js --platform mac-arm64
 *   node scripts/build-from-upstream.js --platform mac-x64
 *   node scripts/build-from-upstream.js --platform win
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFileSync, execSync } = require("child_process");
const { XMLParser } = require("fast-xml-parser");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const OUT_DIR = path.join(PROJECT_ROOT, "out");

const TARGET_TRIPLE_MAP = {
  "mac-arm64": "aarch64-apple-darwin",
  "mac-x64": "x86_64-apple-darwin",
  "win": "x86_64-pc-windows-msvc",
};

const WINDOWS_CODEX_FILES = [
  { source: ["bin", "codex.exe"], destination: "codex.exe" },
  { source: ["bin", "codex-code-mode-host.exe"], destination: "codex-code-mode-host.exe" },
  { source: ["codex-resources", "codex-command-runner.exe"], destination: "codex-command-runner.exe" },
  { source: ["codex-resources", "codex-windows-sandbox-setup.exe"], destination: "codex-windows-sandbox-setup.exe" },
];

// ─── Helpers ────────────────────────────────────────────────────

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch {}
      count++;
    } else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function parseWindowsApplicationExecutable(manifest) {
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
  }).parse(manifest);
  const applications = parsed.Package?.Applications?.Application;
  const candidates = (Array.isArray(applications) ? applications : [applications])
    .filter((application) => application && typeof application.Executable === "string")
    .filter((application) => /\.exe$/i.test(application.Executable));
  const fullTrust = candidates.filter((application) => application.EntryPoint === "Windows.FullTrustApplication");
  const matches = fullTrust.length > 0 ? fullTrust : candidates;

  if (matches.length !== 1) {
    throw new Error(`Expected one Windows application executable, found ${matches.length}`);
  }
  return matches[0].Executable;
}

function getWindowsEntryRelativePath(extractDir, appDir) {
  const manifestPath = path.join(extractDir, "AppxManifest.xml");
  const manifest = fs.readFileSync(manifestPath, "utf-8");
  const executable = parseWindowsApplicationExecutable(manifest);

  const executablePath = path.resolve(extractDir, ...executable.split(/[\\/]/));
  const relativePath = path.relative(appDir, executablePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Windows application executable is outside app/: ${executable}`);
  }
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Windows application executable is missing: ${executable}`);
  }
  return relativePath;
}

function writeWindowsLauncher(outApp, entryRelativePath) {
  const windowsPath = entryRelativePath.split(path.sep).join("\\");
  const launcher = `@echo off\r\nstart "" "%~dp0${windowsPath}" "codex://launch"\r\n`;
  fs.writeFileSync(path.join(outApp, "启动 Codex.cmd"), launcher);
  console.log(`   [entry] 启动 Codex.cmd -> ${entryRelativePath}`);
}

function execNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function resolveWindowsCodexVersion() {
  const configured = process.env.CODEX_CLI_VERSION?.trim();
  const version = configured || execNpm(["view", "@openai/codex", "version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Codex CLI version: ${version || "empty"}`);
  }
  return version;
}

function assertWindowsX64Executable(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`Not a Windows executable: ${filePath}`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`Invalid PE header: ${filePath}`);
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(`Expected Windows x64 executable, found PE machine 0x${machine.toString(16)}: ${filePath}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function resolveWindowsCodexBundle() {
  const version = resolveWindowsCodexVersion();
  const packageSpec = `@openai/codex@${version}-win32-x64`;
  const tempDir = path.join(os.tmpdir(), "openai-codex-pack", `${version}-win32-x64`);
  clearDir(tempDir);

  console.log(`   [codex] fetching ${packageSpec}`);
  const packed = JSON.parse(execNpm(["pack", packageSpec, "--pack-destination", tempDir, "--json"], {
    cwd: tempDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const packageInfo = packed[0];
  if (!packageInfo?.filename || !packageInfo.integrity) {
    throw new Error(`npm pack returned incomplete metadata for ${packageSpec}`);
  }

  const extractDir = path.join(tempDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["xzf", path.join(tempDir, packageInfo.filename), "-C", extractDir], { stdio: "pipe" });

  const vendorDir = path.join(extractDir, "package", "vendor", TARGET_TRIPLE_MAP.win);
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(vendorDir, "codex-package.json"), "utf-8"));
  const expectedMetadata = {
    layoutVersion: 1,
    version,
    target: TARGET_TRIPLE_MAP.win,
    variant: "codex",
    entrypoint: "bin/codex.exe",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  };
  for (const [key, expected] of Object.entries(expectedMetadata)) {
    if (packageMetadata[key] !== expected) {
      throw new Error(`Unexpected Codex package metadata ${key}: ${packageMetadata[key]}`);
    }
  }
  const files = WINDOWS_CODEX_FILES.map(({ source, destination }) => {
    const sourcePath = path.join(vendorDir, ...source);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Official Codex package is missing ${source.join("/")}`);
    }
    assertWindowsX64Executable(sourcePath);
    return { sourcePath, destination };
  });

  return { version, integrity: packageInfo.integrity, files };
}

function replaceWindowsCodexBundle(resourcesDir) {
  const existingCodex = path.join(resourcesDir, "codex.exe");
  if (!fs.existsSync(existingCodex)) {
    throw new Error(`Upstream Codex executable is missing: ${existingCodex}`);
  }

  const bundle = resolveWindowsCodexBundle();
  const hashes = {};
  for (const { sourcePath, destination } of bundle.files) {
    const destinationPath = path.join(resourcesDir, destination);
    fs.copyFileSync(sourcePath, destinationPath);
    assertWindowsX64Executable(destinationPath);
    const sourceHash = sha256File(sourcePath);
    const destinationHash = sha256File(destinationPath);
    if (sourceHash !== destinationHash) {
      throw new Error(`Codex bundle copy verification failed: ${destination}`);
    }
    hashes[destination] = destinationHash;
  }

  if (process.platform === "win32") {
    const versionOutput = execFileSync(existingCodex, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    }).trim();
    if (!versionOutput.includes(bundle.version)) {
      throw new Error(`Codex CLI version mismatch: ${versionOutput}`);
    }
    execFileSync(existingCodex, ["app-server", "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
  }

  console.log(`   [codex] replaced with @openai/codex ${bundle.version} (${bundle.files.length} executables)`);
  return { version: bundle.version, integrity: bundle.integrity, hashes };
}

function getWindowsPackageVersion() {
  const configured = process.env.CODEX_WINDOWS_PACKAGE_VERSION?.trim();
  const versions = configured
    ? { win: { version: configured } }
    : JSON.parse(fs.readFileSync(path.join(__dirname, ".versions.json"), "utf-8"));
  const version = versions.win?.version;
  if (!/^\d+(?:\.\d+){2,3}$/.test(version || "")) {
    throw new Error(`Invalid Windows MSIX package version: ${version || "empty"}`);
  }
  return version;
}

function createWindowsZipName(appVersion, codexCliVersion) {
  return `Codex-win-x64-${appVersion}-cli-${codexCliVersion}.zip`;
}

function resolveCodexVendor(platform) {
  const triple = TARGET_TRIPLE_MAP[platform];
  if (!triple) return null;
  const binName = platform === "win" ? "codex.exe" : "codex";

  // Try platform-specific package (0.128+)
  const PKG_MAP = { "mac-arm64": "codex-darwin-arm64", "mac-x64": "codex-darwin-x64", "win": "codex-win32-x64" };
  const platPkg = PKG_MAP[platform];
  if (platPkg) {
    const p = path.join(PROJECT_ROOT, "node_modules", "@cometix", platPkg, "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  }
  // Try old-style vendor (pre-0.128)
  const localPath = path.join(PROJECT_ROOT, "node_modules", "@cometix", "codex", "vendor", triple, "codex", binName);
  if (fs.existsSync(localPath)) return localPath;

  // npm pack fallback — fetch platform-specific package
  // First get latest cometix base version, then append platform suffix
  const PLAT_SUFFIX = {
    "mac-arm64": "darwin-arm64", "mac-x64": "darwin-x64",
    "win": "win32-x64",
    "linux-x64": "linux-x64", "linux-arm64": "linux-arm64",
  };
  const suffix = PLAT_SUFFIX[platform];
  if (!suffix) return null;

  let baseVer;
  try {
    baseVer = execSync("npm view @cometix/codex version", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return null; }

  // e.g. "0.128.0-cometix" → "@cometix/codex@0.128.0-cometix-darwin-x64"
  const platPkgSpec = `@cometix/codex@${baseVer}-${suffix}`;
  console.log(`   [codex] fetching ${platPkgSpec} via npm pack...`);
  const tmpDir = path.join(require("os").tmpdir(), "cometix-codex-pack");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tgzName = execSync(`npm pack ${platPkgSpec} --pack-destination "${tmpDir}"`, {
      cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n").pop();
    const extractDir = path.join(tmpDir, "extracted");
    clearDir(extractDir);
    execSync(`tar xzf "${path.join(tmpDir, tgzName)}" -C "${extractDir}"`, { stdio: "pipe" });
    const p = path.join(extractDir, "package", "vendor", triple, "codex", binName);
    if (fs.existsSync(p)) return p;
  } catch (e) {
    console.log(`   [!] npm pack failed: ${e.message}`);
  }
  return null;
}

// ─── macOS build ────────────────────────────────────────────────

function buildMac(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] ${platform}/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // 1. Find the .app in the ZIP extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(tempDir, `${variant}-extract`);

  // Find Codex.app
  let appPath = null;
  if (fs.existsSync(extractDir)) {
    const findApp = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "Codex.app" && e.isDirectory()) return path.join(dir, e.name);
        if (e.isDirectory()) { const r = findApp(path.join(dir, e.name)); if (r) return r; }
      }
      return null;
    };
    appPath = findApp(extractDir);
  }

  if (!appPath) {
    console.error(`[x] Codex.app not found in cache. Run sync-upstream first.`);
    process.exit(1);
  }

  console.log(`   [source] ${appPath}`);

  // 2. Copy .app to output (ditto preserves symlinks + resource forks)
  const outAppDir = path.join(OUT_DIR, platform);
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex.app");
  console.log("   [copy] Codex.app -> out/");
  execSync(`ditto "${appPath}" "${outApp}"`);

  const resourcesDir = path.join(outApp, "Contents", "Resources");

  // 3. Repack patched ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // 4. Update ASAR integrity hash in Info.plist
  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    updateAsarIntegrity(asarPath, infoPlist);
  }

  // 5. Strip original signature + quarantine
  console.log("   [codesign] removing original signature");
  try { execSync(`codesign --remove-signature "${outApp}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`xattr -rd com.apple.quarantine "${outApp}"`, { stdio: "pipe" }); } catch {}

  // 6. Replace codex CLI
  replaceCodex(platform, resourcesDir, "codex");

  // 7. Ad-hoc re-sign (prevents "damaged app" Gatekeeper error)
  console.log("   [codesign] ad-hoc signing");
  try {
    execSync(`codesign --sign - --force --deep "${outApp}"`, { stdio: "pipe" });
    console.log("   [ok] ad-hoc signed");
  } catch (e) {
    console.log(`   [!] ad-hoc sign failed: ${e.message}`);
  }

  // 8. Create DMG
  const version = getVersion(asarDir);
  const dmgName = `Codex-${platform}-${version}.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);
  console.log(`   [dmg] ${dmgName}`);
  execSync(`hdiutil create -volname Codex -srcfolder "${outAppDir}" -ov -format UDZO "${dmgPath}"`, { stdio: "pipe" });
  const sizeMB = (fs.statSync(dmgPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${dmgPath} (${sizeMB} MB)`);
}

// ─── Windows build ──────────────────────────────────────────────

function buildWin(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] win/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Windows: use the MSIX extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const extractDir = path.join(tempDir, "win-extract");
  const appDir = path.join(extractDir, "app");

  if (!fs.existsSync(appDir)) {
    console.error(`[x] MSIX extract not found. Run sync-upstream first.`);
    process.exit(1);
  }
  const entryRelativePath = getWindowsEntryRelativePath(extractDir, appDir);
  console.log(`   [entry] ${entryRelativePath}`);

  // Copy app/ to output
  const outAppDir = path.join(OUT_DIR, "win");
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex-win32-x64");
  console.log("   [copy] MSIX app/ -> out/");
  copyRecursive(appDir, outApp);

  const resourcesDir = path.join(outApp, path.dirname(entryRelativePath), "resources");
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Windows resources directory is missing: ${resourcesDir}`);
  }

  // Compute old ASAR header hash (before repack)
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] old hash: ${oldHash.slice(0, 16)}...`);

  // Repack patched ASAR
  console.log("   [asar pack] _asar/ -> app.asar");
  execSync(`npx asar pack "${asarDir}" "${asarPath}"`);

  // Compute new hash and patch exe
  const newHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] new hash: ${newHash.slice(0, 16)}...`);

  if (oldHash !== newHash) {
    const exePath = path.join(outApp, entryRelativePath);
    const patched = patchExeHash(exePath, oldHash, newHash);
    const isOwlHost = fs.existsSync(path.join(outApp, "owl-shell-runtime.json")) &&
      fs.existsSync(path.join(resourcesDir, "owl-electron-app.json"));
    if (!patched && !isOwlHost) {
      throw new Error(`ASAR integrity hash not found in ${entryRelativePath}`);
    }
    if (!patched) {
      console.log(`   [integrity] ${entryRelativePath} uses Owl runtime; no embedded ASAR hash`);
    }
  }

  // Replace Codex CLI and its matching Windows helpers.
  const codexBundle = replaceWindowsCodexBundle(resourcesDir);
  writeWindowsLauncher(outApp, entryRelativePath);

  // Create ZIP
  const appVersion = getVersion(asarDir);
  const windowsPackageVersion = getWindowsPackageVersion();
  const zipName = createWindowsZipName(appVersion, codexBundle.version);
  const zipPath = path.join(OUT_DIR, zipName);
  fs.writeFileSync(path.join(outApp, "build-info.json"), JSON.stringify({
    appVersion,
    windowsPackageVersion,
    entryExecutable: entryRelativePath.split(path.sep).join("/"),
    hostExecutableSha256: sha256File(path.join(outApp, entryRelativePath)),
    codexCliVersion: codexBundle.version,
    codexPackageIntegrity: codexBundle.integrity,
    codexExecutableSha256: codexBundle.hashes,
  }, null, 2) + "\n");
  fs.rmSync(zipPath, { force: true });
  console.log(`   [zip] ${zipName}`);
  execSync(`7zz a -tzip -mx=5 "${zipPath}" .`, { cwd: outApp });

  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${zipPath} (${sizeMB} MB)`);
}

// ─── ASAR integrity ─────────────────────────────────────────────

function computeAsarHeaderHash(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) {
    return false;
  }
  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] exe hash patched at offset ${idx}`);
  return true;
}

function updateAsarIntegrity(asarPath, infoPlistPath) {
  const newHash = computeAsarHeaderHash(asarPath);
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.hash -string "${newHash}" "${infoPlistPath}"`, { stdio: "pipe" });
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.algorithm -string "SHA256" "${infoPlistPath}"`, { stdio: "pipe" });

  // Verify
  const verify = execSync(`plutil -extract ElectronAsarIntegrity.Resources/app\\\\.asar.hash raw "${infoPlistPath}"`, { encoding: "utf-8" }).trim();
  if (verify === newHash) {
    console.log(`   [integrity] hash updated: ${newHash.slice(0, 16)}...`);
  } else {
    console.log(`   [!] integrity verify failed`);
  }
}

// ─── Shared ─────────────────────────────────────────────────────

function replaceCodex(platform, resourcesDir, binName) {
  const vendor = resolveCodexVendor(platform);
  if (vendor) {
    const dest = path.join(resourcesDir, binName);
    fs.copyFileSync(vendor, dest);
    try { fs.chmodSync(dest, 0o755); } catch {}
    console.log(`   [codex] replaced with @cometix/codex`);
  } else {
    console.log(`   [!] @cometix/codex not found, keeping upstream codex`);
  }
}

function getVersion(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    console.error("[x] Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win>");
    process.exit(1);
  }

  console.log(`\n== Build from upstream: ${platform} ==\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (platform.startsWith("mac")) {
    buildMac(platform);
  } else {
    buildWin(platform);
  }
}

if (require.main === module) main();

module.exports = {
  WINDOWS_CODEX_FILES,
  createWindowsZipName,
  parseWindowsApplicationExecutable,
  writeWindowsLauncher,
};
