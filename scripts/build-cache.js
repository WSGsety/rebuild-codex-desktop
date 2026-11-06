const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// 按内容而非 mtime 判断，避免 Git 检出和同大小文件修改导致错误复用。
function fingerprint(paths, context = "") {
  const hash = crypto.createHash("sha256").update(context);
  const buffer = Buffer.alloc(1024 * 1024);
  function visit(file, name) {
    const stat = fs.lstatSync(file);
    hash.update(JSON.stringify([name, stat.mode, stat.size, stat.isDirectory()]));
    if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(file));
    } else if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file).sort()) visit(path.join(file, entry), `${name}/${entry}`);
    } else {
      const fd = fs.openSync(file, "r");
      try {
        let bytes;
        while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  paths.forEach((file, index) => visit(file, String(index)));
  return hash.digest("hex");
}

function isBuildCurrent(stamp, input, artifact) {
  try {
    const saved = JSON.parse(fs.readFileSync(stamp, "utf8"));
    return saved.input === input && saved.artifact === fingerprint([artifact]);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

function saveBuild(stamp, input, artifact) {
  fs.writeFileSync(stamp, JSON.stringify({ input, artifact: fingerprint([artifact]) }) + "\n");
}

module.exports = { fingerprint, isBuildCurrent, saveBuild };
