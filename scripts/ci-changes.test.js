const test = require("node:test");
const assert = require("node:assert/strict");
const { needsCI } = require("./ci-changes");

test("文档变更不运行重任务，混合和未知路径始终运行", () => {
  assert.equal(needsCI(["README.md", "scripts/STATSIG_GATES.md", "docs/example.png"]), false);
  for (const file of ["scripts/build-from-upstream.js", ".github/workflows/sync.yml", "package-lock.json", "new-file"]) {
    assert.equal(needsCI(["README.md", file]), true);
  }
  assert.equal(needsCI([]), false);
});
