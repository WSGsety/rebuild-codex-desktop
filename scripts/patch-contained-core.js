#!/usr/bin/env node
/**
 * Post-sync patch: Make MSIX package-identity probing safe for portable builds
 *
 * 上游 26.915 起在 ASAR package.json 里新增 codexWindowsAppContainedCore="1"，
 * bootstrap 据此判定走"包内核心"模式，启动时调用原生 addon 的
 * getCurrentPackageFamily()（内部 GetCurrentPackageFullName）。
 * 该 API 只有 MSIX 安装的进程才有包标识，便携解包运行必然抛
 * 0x80073D54（中文系统提示"该进程没有程序包标识符"），随后 bootstrap
 * 捕获异常、销毁窗口并弹出致命错误框，应用完全无法启动。
 *
 * Rule A（.vite/build bundles）: 把所有 getCurrentPackageFamily() 调用包上
 * try/catch 壳，抛错时返回 ""（调用方守卫把空串当"不可用"）。这样即使
 * 保留"包内核心"模式（字段为 "1"），启动也不会被无包标识打断。
 * 写回前用 node --check 做语法守门，patch 出错不允许落盘。
 *
 * Rule B（package.json）: 把 codexWindowsAppContainedCore 置 "0"，强制回到
 * 与旧版一致的 bundled core 模式（resources/codex.exe，即重打包替换的
 * 官方 CLI）。当前 CI 默认走 Rule B；Rule A 为尝试 app-package 模式
 * （行为最接近官方 MSIX）留好了安全底座。
 *
 * Usage:
 *   node scripts/patch-contained-core.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-contained-core.js --check      # Dry-run: report status
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SRC_DIR = path.join(__dirname, "..", "src");
const FIELD = "codexWindowsAppContainedCore";
const CALL = ".getCurrentPackageFamily()";

// 从调用点向前扫完整接收者链（含 `this.options.x`、`OT()?.` 可选链、
// 平衡的括号如 `foo()`），返回接收者起始下标。
function receiverStart(code, idx) {
  let i = idx;
  while (i > 0) {
    const c = code[i - 1];
    if (c === ")") {
      let depth = 0, j = i - 1;
      while (j >= 0) {
        if (code[j] === ")") depth++;
        else if (code[j] === "(") { depth--; if (depth === 0) break; }
        j--;
      }
      if (j < 0) return idx;
      i = j;
      continue;
    }
    if (/[\w$.?]/.test(c)) { i--; continue; }
    break;
  }
  return i;
}

function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function ruleAWrapBundles(plat, isCheck) {
  const buildDir = path.join(SRC_DIR, plat, "_asar", ".vite", "build");
  if (!fs.existsSync(buildDir)) return;
  for (const f of fs.readdirSync(buildDir)) {
    if (!f.endsWith(".js")) continue;
    const p = path.join(buildDir, f);
    const code = fs.readFileSync(p, "utf-8");
    if (!code.includes(CALL)) continue;

    const edits = [];
    let idx = code.indexOf(CALL);
    while (idx !== -1) {
      const start = receiverStart(code, idx);
      const receiver = code.slice(start, idx);
      const alreadyWrapped = code.slice(Math.max(0, start - 12), start).endsWith("try{return ");
      const valid = receiver && /^[A-Za-z_$][\w$?.]*$/.test(receiver.replace(/\([^()]*\)/g, ""));
      if (alreadyWrapped) {
        // 上一轮已加壳，跳过
      } else if (valid) {
        edits.push({ start, end: idx + CALL.length, receiver });
      } else {
        console.warn(`   [!] 无法解析接收者，跳过一处调用: ${JSON.stringify(receiver.slice(0, 40))}`);
      }
      idx = code.indexOf(CALL, idx + 1);
    }
    if (edits.length === 0) continue;

    let out = "";
    let cursor = 0;
    for (const e of edits) {
      out += code.slice(cursor, e.start);
      out += `((()=>{try{return ${e.receiver}${CALL}}catch{return ""}})())`;
      cursor = e.end;
    }
    out += code.slice(cursor);

    if (isCheck) {
      console.log(`   [wrap] .vite/build/${f}: ${edits.length} 处调用待加壳 (dry-run)`);
      continue;
    }

    const tmp = `${p}.patch-tmp.js`;
    fs.writeFileSync(tmp, out, "utf-8");
    if (!syntaxOk(tmp)) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Rule A 产生了语法错误的输出: .vite/build/${f}，已放弃写入`);
    }
    fs.renameSync(tmp, p);
    console.log(`   [wrap] .vite/build/${f}: ${edits.length} 处 getCurrentPackageFamily 调用已加壳`);
  }
}

function ruleBDisableContainedCore(plat, isCheck) {
  const pkgPath = path.join(SRC_DIR, plat, "_asar", "package.json");
  console.log(`\n-- [${plat}] src/${plat}/_asar/package.json`);

  if (!fs.existsSync(pkgPath)) {
    console.log("   [skip] package.json not found");
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  if (!(FIELD in pkg)) {
    console.log(`   [ok] ${FIELD} absent; nothing to do`);
    return;
  }
  if (pkg[FIELD] !== "1") {
    console.log(`   [ok] ${FIELD} already ${JSON.stringify(pkg[FIELD])}`);
    return;
  }

  if (isCheck) {
    console.log(`   [?] ${FIELD}: "1" -> "0" (dry-run)`);
    return;
  }

  pkg[FIELD] = "0";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  console.log(`   [ok] ${FIELD}: "1" -> "0" (app ${pkg.version})`);
}

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
    console.log(`\n-- [${plat}] Rule A: package identity 探测加壳`);
    ruleAWrapBundles(plat, isCheck);
    ruleBDisableContainedCore(plat, isCheck);
  }
}

main();
