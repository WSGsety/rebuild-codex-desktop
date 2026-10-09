const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { selectPreviousRelease, buildUpdate, verifyChecksum } = require("./build-windows-update");

function write(dir, name, contents) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseline = path.join(root, "baseline");
  const current = path.join(root, "current");
  const out = path.join(root, "out");
  for (const [dir, cli] of [[baseline, "0.161.0"], [current, "0.162.0"]]) {
    write(dir, "build-info.json", JSON.stringify({ appVersion: "26.1002.52244", codexCliVersion: cli }));
  }
  return { root, baseline, current, out };
}

function release(tag, date, names) {
  return { tag_name: tag, published_at: date, assets: names.map((name) => ({ name })) };
}

test("基线选择上一版正式全量包，忽略当前版本、草稿和只有增量的发布", () => {
  const full = "Codex-win-x64-26.1002.52244-cli-0.161.0.zip";
  const assets = [full, "SHA256SUMS.txt"];
  const releases = [
    release("old", "2026-10-01", assets),
    { ...release("draft", "2026-10-10", assets), draft: true },
    { ...release("preview", "2026-10-10", assets), prerelease: true },
    release("update-only", "2026-10-10", ["Codex-win-x64-26.1002.52244-cli-0.162.0-update-from-26.1002.52244-cli-0.161.0.zip", "SHA256SUMS.txt"]),
    release("current", "2026-10-09", assets),
    release("previous", "2026-10-08", assets),
  ];
  assert.deepEqual(selectPreviousRelease(releases, "current"), { tag: "previous", zipName: full });
});

test("旧命名的全量包可作为基线，缺少校验文件或存在多个全量包时跳过", () => {
  const legacy = "Codex-win-x64-26.930.61225.zip";
  assert.deepEqual(selectPreviousRelease([
    release("legacy", "2026-10-07", [legacy, "SHA256SUMS.txt"]),
  ], "current"), { tag: "legacy", zipName: legacy });
  assert.equal(selectPreviousRelease([
    release("missing-checksum", "2026-10-08", [legacy]),
    release("ambiguous", "2026-10-09", [legacy, "Codex-win-x64-26.930.61225-cli-0.160.1.zip", "SHA256SUMS.txt"]),
  ], "current"), null);
});

test("增量 ZIP 仅包含新增和变化文件，实际覆盖后与新版一致", async (context) => {
  const { root, baseline, current, out } = fixture(context);
  for (const dir of [baseline, current]) {
    write(dir, "ChatGPT.exe", "未变化的宿主");
    write(dir, "resources/unchanged.dll", "未变化的依赖");
  }
  write(baseline, "resources/codex.exe", "旧 CLI");
  write(current, "resources/codex.exe", "新 CLI");
  write(current, "resources/欢迎.txt", "新增文件");
  fs.mkdirSync(path.join(current, "new-empty-directory"));

  const result = await buildUpdate(baseline, current, out);
  assert.equal(result.zipName, "Codex-win-x64-26.1002.52244-cli-0.162.0-update-from-26.1002.52244-cli-0.161.0.zip");
  const unpacked = path.join(root, "unpacked");
  execFileSync("7zz", ["x", "-y", `-o${unpacked}`, path.join(out, result.zipName)], { stdio: "pipe" });
  const files = fs.readdirSync(unpacked, { recursive: true })
    .filter((name) => fs.statSync(path.join(unpacked, name)).isFile())
    .map((name) => name.split(path.sep).join("/")).sort();
  assert.deepEqual(files, ["build-info.json", "resources/codex.exe", "resources/欢迎.txt"]);
  assert.equal(fs.readFileSync(path.join(baseline, "resources/codex.exe"), "utf-8"), "新 CLI");
  assert.equal(fs.readFileSync(path.join(baseline, "ChatGPT.exe"), "utf-8"), "未变化的宿主");
  assert.ok(fs.statSync(path.join(baseline, "new-empty-directory")).isDirectory());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(baseline, "build-info.json"), "utf-8")),
    JSON.parse(fs.readFileSync(path.join(current, "build-info.json"), "utf-8")));
});

