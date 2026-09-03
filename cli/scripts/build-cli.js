#!/usr/bin/env node

/**
 * build-cli:把仓库的服务端源码(app/server + app/www)汇集到 cli/app/,随 npm 包发布。
 * 用法: npm run build (在 cli/ 目录)
 */
const fs = require("fs");
const path = require("path");

const pkgRoot = path.join(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "..");
const appDir = path.join(pkgRoot, "app");

const FILES = [];                       // server/ 与 www/ 整目录拷贝
const TREES = [
  ["server", "server"],
  ["www", "www"],
];
const SKIP = new Set(["__pycache__", ".pyc"]);

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name) || name.endsWith(".pyc")) continue;
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log(`[build-cli] 清理 ${appDir}`);
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

for (const [srcRel, destRel] of TREES) {
  const src = path.join(repoRoot, srcRel);
  if (!fs.existsSync(src)) {
    console.warn(`[build-cli] 跳过不存在的目录: ${srcRel}`);
    continue;
  }
  copyTree(src, path.join(appDir, destRel));
}
for (const f of FILES) {
  const src = path.join(repoRoot, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(appDir, f));
}

// 附 LICENSE 供 npm 包展示
const licSrc = path.join(repoRoot, "LICENSE");
if (fs.existsSync(licSrc)) fs.copyFileSync(licSrc, path.join(pkgRoot, "LICENSE"));

const count = (function walk(p) {
  let n = 0;
  for (const name of fs.readdirSync(p)) {
    const full = path.join(p, name);
    if (fs.statSync(full).isDirectory()) n += walk(full);
    else n += 1;
  }
  return n;
})(appDir);

console.log(`[build-cli] 服务端源码就绪: ${appDir} (${count} 个文件)`);
