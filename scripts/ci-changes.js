const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

function needsCI(files) {
  return files.some((file) => !(/\.md$/i.test(file) || file.startsWith("docs/")));
}

function main() {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base.sha || event.before;
  let run = true;
  if (base && !/^0+$/.test(base)) {
    // 检出的是 PR 合并结果；与目标分支比较，删除和重命名也必须纳入判断。
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid base commit");
    execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "inherit" });
    const files = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    }).split("\0").filter(Boolean);
    run = needsCI(files);
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  console.log(run ? "运行完整检查" : "仅文档变更，跳过测试和构建");
}

if (require.main === module) main();
module.exports = { needsCI };
