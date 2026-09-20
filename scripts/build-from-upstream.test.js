const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  WINDOWS_CODEX_FILES,
  createWindowsZipName,
  parseWindowsApplicationExecutable,
  writeWindowsLauncher,
} = require("./build-from-upstream");

test("优先读取 Windows FullTrust 应用入口", () => {
  // Arrange
  const manifest = `
    <Package>
      <Applications>
        <Application Id="Background" Executable="background.exe" EntryPoint="Background.Task" />
        <Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication" />
      </Applications>
    </Package>`;

  // Act
  const executable = parseWindowsApplicationExecutable(manifest);

  // Assert
  assert.equal(executable, "app/ChatGPT.exe");
});

test("兼容只有 Codex.exe 的旧版清单", () => {
  // Arrange
  const manifest = `
    <Package>
      <Applications>
        <Application Id="App" Executable="app/Codex.exe" />
      </Applications>
    </Package>`;

  // Act
  const executable = parseWindowsApplicationExecutable(manifest);

  // Assert
  assert.equal(executable, "app/Codex.exe");
});

test("主入口与无界面辅助程序并存时取 Id=App 的入口", () => {
  // Arrange — 复刻上游 26.915.4065.0 新增 CodexCoreCommandRunner 后的清单结构
  const manifest = `
    <Package>
      <Applications>
        <Application Id="App" Executable="app/ChatGPT.exe" EntryPoint="Windows.FullTrustApplication">
          <uap:VisualElements DisplayName="ChatGPT" />
        </Application>
        <Application Id="CodexCoreCommandRunner" Executable="app/resources/codex-command-runner.exe" EntryPoint="Windows.FullTrustApplication">
          <uap:VisualElements DisplayName="ChatGPT Core command runner" AppListEntry="none" />
        </Application>
      </Applications>
    </Package>`;

  // Act
  const executable = parseWindowsApplicationExecutable(manifest);

  // Assert
  assert.equal(executable, "app/ChatGPT.exe");
});

test("拒绝无法确定唯一入口的清单", () => {
  // Arrange
  const manifest = `
    <Package>
      <Applications>
        <Application Id="One" Executable="app/One.exe" />
        <Application Id="Two" Executable="app/Two.exe" />
      </Applications>
    </Package>`;

  // Act / Assert
  assert.throws(
    () => parseWindowsApplicationExecutable(manifest),
    /Expected one Windows application executable, found 2/
  );
});

test("Windows 产物名只展示 App 版本", () => {
  // Arrange
  const appVersion = "26.707.31428";

  // Act
  const name = createWindowsZipName(appVersion);

  // Assert
  assert.equal(name, "Codex-win-x64-26.707.31428.zip");
});

test("官方 Windows CLI 包使用完整的四文件映射", () => {
  // Arrange
  const expected = [
    { source: ["bin", "codex.exe"], destination: "codex.exe" },
    { source: ["bin", "codex-code-mode-host.exe"], destination: "codex-code-mode-host.exe" },
    { source: ["codex-resources", "codex-command-runner.exe"], destination: "codex-command-runner.exe" },
    { source: ["codex-resources", "codex-windows-sandbox-setup.exe"], destination: "codex-windows-sandbox-setup.exe" },
  ];

  // Act
  const actual = WINDOWS_CODEX_FILES;

  // Assert
  assert.deepEqual(actual, expected);
});

test("旧版 Codex.exe 入口也生成统一启动脚本", (context) => {
  // Arrange
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-test-"));
  context.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

  // Act
  writeWindowsLauncher(outputDir, "Codex.exe");

  // Assert
  const launcher = fs.readFileSync(path.join(outputDir, "启动 Codex.cmd"), "utf-8");
  assert.equal(launcher, '@echo off\r\nstart "" "%~dp0Codex.exe" "codex://launch"\r\n');
});
