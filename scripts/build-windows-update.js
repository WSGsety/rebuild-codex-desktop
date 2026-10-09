#!/usr/bin/env node
// 生成可手动覆盖的 Windows 增量 ZIP；临时旧版同时用于覆盖验证。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const VERSION = /^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const FULL_ZIP = /^Codex-win-x64-\d+(?:\.\d+){2,3}(?:-cli-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)?\.zip$/;

function selectPreviousRelease(releases, currentTag) {
  for (const release of [...releases].sort((a, b) =>
    (b.published_at || "").localeCompare(a.published_at || ""))) {
    if (release.draft || release.prerelease || release.tag_name === currentTag) continue;
    const fullZips = (release.assets || []).filter((asset) =>
      FULL_ZIP.test(asset.name) && !asset.name.includes("-update-from-"));
    const hasChecksums = (release.assets || []).some((asset) => asset.name === "SHA256SUMS.txt");
    if (fullZips.length === 1 && hasChecksums) {
      return { tag: release.tag_name, zipName: fullZips[0].name };
    }
  }
  return null;
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(dir, relative = "", files = new Map()) {
  for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const file = path.join(dir, name);
    if (entry.isDirectory()) {
      files.set(name, "directory");
      await inventory(dir, name, files);
    } else if (entry.isFile()) {
      files.set(name, await sha256(file));
    } else {
      throw new Error(`增量不支持链接或特殊文件：${name}`);
    }
  }
  return files;
}

function buildInfo(dir) {
  const info = JSON.parse(fs.readFileSync(path.join(dir, "build-info.json"), "utf-8"));
  if (!VERSION.test(info.appVersion || "") || !VERSION.test(info.codexCliVersion || "")) {
    throw new Error("build-info.json 缺少有效的 App 或 CLI 版本");
  }
  return info;
}

async function buildUpdate(baselineDir, currentDir, outDir) {
  if (!fs.existsSync(path.join(baselineDir, "build-info.json"))) {
    return { reason: "上一版缺少 build-info.json，本次仅提供全量包。" };
  }
  const before = buildInfo(baselineDir);
  const after = buildInfo(currentDir);
  const previous = await inventory(baselineDir);
  const current = await inventory(currentDir);
  const removed = [...previous.keys()].filter((name) =>
    !current.has(name) || (previous.get(name) === "directory") !== (current.get(name) === "directory"));
  if (removed.length) {
    console.log(`   [update] 无法通过覆盖移除：${removed.slice(0, 5).join(", ")}`);
    return { reason: `新版删除或改变了 ${removed.length} 个文件/目录，本次仅提供全量包，请解压到新目录。` };
  }
  const changed = [...current.keys()].filter((name) => current.get(name) !== previous.get(name));
  if (!changed.length) return { reason: "两版文件完全相同，无需增量更新。" };

  const zipName = `Codex-win-x64-${after.appVersion}-cli-${after.codexCliVersion}-update-from-${before.appVersion}-cli-${before.codexCliVersion}.zip`;
  const zipPath = path.join(outDir, zipName);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-files-"));
  fs.mkdirSync(outDir, { recursive: true });
  try {
    for (const name of changed) {
      const destination = path.join(stagingDir, name);
      if (current.get(name) === "directory") {
        fs.mkdirSync(destination, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(currentDir, name), destination);
      }
    }
    fs.rmSync(zipPath, { force: true });
    execFileSync("7zz", ["a", "-tzip", "-mx=5", zipPath, "."], { cwd: stagingDir, stdio: "pipe" });
    // 基线是下载包的临时副本，直接覆盖验证，避免额外复制整个应用。
    execFileSync("7zz", ["x", "-y", `-o${baselineDir}`, zipPath], { stdio: "pipe" });
    const overlaid = await inventory(baselineDir);
    if (overlaid.size !== current.size || [...current].some(([name, hash]) => overlaid.get(name) !== hash)) {
      throw new Error("旧版覆盖增量后的文件与新版全量包不一致");
    }
    console.log(`   [update] ${changed.length} 项变化，覆盖验证通过：${zipName}`);
    return { zipName, reason: "" };
  } catch (error) {
    fs.rmSync(zipPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function verifyChecksum(zipPath, checksumsPath) {
  const name = path.basename(zipPath);
  const line = fs.readFileSync(checksumsPath, "utf-8").split(/\r?\n/)
    .map((entry) => entry.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/))
    .find((entry) => entry?.[2] === name);
  if (!line || await sha256(zipPath) !== line[1].toLowerCase()) {
    throw new Error(`上一版全量包 SHA256 校验失败：${name}`);
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const currentTag = process.env.TAG;
  if (!repository || !currentTag) throw new Error("需要 GITHUB_REPOSITORY 和 TAG");
  const releases = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/releases?per_page=100`], {
    encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
  }));
  const base = selectPreviousRelease(releases, currentTag);
  let result = { reason: "没有可用的上一版全量包，本次仅提供全量包。" };
  if (base) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-baseline-"));
    try {
      console.log(`   [update] 基线：${base.tag} / ${base.zipName}`);
      execFileSync("gh", ["release", "download", base.tag, "--repo", repository,
        "--pattern", base.zipName, "--pattern", "SHA256SUMS.txt", "--dir", tempDir], { stdio: "inherit" });
      const zipPath = path.join(tempDir, base.zipName);
      await verifyChecksum(zipPath, path.join(tempDir, "SHA256SUMS.txt"));
      const baselineDir = path.join(tempDir, "app");
      execFileSync("7zz", ["x", "-y", `-o${baselineDir}`, zipPath], { stdio: "pipe" });
      const outDir = path.join(ROOT, "out");
      result = await buildUpdate(baselineDir, path.join(outDir, "win", "Codex-win32-x64"), outDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (result.reason) console.log(`   [update] ${result.reason}`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `zip_name=${result.zipName || ""}\nbase_tag=${base?.tag || ""}\nreason=${result.reason}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(`[x] ${error.message}`); process.exitCode = 1; });
}

module.exports = { selectPreviousRelease, buildUpdate, verifyChecksum };
