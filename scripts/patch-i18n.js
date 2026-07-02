/**
 * Post-build patch: Force-enable i18n by bypassing Statsig cloud control
 *
 * Codex i18n is gated behind a Statsig layer field "enable_i18n".
 * The Statsig server can push enable_i18n=false to override the default.
 *
 * AST match: any .get("enable_i18n", <default>) call expression
 * (optionally wrapped in ChainExpression for ?.get), replaced with !0.
 *
 * Target files: any chunk containing "enable_i18n" (index-*.js, general-settings-*.js, app-main-*.js)
 *
 * Usage:
 *   node scripts/patch-i18n.js [platform]   # Apply (mac-arm64/mac-x64/win/omit=all)
 *   node scripts/patch-i18n.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

// ──────────────────────────────────────────────
//  AST walker
// ──────────────────────────────────────────────

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

// ──────────────────────────────────────────────
//  AST matching
// ──────────────────────────────────────────────

const FIELD_NAME = "enable_i18n";

/**
 * Find CallExpression (possibly wrapped in ChainExpression):
 *   X?.get("enable_i18n", <default>)
 *   X.get("enable_i18n", <default>)
 *
 * AST structural match — no hardcoded layer ID. The .get("enable_i18n", ...)
 * pattern on a MemberExpression is unique enough.
 *
 * Replace the outermost expression (ChainExpression or CallExpression) with !0.
 */
function collectPatches(ast, source) {
  const patches = [];
  const seen = new Set();

  walk(ast, (node) => {
    let callNode = null;
    let replaceNode = null;

    // Match ChainExpression wrapping a CallExpression
    if (node.type === "ChainExpression" && node.expression?.type === "CallExpression") {
      callNode = node.expression;
      replaceNode = node;
    } else if (node.type === "CallExpression") {
      callNode = node;
      replaceNode = node;
    }

    if (!callNode) return;

    // Callee must be MemberExpression with property "get"
    const callee = callNode.callee;
    if (!callee || callee.type !== "MemberExpression") return;
    const prop = callee.property;
    if (!prop) return;
    const propName = prop.type === "Identifier" ? prop.name
      : prop.type === "Literal" ? prop.value : null;
    if (propName !== "get") return;

    // First argument must be string literal "enable_i18n"
    const args = callNode.arguments;
    if (!args || args.length < 2) return;
    const firstArg = args[0];
    const argValue = firstArg.type === "Literal" ? firstArg.value
      : (firstArg.type === "TemplateLiteral" && firstArg.expressions.length === 0
        && firstArg.quasis.length === 1) ? firstArg.quasis[0].value.cooked
      : null;
    if (argValue !== FIELD_NAME) return;

    // Already patched?
    const exprSrc = source.slice(replaceNode.start, replaceNode.end);
    if (exprSrc === "!0") return;

    // Dedup
    if (seen.has(replaceNode.start)) return;
    seen.add(replaceNode.start);

    patches.push({
      start: replaceNode.start,
      end: replaceNode.end,
      replacement: "!0",
      original: exprSrc,
    });
  });

  return patches;
}

// ──────────────────────────────────────────────
//  Bundle location: scan all JS chunks for enable_i18n
// ──────────────────────────────────────────────

function locateTargets(platform) {
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets"))
      );

  const targets = [];
  for (const plat of platforms) {
    // Check index-*.js
    const indexBundles = locateBundles({ dir: "assets", pattern: /^index-.*\.js$/, platform: plat });
    for (const b of indexBundles) {
      const src = fs.readFileSync(b.path, "utf-8");
      if (src.includes(FIELD_NAME)) {
        targets.push(b);
      }
    }

    // Check other chunks (general-settings-*.js, app-main-*.js, etc.)
    const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
    if (!fs.existsSync(assetsDir)) continue;
    for (const f of fs.readdirSync(assetsDir)) {
      if (!f.endsWith(".js") || f.startsWith("index-")) continue;
      const fp = path.join(assetsDir, f);
      const src = fs.readFileSync(fp, "utf-8");
      if (src.includes(FIELD_NAME)) {
        targets.push({ platform: plat, path: fp });
      }
    }
  }

  return targets;
}

// ──────────────────────────────────────────────
//  Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));

  const targets = locateTargets(platform);

  if (targets.length === 0) {
    console.log("[ok] No files contain enable_i18n (upstream may have removed gate)");
    return;
  }

  let grandTotal = 0;

  for (const bundle of targets) {
    console.log(`\n-- [${bundle.platform}] ${relPath(bundle.path)}`);
    const source = fs.readFileSync(bundle.path, "utf-8");
    console.log(`   size: ${(source.length / 1024 / 1024).toFixed(1)} MB`);

    const t0 = Date.now();
    const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    console.log(`   parse: ${Date.now() - t0}ms`);

    const patches = collectPatches(ast, source);
    grandTotal += patches.length;

    if (patches.length === 0) {
      console.log("   [ok] enable_i18n already bypassed or no AST match");
      continue;
    }

    if (isCheck) {
      console.log(`   [?] Matches: ${patches.length}`);
      for (const p of patches) {
        console.log(`     > offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`   * offset ${p.start}: ${p.original.slice(0, 60)} -> !0`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    console.log(`   [ok] i18n gate bypassed: ${patches.length} replacements`);
  }

  if (isCheck && grandTotal > 0) {
    console.log(`\n=> Total: ${grandTotal} patchable locations`);
  }
}

main();
