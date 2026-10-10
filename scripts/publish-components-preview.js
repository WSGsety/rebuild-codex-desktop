#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { buildComponents, recipeId, PREVIEW_PREFIX } = require("./build-components");
const { sha256 } = require("./build-windows-update");

const ROOT = path.resolve(__dirname, "..");
const REPO = "WSGsety/rebuild-codex-desktop";

function gh(args, options = {}) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, ...options });
}

function releaseByTag(tag) {
  try { return JSON.parse(gh(["api", "repos/" + REPO + "/releases/tags/" + tag])); }
  catch (error) {
    // 尚未公开的草稿可能没有 tag，改用发布列表查找。
    if (String(error.stderr).includes("404")) {
      const draft = gh(["api", "repos/" + REPO + "/releases?per_page=100", "--paginate", "--jq", ".[] | select(.tag_name == " + JSON.stringify(tag) + ")"]).trim();
      return draft ? JSON.parse(draft) : null;
    }
    throw error;
  }
}

function isCompletePreview(release, manifest) {
  if (!release?.prerelease || release.draft || !release.tag_name?.startsWith(PREVIEW_PREFIX) || manifest?.channel !== "preview" ||
      !["runtime", "app", "cli", "tools", "meta"].every((id) => manifest.components?.some((item) => item.id === id))) return false;
  const assets = release.assets || [];
  if (!["update.json", "SHA256SUMS.txt", "updater-preview.zip"].every((name) => assets.some((item) => item.name === name && item.state === "uploaded" && item.size > 0))) return false;
  return [manifest.full, ...manifest.components].every((item) => {
    const asset = assets.find((candidate) => candidate.name === item?.name);
    return asset && asset.state === "uploaded" && asset.size === item.sizeBytes &&
      asset.digest === "sha256:" + item.sha256 &&
      item.url === "https://github.com/" + REPO + "/releases/download/" + release.tag_name + "/" + item.name;
  });
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
  const tag = PREVIEW_PREFIX + source.tag_name;
  const release = releaseByTag(tag);
  if (release && !release.prerelease) throw new Error("预览 tag 已用于正式发布，拒绝修改");
  const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "cp-"));
  try {
    if (release && !release.draft && release.body?.includes(sourceMarker) && release.body.includes(recipeMarker) && release.assets?.some((asset) => asset.name === "update.json" && asset.state === "uploaded")) {
      gh(["release", "download", tag, "--repo", REPO, "--pattern", "update.json", "--dir", work]);
      await verifyAssets(tag, work, ["update.json"]);
      const current = JSON.parse(fs.readFileSync(path.join(work, "update.json"), "utf8"));
      if (current.sourceTag === source.tag_name && current.recipeId === recipe && isCompletePreview(release, current)) {
        console.log("预览已覆盖正式版本 " + source.tag_name + "，本次跳过下载与打包。");
        return;
      }
    }
    const appDir = path.join(work, "app");
    const outDir = path.join(work, "assets");
    console.log("正式应用来源：" + source.tag_name);
    gh(["release", "download", source.tag_name, "--repo", REPO, "--pattern", sourceAsset.name, "--dir", work], { stdio: "inherit" });
    const sourceZip = path.join(work, sourceAsset.name);
    if ("sha256:" + await sha256(sourceZip) !== sourceAsset.digest) throw new Error("正式来源全量包校验失败");
    execFileSync("7zz", ["x", "-y", "-o" + appDir, sourceZip], { stdio: "pipe" });
    fs.rmSync(sourceZip);
    const result = await buildComponents({ appDir, outDir, sourceTag: source.tag_name, revision });
    if (result.tag !== tag) throw new Error("正式来源 tag 与包内版本信息不一致");
    const names = fs.readdirSync(outDir).sort();
    const notesPath = path.join(work, "notes.md");
    const notes = "组件更新器预览版，应用文件来源于正式发布 [" + source.tag_name + "](" + source.html_url + ")。\n\n" +
      "更新器与打包代码：[codex/component-updates @ " + revision.slice(0, 7) + "](https://github.com/" + REPO + "/commit/" + revision + ")。\n\n" +
      "已有便携版用户下载 **updater-preview.zip**，解压到程序目录，双击 **检查预览更新.cmd**。新安装用户使用 **" + result.manifest.full.name + "**。\n\n" +
      "更新器通过 GitHub API 查询最新的 preview- 预览版本，再直接下载该版本清单和组件。旧的固定入口已取消，之前下载过更新工具的用户需要重新下载一次 **updater-preview.zip**（更新器 " + result.manifest.updaterVersion + "）。它不设置正式 Latest。它按文件 SHA256 选择组件，完全退出程序后准备备份和目录切换；用户配置目录不由更新器修改。\n\n" +
      "仅完成基础脚本检查与发布包完整性检查，尚未进行真实安装观察。请在独立目录试用，保留更新产生的备份；稳定性由后续多个版本的试用结果评估。\n\n" +
      "构建标识：" + result.manifest.buildId + "。\n\n" + sourceMarker + recipeMarker + "\n";
    fs.writeFileSync(notesPath, notes);
    const title = tag;
    if (!release) {
      const target = JSON.parse(gh(["api", "repos/" + REPO])).default_branch;
      gh(["release", "create", tag, "--repo", REPO, "--target", target, "--draft", "--prerelease", "--latest=false", "--title", title, "--notes-file", notesPath]);
    }
    // 程序包按 SHA256 命名且不覆盖，读到旧清单的客户端仍可下载原包。
    const archives = names.filter((name) => name.endsWith(".zip") && name !== "updater-preview.zip");
    for (const name of archives) {
      const existing = release?.assets?.find((asset) => asset.name === name);
      if (existing) {
        const file = path.join(outDir, name);
        if (existing.size !== fs.statSync(file).size || existing.digest !== "sha256:" + await sha256(file)) throw new Error("已有程序包内容不一致，拒绝覆盖：" + name);
      } else {
        gh(["release", "upload", tag, path.join(outDir, name), "--repo", REPO], { stdio: "inherit" });
      }
    }
    await verifyAssets(tag, outDir, archives);
    gh(["release", "upload", tag, path.join(outDir, "updater-preview.zip"), path.join(outDir, "SHA256SUMS.txt"), "--repo", REPO, "--clobber"], { stdio: "inherit" });
    await verifyAssets(tag, outDir, ["updater-preview.zip", "SHA256SUMS.txt"]);
    // 最后切换清单，公开清单引用的全部程序包此时已可下载。
    gh(["release", "upload", tag, path.join(outDir, "update.json"), "--repo", REPO, "--clobber"], { stdio: "inherit" });
    const published = await verifyAssets(tag, outDir, names);
    gh(["release", "edit", tag, "--repo", REPO, "--draft=false", "--prerelease", "--latest=false", "--title", title, "--notes-file", notesPath]);
    if (!isCompletePreview({ ...published, draft: false }, result.manifest)) throw new Error("预览清单引用的附件不完整");
    const latest = JSON.parse(gh(["api", "repos/" + REPO + "/releases/latest"]));
    if (latest.prerelease || latest.tag_name.startsWith(PREVIEW_PREFIX) || latest.tag_name.startsWith("components-preview")) throw new Error("预览意外成为正式 Latest");
    const report = { sourceTag: source.tag_name, previewTag: result.tag, buildId: result.manifest.buildId, builderRevision: result.manifest.builderRevision, recipeId: recipe, publishedAt: new Date().toISOString(), runtimeObserved: false, formalLatest: latest.tag_name };
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
