#!/usr/bin/env node
/**
 * test-all.js —— 一个入口跑完所有离线测试。
 *
 *   node test-all.js            全部离线套件
 *   node test-all.js --with-api 额外跑真接口套件（要 key、会花钱）
 *
 * 只做一件事：跑、汇总、给出一个总的退出码。
 */
'use strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const withApi = process.argv.includes('--with-api');

const SUITES = [
  ['test-rules.js', '规则单测', false],
  ['test-persona-file.js', '人格文件', false],
  ['test-intent.js', '语义触发', false],
  ['test.js', '单元/集成', false],
  ['test-resilience.js', '极端情况', false],
  ['test-memory-quality.js', '记忆质量', false],
  ['acceptance.js', '人话验收', false],
  ['test-soak-time.js', '90 天长跑', false],
  ['test-hard.js', '真接口/注入', true],
];

console.log('═'.repeat(60));
console.log('  QQ 机器人 · 测试总入口');
console.log('═'.repeat(60));

const rows = [];
let failed = 0;
for (const [file, label, needsApi] of SUITES) {
  if (!fs.existsSync(path.join(HERE, file))) { rows.push([label, file, '不存在'], 1); continue; }
  if (needsApi && !withApi) { rows.push([label, file, '跳过（加 --with-api）']); continue; }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: HERE, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const ms = Date.now() - t0;

  let summary = '完成';
  const m = out.match(/总计\s*(\d+)\s*项：通过\s*(\d+)，失败\s*(\d+)/)
    || out.match(/(\d+)\s*项通过[，\s]*(\d+)\s*项失败/)
    || out.match(/(\d+)\s*项通过\s*\/\s*(\d+)\s*项/);
  if (m) summary = m[0].replace(/\s+/g, ' ');
  else if (/全部通过/.test(out)) summary = '全部通过';

  const bad = r.status !== 0;
  if (bad) failed++;
  rows.push([label, file, summary + `（${ms}ms）`]);
  console.log(`\n${bad ? '✗' : '✓'} ${label} · ${file}  →  ${summary}`);
  if (bad) console.log(out.split('\n').filter(l => /失败|❌|•/.test(l)).slice(0, 8).join('\n'));
}

console.log('\n' + '─'.repeat(60));
for (const [a, b, c] of rows) console.log(`  ${a.padEnd(10, '　')} ${b.padEnd(24)} ${c}`);
console.log('─'.repeat(60));
console.log(failed ? `  ${failed} 个套件没通过` : '  全部套件通过 ✅');
console.log('─'.repeat(60));
process.exitCode = failed ? 1 : 0;
