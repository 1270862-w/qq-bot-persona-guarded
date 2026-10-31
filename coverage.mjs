#!/usr/bin/env node
/**
 * coverage.mjs —— 从 V8 覆盖率数据生成可复现的覆盖率摘要。
 *
 *   NODE_V8_COVERAGE=/tmp/cov node test-all.js
 *   node coverage.mjs /tmp/cov
 *
 * 说明：V8 只给"字节区间 + 执行次数"，所以这里报告的是
 *   · 行覆盖（用区间并集近似）
 *   · 函数覆盖
 *   · 未执行的分支块数量
 * 真正精确的行号覆盖需要 istanbul 之类，这里不引外部依赖。
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || process.env.NODE_V8_COVERAGE;
if (!dir || !fs.existsSync(dir)) {
  console.error('用法: node coverage.mjs <NODE_V8_COVERAGE 目录>');
  process.exit(1);
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
const byFile = new Map();   // url -> { ranges: [], funcs: [] }

for (const f of files) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  for (const s of data.result || []) {
    const url = s.url;
    if (!url.startsWith('file://')) continue;
    const p = url.replace('file://', '');
    if (!/\.(js|mjs)$/.test(p)) continue;
    if (p.includes('/node_modules/')) continue;
    if (!byFile.has(p)) byFile.set(p, { ranges: [], funcs: [] });
    const rec = byFile.get(p);
    for (const fn of s.functions || []) {
      rec.funcs.push(fn);
      for (const r of fn.ranges || []) rec.ranges.push(r);
    }
  }
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/** 每个行首取"包含它的最内层区间"的执行次数——这才是真实的行覆盖 */
function lineCoverage(src, ranges) {
  const starts = lineStarts(src);
  let covered = 0, executable = 0;
  for (let li = 0; li < starts.length; li++) {
    const off = starts[li];
    const lineText = src.slice(off, li + 1 < starts.length ? starts[li + 1] : src.length);
    if (!lineText.trim()) continue;                       // 空行不计
    executable++;
    let best = null;
    for (const r of ranges) {
      if (r.startOffset <= off && off < r.endOffset) {
        const span = r.endOffset - r.startOffset;
        if (!best || span < best.span) best = { span, count: r.count };
      }
    }
    if (best && best.count > 0) covered++;
  }
  return { covered, executable };
}

// 只看包内的源文件
const pkgDir = process.cwd();
const rows = [];
let sumTotal = 0, sumCov = 0, sumFn = 0, sumFnCov = 0, sumDeadBlocks = 0;

for (const [p, rec] of byFile) {
  if (!p.startsWith(pkgDir)) continue;
  const name = path.relative(pkgDir, p);
  // 只统计产品代码：测试脚本（test*.js / acceptance.js / coverage.mjs）不算在内
  if (/^(test|acceptance|coverage)/.test(name)) continue;

  const src = fs.readFileSync(p, 'utf8');
  const { covered, executable } = lineCoverage(src, rec.ranges);
  const pct = executable ? covered / executable * 100 : 0;

  const fnTotal = rec.funcs.length;
  const fnCov = rec.funcs.filter(fn => (fn.ranges || []).some(r => r.count > 0)).length;
  const dead = rec.ranges.filter(r => r.count === 0 && r.endOffset - r.startOffset > 0).length;

  rows.push({ name, pct, fnTotal, fnCov, dead, bytes: executable });
  sumTotal += executable; sumCov += covered; sumFn += fnTotal; sumFnCov += fnCov; sumDeadBlocks += dead;
}

rows.sort((a, b) => a.pct - b.pct);
console.log('\n覆盖率报告（V8，按文件）');
console.log('─'.repeat(72));
console.log('文件'.padEnd(22) + '行覆盖'.padStart(9) + '函数'.padStart(12) + '未执行块'.padStart(10));
console.log('─'.repeat(72));
for (const r of rows) {
  console.log(
    r.name.padEnd(22)
    + (r.pct.toFixed(1) + '%').padStart(9)
    + `${r.fnCov}/${r.fnTotal}`.padStart(12)
    + String(r.dead).padStart(10)
  );
}
console.log('─'.repeat(72));
const linePct = sumTotal ? (sumCov / sumTotal * 100) : 0;
const fnPct = sumFn ? (sumFnCov / sumFn * 100) : 0;
console.log(`总体：行覆盖 ${linePct.toFixed(1)}% ｜ 函数 ${sumFnCov}/${sumFn} (${fnPct.toFixed(1)}%) ｜ 未执行分支块 ${sumDeadBlocks}`);
console.log('─'.repeat(72) + '\n');

const out = {
  generatedAt: new Date().toISOString(),
  line: +linePct.toFixed(1),
  functions: { covered: sumFnCov, total: sumFn, pct: +fnPct.toFixed(1) },
  uncoveredBlocks: sumDeadBlocks,
  files: rows.map(r => ({ file: r.name, line: +r.pct.toFixed(1), fn: `${r.fnCov}/${r.fnTotal}`, dead: r.dead }))
};
fs.writeFileSync(path.join(pkgDir, 'coverage-summary.json'), JSON.stringify(out, null, 2));
console.log('已写出 coverage-summary.json');
