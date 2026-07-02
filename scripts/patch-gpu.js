#!/usr/bin/env node
/**
 * patch-gpu.js — Force high-performance GPU on Intel Mac (x64 only)
 *
 * Intel integrated GPUs have rendering bugs with certain DOM elements
 * in the Chromium compositor. This injects a Chromium switch to prefer
 * the discrete GPU, which resolves the rendering glitches.
 *
 * Only applies to mac-x64 builds. ARM Macs use unified memory / Apple GPU.
 *
 * Ref: https://github.com/Haleclipse/CodexDesktop-Rebuild/issues/39
 */
const fs = require("fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const SWITCH_NAME = "force_high_performance_gpu";
const INJECT_LINE = `require("electron").app.commandLine.appendSwitch("${SWITCH_NAME}");`;

function verifyElectronBootstrap(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: "script" });
  } catch {
    return false;
  }

  let found = false;
  (function walk(node) {
    if (!node || typeof node !== "object" || found) return;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const arg = node.arguments?.[0];
      const val =
        arg?.type === "Literal"
          ? arg.value
          : arg?.type === "TemplateLiteral" &&
              arg.quasis?.length === 1 &&
              arg.expressions?.length === 0
            ? arg.quasis[0].value?.cooked
            : null;
      if (val === "electron") found = true;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && v.type) walk(v);
    }
  })(ast);

  return found;
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  if (platform && platform !== "mac-x64") {
    console.log("  [skip] GPU patch only applies to mac-x64");
    return;
  }

  const bundles = locateBundles({
    dir: "build",
    pattern: /^bootstrap\.js$/,
    platform: "mac-x64",
  });

  if (bundles.length === 0) {
    console.log("  [skip] mac-x64 bootstrap.js not found");
    return;
  }

  let patched = 0;
  for (const bundle of bundles) {
    const code = fs.readFileSync(bundle.path, "utf-8");

    if (code.includes(SWITCH_NAME)) {
      console.log(`  [ok] ${relPath(bundle.path)}: already patched`);
      continue;
    }

    if (!verifyElectronBootstrap(code)) {
      console.log(
        `  [!] ${relPath(bundle.path)}: not an electron bootstrap, skipping`,
      );
      continue;
    }

    fs.writeFileSync(bundle.path, INJECT_LINE + "\n" + code);
    console.log(
      `  [ok] ${relPath(bundle.path)}: injected ${SWITCH_NAME}`,
    );
    patched++;
  }

  console.log(`  [done] ${patched} file(s) patched`);
}

main();