test("Windows 自带解压也能覆盖增量，包括中文和空格路径", { skip: process.platform !== "win32" }, async (context) => {
  const { root, baseline, current, out } = fixture(context);
  for (const dir of [baseline, current]) write(dir, "ChatGPT.exe", "未变化的宿主");
  write(baseline, "resources/中文 文件.txt", "旧内容");
  write(current, "resources/中文 文件.txt", "新内容");
  write(current, "resources/new.dll", "新增内容");
  const manualDir = path.join(root, "手动覆盖目录");
  for (const name of ["ChatGPT.exe", "build-info.json", "resources/中文 文件.txt"]) {
    write(manualDir, name, fs.readFileSync(path.join(baseline, name)));
  }
  const result = await buildUpdate(baseline, current, out);
  const command = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:UPDATE_TEST_ZIP -DestinationPath $env:UPDATE_TEST_DIR -Force";
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(command, "utf16le").toString("base64")], {
    stdio: "pipe",
    env: { ...process.env, UPDATE_TEST_ZIP: path.join(out, result.zipName), UPDATE_TEST_DIR: manualDir },
  });
  for (const name of ["ChatGPT.exe", "build-info.json", "resources/中文 文件.txt", "resources/new.dll"]) {
    assert.deepEqual(fs.readFileSync(path.join(manualDir, name)), fs.readFileSync(path.join(current, name)));
  }
});

test("删除旧文件或空目录时不生成无法手动覆盖的增量", async (context) => {
  const { baseline, current, out } = fixture(context);
  write(baseline, "resources/removed.dll", "旧文件");
  fs.mkdirSync(path.join(baseline, "removed-empty-directory"));
  const result = await buildUpdate(baseline, current, out);
  assert.equal(result.zipName, undefined);
  assert.match(result.reason, /删除或改变了 3 个文件\/目录/);
  assert.ok(fs.existsSync(path.join(baseline, "resources/removed.dll")));
  assert.equal(fs.existsSync(out), false);
});

test("文件与目录相互替换时仅提供全量包", async (context) => {
  const { baseline, current, out } = fixture(context);
  write(baseline, "changed-type", "原来是文件");
  fs.mkdirSync(path.join(current, "changed-type"));
  const result = await buildUpdate(baseline, current, out);
  assert.equal(result.zipName, undefined);
  assert.match(result.reason, /删除或改变/);
});

test("旧版缺少构建信息时仅提供全量包", async (context) => {
  const { baseline, current, out } = fixture(context);
  fs.rmSync(path.join(baseline, "build-info.json"));
  const result = await buildUpdate(baseline, current, out);
  assert.match(result.reason, /缺少 build-info/);
  assert.equal(fs.existsSync(out), false);
});

test("完全相同的两版无需生成增量", async (context) => {
  const { baseline, current, out } = fixture(context);
  fs.copyFileSync(path.join(baseline, "build-info.json"), path.join(current, "build-info.json"));
  const result = await buildUpdate(baseline, current, out);
  assert.match(result.reason, /完全相同/);
  assert.equal(fs.existsSync(out), false);
});

test("拒绝把非法构建版本写入增量文件名", async (context) => {
  const { baseline, current, out } = fixture(context);
  write(current, "build-info.json", JSON.stringify({ appVersion: "../../outside", codexCliVersion: "0.162.0" }));
  await assert.rejects(buildUpdate(baseline, current, out), /缺少有效/);
});

test("拒绝链接，避免覆盖验证与实际 Windows 文件不一致", async (context) => {
  const { baseline, current, out } = fixture(context);
  fs.mkdirSync(path.join(current, "real-directory"));
  fs.symlinkSync(path.join(current, "real-directory"), path.join(current, "linked-directory"),
    process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildUpdate(baseline, current, out), /不支持链接或特殊文件/);
});

test("下载包必须匹配校验表中的对应文件，缺失或篡改均拒绝", async (context) => {
  const { root } = fixture(context);
  const zip = path.join(root, "full.zip");
  const sums = path.join(root, "SHA256SUMS.txt");
  fs.writeFileSync(zip, "下载内容");
  const hash = crypto.createHash("sha256").update("下载内容").digest("hex");
  fs.writeFileSync(sums, `${"0".repeat(64)}  update.zip\r\n${hash} *full.zip\r\n`);
  await verifyChecksum(zip, sums);
  fs.writeFileSync(zip, "篡改内容");
  await assert.rejects(verifyChecksum(zip, sums), /SHA256 校验失败/);
  fs.writeFileSync(zip, "下载内容");
  fs.writeFileSync(sums, `${hash}  another.zip\n`);
  await assert.rejects(verifyChecksum(zip, sums), /SHA256 校验失败/);
});
