#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { buildComponents, recipeId } = require("./build-components");
const { sha256 } = require("./build-windows-update");

const ROOT = path.resolve(__dirname, "..");
const REPO = "WSGsety/rebuild-codex-desktop";
const ALIAS = "components-preview";

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, ...options });
}

function releaseByTag(tag) {
  try { return JSON.parse(gh(["api", "repos/" + REPO + "/releases/tags/" + tag])); }
  catch (error) {
    if (String(error.stderr).includes("404")) return null;
    throw error;
  }
}

function isCompletePreview(release) {
  return release?.prerelease && !release.draft &&
    ["update.json", "SHA256SUMS.txt", "updater-preview.zip"].every((name) =>
      (release.assets || []).some((asset) => asset.name === name && asset.size > 0));
}

async function verifyAssets(tag, directory, names) {
  const release = releaseByTag(tag);
  for (const name of names) {
    const asset = release?.assets?.find((item) => item.name === name && item.state === "uploaded");
    const file = path.join(directory, name);
    if (!asset || asset.size !== fs.statSync(file).size || asset.digest !== "sha256:" + await sha256(file)) {
      throw new Error("预览附件校验失败：" + name);
    }
  }
  return release;
}

async function publishPreview() {
  const actualBranch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  if (actualBranch !== "codex/component-updates") throw new Error("预览发布只允许在 codex/component-updates 分支执行");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const recipe = recipeId();
  const source = JSON.parse(gh(["api", "repos/" + REPO + "/releases/latest"]));
  if (source.draft || source.prerelease) throw new Error("正式应用来源不能是预览发布");
  const fullAssets = source.assets.filter((asset) => /^Codex-win-x64-.*\.zip$/.test(asset.name) && !asset.name.includes("-update-from-"));
  if (fullAssets.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(fullAssets[0].digest || "")) throw new Error("正式版本缺少唯一的可校验 Windows 全量包");
  const sourceAsset = fullAssets[0];
  const sourceMarker = "<!-- component-preview-source:" + source.tag_name + " -->";
  const recipeMarker = "<!-- component-preview-recipe:" + recipe + " -->";
  const alias = releaseByTag(ALIAS);
  if (isCompletePreview(alias) && alias.body?.includes(sourceMarker) && alias.body?.includes(recipeMarker)) {
    console.log("预览已覆盖正式版本 " + source.tag_name + "，本次跳过下载与打包。");
    return;
  }
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "cp-"));
  try {
    const appDir = path.join(work, "app");
    const outDir = path.join(work, "assets");
    console.log("正式应用来源：" + source.tag_name);
    gh(["release", "download", source.tag_name, "--repo", REPO, "--pattern", sourceAsset.name, "--dir", work], { stdio: "inherit" });
    const sourceZip = path.join(work, sourceAsset.name);
    if ("sha256:" + await sha256(sourceZip) !== sourceAsset.digest) throw new Error("正式来源全量包校验失败");
    execFileSync("7zz", ["x", "-y", "-o" + appDir, sourceZip], { stdio: "pipe" });
    fs.rmSync(sourceZip);
    const result = await buildComponents({ appDir, outDir, sourceTag: source.tag_name, revision });
    const names = fs.readdirSync(outDir).sort();
    const notesPath = path.join(work, "notes.md");
    const notes = "组件更新器预览版，应用文件来源于正式发布 [" + source.tag_name + "](" + source.html_url + ")。\n\n" +
      "更新器与打包代码：[codex/component-updates @ " + revision.slice(0, 7) + "](https://github.com/" + REPO + "/commit/" + revision + ")。\n\n" +
      "已有便携版用户下载 **updater-preview.zip**，解压到程序目录，双击 **检查预览更新.cmd**。新安装用户使用 **" + result.manifest.full.name + "**。\n\n" +
      "更新器只跟踪组件预览渠道，不会写入正式 Latest。它按文件 SHA256 选择组件，完全退出程序后准备备份和目录切换；用户配置目录不由更新器修改。\n\n" +
      "仅完成基础脚本检查与发布包完整性检查，尚未进行真实安装观察。请在独立目录试用，保留更新产生的备份；稳定性由后续多个版本的试用结果评估。\n\n" +
      "构建标识：" + result.manifest.buildId + "。\n\n" + sourceMarker + recipeMarker + "\n";
    fs.writeFileSync(notesPath, notes);
    // 标签只作产物索引；实际构建代码修订在清单与说明中单独记录。
    const target = JSON.parse(gh(["api", "repos/" + REPO])).default_branch;
    let release = releaseByTag(result.tag);
    if (release && !release.prerelease) throw new Error("目标 tag 已用于正式发布，拒绝修改");
    let publishedManifest = result.manifest;
    if (!release) {
      gh(["release", "create", result.tag, "--repo", REPO, "--target", target, "--draft", "--prerelease", "--latest=false", "--title", result.tag, "--notes-file", notesPath]);
      release = releaseByTag(result.tag);
    }
    if (release.draft) {
      const existing = new Set((release.assets || []).map((asset) => asset.name));
      for (const name of names) {
        if (existing.has(name)) gh(["release", "delete-asset", result.tag, name, "--repo", REPO, "--yes"]);
        gh(["release", "upload", result.tag, path.join(outDir, name), "--repo", REPO], { stdio: "inherit" });
      }
      await verifyAssets(result.tag, outDir, names);
      gh(["release", "edit", result.tag, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false", "--notes-file", notesPath]);
    } else {
      const published = path.join(work, "published");
      fs.mkdirSync(published);
      for (const name of ["update.json", "SHA256SUMS.txt", "updater-preview.zip"]) {
        gh(["release", "download", result.tag, "--repo", REPO, "--pattern", name, "--dir", published]);
        fs.copyFileSync(path.join(published, name), path.join(outDir, name));
      }
      publishedManifest = JSON.parse(fs.readFileSync(path.join(published, "update.json"), "utf8"));
      if (publishedManifest.buildId !== result.manifest.buildId || publishedManifest.recipeId !== recipe) throw new Error("公开预览内容不一致，拒绝覆盖");
    }
    const pointerNotes = "组件预览更新入口，当前版本：[" + result.tag + "](https://github.com/" + REPO + "/releases/tag/" + result.tag + ")。\n\n" + sourceMarker + recipeMarker + "\n";
    fs.writeFileSync(notesPath, pointerNotes);
    if (!alias) gh(["release", "create", ALIAS, "--repo", REPO, "--target", target, "--draft", "--prerelease", "--latest=false", "--title", "组件更新预览渠道", "--notes-file", notesPath]);
    else if (!alias.prerelease) throw new Error("预览入口 tag 被正式发布占用");
    // 只有渠道入口清单是可变的，组件 URL 都固定到不可变版本。
    gh(["release", "upload", ALIAS, path.join(outDir, "update.json"), path.join(outDir, "updater-preview.zip"), path.join(outDir, "SHA256SUMS.txt"), "--repo", REPO, "--clobber"], { stdio: "inherit" });
    await verifyAssets(ALIAS, outDir, ["update.json", "updater-preview.zip", "SHA256SUMS.txt"]);
    gh(["release", "edit", ALIAS, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false", "--notes-file", notesPath]);
    const latest = JSON.parse(gh(["api", "repos/" + REPO + "/releases/latest"]));
    if (latest.tag_name === ALIAS || latest.tag_name.startsWith("components-preview-")) throw new Error("预览意外成为正式 Latest");
    const report = { sourceTag: source.tag_name, previewTag: result.tag, buildId: publishedManifest.buildId, builderRevision: publishedManifest.builderRevision, recipeId: recipe, publishedAt: new Date().toISOString(), runtimeObserved: false, formalLatest: latest.tag_name };
    const reportPath = path.join(ROOT, "out", "preview-publication.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log("已发布预览：https://github.com/" + REPO + "/releases/tag/" + result.tag);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "预览发布：" + result.tag + "\n\n正式来源：" + source.tag_name + "\n\n未做真实安装观察；正式 Latest：" + latest.tag_name + "\n");
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) publishPreview().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { isCompletePreview };
