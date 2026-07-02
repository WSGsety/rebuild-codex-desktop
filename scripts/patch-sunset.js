/**
 * Post-build patch: Disable appSunset forced-update gate
 *
 * Codex uses a Statsig gate to control version sunsetting.
 * When the gate returns true, a full-screen "Update Required" overlay blocks the UI.
 *
 * AST match: find functions containing the sunset i18n key "appSunset",
 * then locate gate checker calls identifier(`numericString`) within them,
 * and replace with !1 (false).
 *
 * Usage:
 *   node scripts/patch-sunset.js [platform]   # Apply patch (unix/win/omit=both)
 *   node scripts/patch-sunset.js --check      # Dry-run: report matches
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor, parent) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) {
          walk(item, visitor, node);
        }
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor, node);
    }
  }
}

// ──────────────────────────────────────────────
//  Patch rule
// ──────────────────────────────────────────────

// Structural markers for sunset functions (i18n keys present in the sunset UI)
const SUNSET_MARKERS = ["appSunset", "app.sunset", "sunset"];

function getLiteralValue(node) {
  if (!node) return null;
  if (node.type === "Literal") return node.value;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked;
  return null;
}

function collectPatches(ast, source) {
  const allPatches = [];

  walk(ast, (node) => {
    if (
      node.type !== "FunctionDeclaration" &&
      node.type !== "FunctionExpression" &&
      node.type !== "ArrowFunctionExpression"
    )
      return;

    const funcSrc = source.slice(node.start, node.end);
    // Structural match: function must contain a sunset-related i18n key
    if (!SUNSET_MARKERS.some((m) => funcSrc.includes(m))) return;

    // Within this function, find gate calls: identifier(`numericString`)
    walk(node, (child) => {
      if (child.type !== "CallExpression") return;
      if (child.callee?.type !== "Identifier") return;
      if (child.arguments?.length !== 1) return;

      const argVal = getLiteralValue(child.arguments[0]);
      if (!argVal || !/^\d{6,}$/.test(argVal)) return;

      const callSrc = source.slice(child.start, child.end);
      if (callSrc === "!1") return;

      if (!allPatches.some((x) => x.start === child.start)) {
        allPatches.push({
          start: child.start,
          end: child.end,
          replacement: "!1",
          original: callSrc,
        });
      }
    });
  });

  return allPatches;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const bundles = locateBundles({
    dir: "assets",
    pattern: /^index-.*\.js$/,
    platform,
  });

  if (bundles.length === 0) {
    console.error("[x] No index bundle found");
    process.exit(1);
  }

  for (const bundle of bundles) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);

    if (patches.length === 0) {
      if (!SUNSET_MARKERS.some((m) => source.includes(m))) {
        console.log("   [!] No sunset markers found in bundle");
      } else {
        console.log("   [ok] Sunset gate already disabled or no gate call found");
      }
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original} -> ${p.replacement}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original} -> ${p.replacement}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] Sunset gate disabled: ${patches.length} gate calls -> !1`);
  }
}

main();
