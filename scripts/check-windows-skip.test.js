const test = require("node:test");
const assert = require("node:assert/strict");
const { releaseVersions, evaluateSkip } = require("./check-windows-skip");

// 与发布步骤生成的说明格式保持一致
const REAL_BODY = "基于 Microsoft Store Windows x64 安装包 26.915.4065.0 重新打包，App 版本为 26.915.31945。下载 ZIP 并解压后，运行“ChatGPT.exe”即可使用。 <!-- codex-cli-version:0.155.1 -->";

test("从旧版说明正文中解析 MSIX 与 CLI 版本", () => {
  // Arrange / Act
  const versions = releaseVersions(REAL_BODY);

  // Assert
  assert.deepEqual(versions, { msix: "26.915.4065.0", cli: "0.155.1" });
});

test("优先读取新版 msix-version 标记", () => {
  // Arrange
  const body = "重新打包说明 <!-- codex-cli-version:0.155.1 --><!-- msix-version:26.920.1.1 -->";

  // Act
  const versions = releaseVersions(body);

  // Assert
  assert.deepEqual(versions, { msix: "26.920.1.1", cli: "0.155.1" });
});

test("MSIX 未变且 CLI 未变时跳过", () => {
  // Arrange
  const releases = [{ body: REAL_BODY, assets: [{ name: "a.zip" }, { name: "SHA256SUMS.txt" }] }];

  // Act / Assert
  assert.equal(evaluateSkip(releases, "26.915.4065.0", "0.155.1"), true);
});

test("商店新版本出现时不跳过", () => {
  // Arrange
  const releases = [{ body: REAL_BODY, assets: [{}, {}] }];

  // Act / Assert
  assert.equal(evaluateSkip(releases, "26.920.10.1", "0.155.1"), false);
});

test("CLI 升级时不跳过", () => {
  // Arrange
  const releases = [{ body: REAL_BODY, assets: [{}, {}] }];

  // Act / Assert
  assert.equal(evaluateSkip(releases, "26.915.4065.0", "0.156.0"), false);
});

test("缺少 CLI 标记的远古 Release 不参与匹配", () => {
  // Arrange
  const releases = [{ body: "某个早期版本说明", assets: [{}, {}] }];

  // Act / Assert
  assert.equal(evaluateSkip(releases, "26.915.4065.0", "0.155.1"), false);
  assert.equal(releaseVersions("某个早期版本说明"), null);
});

test("资产被删空的 Release 不视为已发布完整", () => {
  // Arrange
  const releases = [{ body: REAL_BODY, assets: [] }];

  // Act / Assert
  assert.equal(evaluateSkip(releases, "26.915.4065.0", "0.155.1"), false);
});
