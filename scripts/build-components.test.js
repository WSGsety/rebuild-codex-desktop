const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { componentFor, safePath, buildComponents } = require("./build-components");
const { sha256 } = require("./build-windows-update");
const { isCompletePreview } = require("./publish-components-preview");

function write(dir, name, contents) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "components-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, "app");
  write(appDir, "build-info.json", JSON.stringify({ appVersion: "26.1002.52244", codexCliVersion: "0.162.0", windowsPackageVersion: "26.1002.7124.0", entryExecutable: "ChatGPT.exe" }));
  write(appDir, "ChatGPT.exe", "宿主");
  write(appDir, "启动 Codex.cmd", "启动入口");
  write(appDir, "resources/app.asar", "应用");
  write(appDir, "resources/codex.exe", "CLI");
  write(appDir, "resources/plugins/中文 文件.txt", "插件");
  fs.mkdirSync(path.join(appDir, "resources/empty"));
  return { root, appDir };
}

test("组件分组覆盖宿主、应用、CLI、工具和元数据", () => {
  assert.equal(componentFor("ChatGPT.exe"), "runtime");
  assert.equal(componentFor("resources/app.asar"), "app");
  assert.equal(componentFor("resources/app.asar.unpacked/addon.node"), "app");
  assert.equal(componentFor("resources/codex-code-mode-host.exe"), "cli");
  assert.equal(componentFor("resources/cua_node/bin/node.exe"), "tools");
  assert.equal(componentFor("build-info.json"), "meta");
});

test("Windows 路径拒绝越界、设备名、ADS 和大小写碰撞前的非法名称", () => {
  for (const name of ["../outside", "a/../b", "/root", "C:/root", "a\\b", "x:stream", "NUL.txt", "aux", "a/COM1", "a.", "a ", "a//b"]) assert.equal(safePath(name), false, name);
  assert.equal(safePath("resources/中文 文件.txt"), true);
});

test("清单与所有组件共同组成完整目录，哈希匹配且同内容构建标识稳定", async (context) => {
  const { root, appDir } = fixture(context);
  const outDir = path.join(root, "one");
  const result = await buildComponents({ appDir, outDir, sourceTag: "v26.1002.52244-cli-0.162.0", revision: "a".repeat(40) });
  assert.deepEqual(result.manifest.components.map((component) => component.id), ["runtime", "app", "cli", "tools", "meta"]);
  assert.equal(result.tag, "preview-v26.1002.52244-cli-0.162.0");
  for (const item of [result.manifest.full, ...result.manifest.components]) assert.ok(item.url.includes("/releases/download/" + result.tag + "/"));
  assert.ok(result.manifest.full.name.endsWith(result.manifest.full.sha256 + ".zip"));
  assert.ok(result.manifest.directories.includes("resources/empty"));
  const assembled = path.join(root, "assembled");
  for (const component of result.manifest.components) {
    assert.equal(await sha256(path.join(outDir, component.name)), component.sha256);
    execFileSync("7zz", ["x", "-y", "-o" + assembled, path.join(outDir, component.name)], { stdio: "pipe" });
  }
  for (const file of result.manifest.files) assert.equal(await sha256(path.join(assembled, file.path)), file.sha256);
  const second = await buildComponents({ appDir, outDir: path.join(root, "two"), sourceTag: "v26.1002.52244-cli-0.162.0", revision: "b".repeat(40) });
  assert.equal(second.manifest.buildId, result.manifest.buildId);
  write(appDir, "resources/codex.exe", "CLI 内容改变，版本号保持不变");
  const third = await buildComponents({ appDir, outDir: path.join(root, "three"), sourceTag: "v26.1002.52244-cli-0.162.0", revision: "c".repeat(40) });
  assert.notEqual(third.manifest.buildId, result.manifest.buildId);
  const zipList = execFileSync("7zz", ["l", path.join(outDir, "updater-preview.zip")], { encoding: "utf8" });
  assert.ok(zipList.includes("update-components.ps1"));
});

test("按版本预览必须直接包含清单引用的全部包，不能把旧入口当作完成发布", () => {
  const hash = "a".repeat(64);
  const components = ["runtime", "app", "cli", "tools", "meta"].map((id) => ({ id, name: "component-" + id + "-" + hash + ".zip", sha256: hash, sizeBytes: 1 }));
  const full = { name: "full-" + hash + ".zip", sha256: hash, sizeBytes: 1 };
  for (const item of [full, ...components]) item.url = "https://github.com/WSGsety/rebuild-codex-desktop/releases/download/preview-v26.1002.52244-cli-0.162.0/" + item.name;
  const manifest = { channel: "preview", full, components };
  const metadata = ["update.json", "SHA256SUMS.txt", "updater-preview.zip"].map((name) => ({ name, state: "uploaded", size: 1 }));
  const assets = [...metadata, ...[full, ...components].map((item) => ({ name: item.name, state: "uploaded", size: item.sizeBytes, digest: "sha256:" + item.sha256 }))];
  const release = { tag_name: "preview-v26.1002.52244-cli-0.162.0", prerelease: true, draft: false, assets };
  assert.ok(isCompletePreview(release, manifest));
  assert.equal(isCompletePreview({ ...release, prerelease: false }, manifest), false);
  assert.equal(isCompletePreview({ ...release, draft: true }, manifest), false);
  assert.equal(isCompletePreview({ ...release, assets: metadata }, manifest), false);
  assert.equal(isCompletePreview({ ...release, tag_name: "components-preview" }, manifest), false);
  assert.equal(isCompletePreview({ ...release, assets: assets.slice(0, -1) }, manifest), false);
  assert.equal(isCompletePreview({ ...release, assets: assets.map((item) => ({ ...item, digest: "sha256:" + "b".repeat(64) })) }, manifest), false);
  const old = structuredClone(manifest);
  old.full.url = old.full.url.replace("/preview-v26.1002.52244-cli-0.162.0/", "/components-preview-v-old/");
  assert.equal(isCompletePreview(release, old), false);
});

test("Windows 基础检查只使用测试文件，不安装或运行桌面应用", { skip: process.platform !== "win32" }, () => {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve(__dirname, "../updater/update-components.test.ps1")], { stdio: "pipe" });
});
