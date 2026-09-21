#!/usr/bin/env node
/**
 * Post-sync patch: Disable MSIX "app contained core" mode
 *
 * 上游 26.915 起在 ASAR package.json 里新增 codexWindowsAppContainedCore="1"，
 * bootstrap 据此判定走"包内核心"模式，启动时调用原生 addon 的
 * getCurrentPackageFamily()（内部 GetCurrentPackageFullName）。
 * 该 API 只有 MSIX 安装的进程才有包标识，便携解包运行必然抛
 * 0x80073D54（中文系统提示"该进程没有程序包标识符"），随后 bootstrap
 * 捕获异常、销毁窗口并弹出致命错误框，应用完全无法启动。
 *
 * 将该字段置 "0" 后 LA() 判定失效，回到与旧版一致的 bundled core 模式
 * （使用 resources/codex.exe，即重打包时替换的官方 CLI）。
 *
 * Usage:
 *   node scripts/patch-contained-core.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-contained-core.js --check      # Dry-run: report status
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const FIELD = "codexWindowsAppContainedCore";

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "package.json"))
      );

  if (platforms.length === 0) {
    console.error("[x] No _asar/package.json found. Run sync-upstream first.");
    process.exit(1);
  }

  for (const plat of platforms) {
    const pkgPath = path.join(SRC_DIR, plat, "_asar", "package.json");
    console.log(`\n-- [${plat}] src/${plat}/_asar/package.json`);

    if (!fs.existsSync(pkgPath)) {
      console.log("   [skip] package.json not found");
      continue;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    if (!(FIELD in pkg)) {
      console.log(`   [ok] ${FIELD} absent; nothing to do`);
      continue;
    }
    if (pkg[FIELD] !== "1") {
      console.log(`   [ok] ${FIELD} already ${JSON.stringify(pkg[FIELD])}`);
      continue;
    }

    if (isCheck) {
      console.log(`   [?] ${FIELD}: "1" -> "0" (dry-run)`);
      continue;
    }

    pkg[FIELD] = "0";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    console.log(`   [ok] ${FIELD}: "1" -> "0" (app ${pkg.version})`);
  }
}

main();
