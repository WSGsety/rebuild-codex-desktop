#!/usr/bin/env node
/**
 * check-windows-skip.js — 每日构建的轻量前置探测
 *
 * 只查商店元数据（SOAP，不下载 MSIX）+ npm 最新 CLI 版本 + 已有 Release
 * 说明里的版本标记。若已有 Release 同时匹配当前 MSIX 包版本与 CLI 版本，
 * 整轮构建直接跳过，无变更日不再触碰商店 CDN。
 *
 * 用法（CI 中）:
 *   node scripts/check-windows-skip.js
 * 环境变量:
 *   GITHUB_REPOSITORY  仓库名（Actions 自带）
 *   GH_TOKEN           gh api 凭据（Actions 自带 github.token）
 *   GITHUB_OUTPUT      输出文件（Actions 自带）
 *   FORCE_BUILD        为 "true" 时无条件不跳过
 *
 * 输出: skip / msix_version / cli_version
 */

const fs = require("fs");
const { execFileSync } = require("child_process");
const { getWindowsVersion } = require("./sync-upstream");

// 旧版 Release 说明没有显式 msix 标记，从中文正文里取；新版优先读标记。
const LEGACY_MSIX_RE = /基于 Microsoft Store Windows x64 安装包 (\d+(?:\.\d+){2,3}) 重新打包/;
const MSIX_MARKER_RE = /<!-- msix-version:([^ ]+) -->/;
const CLI_MARKER_RE = /<!-- codex-cli-version:([^ ]+) -->/;

function releaseVersions(body) {
  if (!body) return null;
  const msix = body.match(MSIX_MARKER_RE)?.[1] || body.match(LEGACY_MSIX_RE)?.[1] || "";
  const cli = body.match(CLI_MARKER_RE)?.[1] || "";
  return msix && cli ? { msix, cli } : null;
}

function evaluateSkip(releases, msixVersion, cliVersion) {
  return (releases || []).some((release) => {
    const versions = releaseVersions(release.body);
    // 发布流程在校验完资产后才写入版本标记，资产数兜底防止后续被手动删空。
    return !!versions &&
      versions.msix === msixVersion &&
      versions.cli === cliVersion &&
      (release.assets || []).length >= 2;
  });
}

function npmLatestCodexVersion() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const version = execFileSync(npm, ["view", "@openai/codex", "version"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(process.platform === "win32" ? { shell: true } : {}),
  }).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Codex CLI version: ${version || "empty"}`);
  }
  return version;
}

function fetchReleases() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is not set");
  const env = { ...process.env, GH_TOKEN: process.env.GH_TOKEN || "" };
  const releases = [];
  for (let page = 1; page <= 5; page++) {
    const out = execFileSync(
      "gh",
      ["api", `repos/${repository}/releases?per_page=100&page=${page}`],
      { encoding: "utf-8", env, stdio: ["ignore", "pipe", "pipe"] }
    );
    const batch = JSON.parse(out);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function main() {
  const force = process.env.FORCE_BUILD === "true";

  const win = await getWindowsVersion();
  const cli = npmLatestCodexVersion();
  const releases = fetchReleases();
  const skip = !force && evaluateSkip(releases, win.version, cli);

  console.log(`   [probe] msix=${win.version} cli=${cli} releases=${releases.length}`);
  console.log(`   [probe] skip=${skip}${force ? " (forced)" : ""}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `skip=${skip}\nmsix_version=${win.version}\ncli_version=${cli}\n`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`\n[x] ${e.message}`); process.exit(1); });
}

module.exports = { releaseVersions, evaluateSkip };
