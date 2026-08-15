const test = require("node:test");
const assert = require("node:assert/strict");
const { getWindowsVersion } = require("./sync-upstream");

function createMsstore(overrides = {}) {
  return {
    getCookie: async () => "cookie",
    getAppInfo: async () => ({ categoryId: "category" }),
    getFileList: async () => [
      {
        name: "OpenAI.Codex_26.810.6296.0_x64__2p2nqsd0c76g0.msix",
        updateID: "update-id",
        revisionNumber: "1",
        digest: "digest",
      },
    ],
    getDownloadUrl: async () => "https://example.test/codex.msix",
    ...overrides,
  };
}

test("Windows 元数据请求超时后重新获取完整链路", async () => {
  // Arrange
  let cookieAttempts = 0;
  const msstore = createMsstore({
    getCookie: async () => {
      cookieAttempts++;
      if (cookieAttempts === 1) throw new Error("Request timeout");
      return "cookie";
    },
  });

  // Act
  const result = await getWindowsVersion({
    msstore,
    retryDelays: [0],
    wait: async () => {},
    logRetry: () => {},
  });

  // Assert
  assert.equal(cookieAttempts, 2);
  assert.equal(result.version, "26.810.6296.0");
  assert.equal(result.url, "https://example.test/codex.msix");
});

test("Windows 下载 URL 为空时重新获取完整链路", async () => {
  // Arrange
  let cookieAttempts = 0;
  let urlAttempts = 0;
  const msstore = createMsstore({
    getCookie: async () => {
      cookieAttempts++;
      return "cookie";
    },
    getDownloadUrl: async () => {
      urlAttempts++;
      return urlAttempts === 1 ? "" : "http://example.test/codex.msix";
    },
  });

  // Act
  const result = await getWindowsVersion({
    msstore,
    retryDelays: [0],
    wait: async () => {},
    logRetry: () => {},
  });

  // Assert
  assert.equal(cookieAttempts, 2);
  assert.equal(urlAttempts, 2);
  assert.equal(result.url, "http://example.test/codex.msix");
});

test("Windows 下载 URL 持续为空时给出明确错误", async () => {
  // Arrange
  let attempts = 0;
  const msstore = createMsstore({
    getDownloadUrl: async () => {
      attempts++;
      return "";
    },
  });

  // Act / Assert
  await assert.rejects(
    getWindowsVersion({
      msstore,
      retryDelays: [0, 0],
      wait: async () => {},
      logRetry: () => {},
    }),
    /Windows metadata failed after 3 attempts: Windows download URL unavailable for OpenAI\.Codex_26\.810\.6296\.0_x64__2p2nqsd0c76g0\.msix/
  );
  assert.equal(attempts, 3);
});
