#!/usr/bin/env node
// 离线 Mermaid → SVG 渲染命令，基于构建期预装的 pele（无需联网）。
// 用法: pele-render <input.mmd|-> <output.svg>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("用法: pele-render <input.mmd|-> <output.svg>");
  process.exit(2);
}

const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
const { render } = createRequire(`${globalRoot}/`)("pele");

try {
  const source = readFileSync(input === "-" ? 0 : input, "utf8");
  const { svg } = render(source);
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`);
  console.log(target);
} catch (error) {
  console.error(`渲染失败: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
