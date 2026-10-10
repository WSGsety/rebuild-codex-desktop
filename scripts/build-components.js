#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { inventory, sha256 } = require("./build-windows-update");

const ROOT = path.resolve(__dirname, "..");
const REPOSITORY = "WSGsety/rebuild-codex-desktop";
const MAX_BYTES = 2000000000;
const CLI_FILES = new Set(["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"]);
const META_FILES = new Set(["build-info.json", "启动 Codex.cmd", "检查预览更新.cmd", "update-components.ps1"]);

function componentFor(name) {
  if (META_FILES.has(name)) return "meta";
  if (!name.startsWith("resources/")) return "runtime";
  const relative = name.slice("resources/".length);
  if (CLI_FILES.has(relative)) return "cli";
  if (relative === "app.asar" || relative === "owl-electron-app.json" || relative.startsWith("app.asar.unpacked/")) return "app";
  return "tools";
}

function safePath(name) {
  return typeof name === "string" && name.length > 0 &&
    !/[\\:<>"|?*\x00-\x1f]/.test(name) && name.split("/").every((part) =>
      part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function packZip(directory, zipPath) {
  fs.rmSync(zipPath, { force: true });
  execFileSync("7zz", ["a", "-tzip", "-mx=5", zipPath, "."], { cwd: directory, stdio: "pipe" });
}

function recipeId() {
  const hash = crypto.createHash("sha256");
  for (const name of ["scripts/build-components.js", "scripts/publish-components-preview.js", "updater/update-components.ps1", "updater/检查预览更新.cmd"]) {
    hash.update(name).update(fs.readFileSync(path.join(ROOT, name)));
  }
  return hash.digest("hex");
}

async function buildComponents({ appDir, outDir, sourceTag, revision }) {
  appDir = path.resolve(appDir);
  outDir = path.resolve(outDir);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error("组件产物目录必须为空");
  const infoPath = path.join(appDir, "build-info.json");
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  for (const key of ["appVersion", "codexCliVersion"]) {
    if (!/^\d+(?:\.\d+){2,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(info[key] || "")) throw new Error(`无效版本字段：${key}`);
  }
  if (!safePath(info.entryExecutable) || !/\.exe$/i.test(info.entryExecutable)) throw new Error("无效启动入口");
  const before = await inventory(appDir);
  for (const name of ["检查预览更新.cmd", "update-components.ps1"]) {
    fs.copyFileSync(path.join(ROOT, "updater", name), path.join(appDir, name));
    before.set(name, await sha256(path.join(appDir, name)));
  }
  const payload = [...before].filter(([name]) => name !== "build-info.json").sort(([a], [b]) => a.localeCompare(b, "en"));
  const recipe = recipeId();
  const buildId = crypto.createHash("sha256").update(JSON.stringify({ recipe, appVersion: info.appVersion, cliVersion: info.codexCliVersion, windowsPackageVersion: info.windowsPackageVersion, payload })).digest("hex");
  fs.writeFileSync(infoPath, JSON.stringify({ ...info, componentBuildId: buildId, componentUpdateChannel: "preview" }, null, 2) + "\n");
  const snapshot = await inventory(appDir);
  const files = [];
  const directories = [];
  const seen = new Set();
  for (const [name, hash] of snapshot) {
    if (!safePath(name) || seen.has(name.toLowerCase())) throw new Error(`非法或重复的 Windows 路径：${name}`);
    seen.add(name.toLowerCase());
    if (hash === "directory") directories.push(name);
    else {
      const sizeBytes = fs.statSync(path.join(appDir, name)).size;
      if (sizeBytes >= MAX_BYTES) throw new Error(`文件超过原生解包限制：${name}`);
      files.push({ path: name, sha256: hash, sizeBytes, component: componentFor(name) });
    }
  }
  if (!files.some((file) => file.path === info.entryExecutable)) throw new Error("清单缺少启动程序");
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  directories.sort();
  const tag = `components-preview-v${info.appVersion}-cli-${info.codexCliVersion}-b${buildId.slice(0, 16)}`;
  const baseUrl = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  fs.mkdirSync(outDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "cg-"));
  const components = [];
  try {
    for (const id of ["runtime", "app", "cli", "tools", "meta"]) {
      const groupFiles = files.filter((file) => file.component === id);
      const groupDirs = directories.filter((name) => componentFor(name) === id);
      if (!groupFiles.length && !groupDirs.length) continue;
      const group = path.join(staging, id);
      fs.mkdirSync(group, { recursive: true });
      for (const name of groupDirs) fs.mkdirSync(path.join(group, name), { recursive: true });
      for (const file of groupFiles) {
        const destination = path.join(group, file.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(appDir, file.path), destination);
      }
      const temporaryZip = path.join(outDir, `${id}.zip`);
      packZip(group, temporaryZip);
      const digest = await sha256(temporaryZip);
      const name = `component-${id}-${digest}.zip`;
      fs.renameSync(temporaryZip, path.join(outDir, name));
      const sizeBytes = fs.statSync(path.join(outDir, name)).size;
      if (sizeBytes >= MAX_BYTES) throw new Error(`组件超过附件大小限制：${id}`);
      components.push({ id, name, url: baseUrl + name, sha256: digest, sizeBytes });
      console.log(`   [component] ${id}: ${(sizeBytes / 1048576).toFixed(1)} MiB`);
    }
    const fullName = `Codex-components-preview-win-x64-${info.appVersion}-cli-${info.codexCliVersion}.zip`;
    const fullPath = path.join(outDir, fullName);
    packZip(appDir, fullPath);
    const full = { name: fullName, url: baseUrl + fullName, sha256: await sha256(fullPath), sizeBytes: fs.statSync(fullPath).size };
    if (full.sizeBytes >= MAX_BYTES) throw new Error("全量包超过附件大小限制");
    const updaterDir = path.join(staging, "updater");
    fs.mkdirSync(updaterDir);
    for (const name of ["检查预览更新.cmd", "update-components.ps1"]) fs.copyFileSync(path.join(appDir, name), path.join(updaterDir, name));
    packZip(updaterDir, path.join(outDir, "updater-preview.zip"));
    const manifest = { schemaVersion: 1, updaterVersion: "1.0.0", minimumUpdaterVersion: "1.0.0", channel: "preview", platform: "win32", arch: "x64", buildId, sourceTag, builderRevision: revision, recipeId: recipe, appVersion: info.appVersion, codexCliVersion: info.codexCliVersion, entryExecutable: info.entryExecutable, full, components, files, directories };
    fs.writeFileSync(path.join(outDir, "update.json"), JSON.stringify(manifest, null, 2) + "\n");
    const sums = [];
    for (const name of fs.readdirSync(outDir).filter((name) => name.endsWith(".zip") || name === "update.json").sort()) sums.push(`${await sha256(path.join(outDir, name))}  ${name}`);
    fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
    return { tag, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("缺少参数：" + name);
    return args[index + 1];
  };
  buildComponents({ appDir: value("--app-dir"), outDir: value("--out-dir"), sourceTag: value("--source-tag"), revision: process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() })
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { componentFor, safePath, buildComponents, recipeId };
