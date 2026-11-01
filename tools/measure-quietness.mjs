#!/usr/bin/env node
/**
 * measure-quietness.mjs —— 用你自己的日志测量"这个机器人有多安静"
 *
 * 它做两件事：
 *   1. 从协议端日志里取出每一条真实群消息，逐条跑 rules.js 的打分
 *   2. 从机器人日志里统计实际触发/发送次数，作为对照
 *
 * 用法：
 *   node tools/measure-quietness.mjs                 # 读 ./logs
 *   node tools/measure-quietness.mjs /path/to/logs   # 指定日志目录
 *   node tools/measure-quietness.mjs --threshold 9   # 改判定阈值（默认读 config.json）
 *
 * 支持的日志（有哪个读哪个）：
 *   napcat*.log / *napcat*.log   协议端流水，用来取"收到的消息"
 *   server-*.log                 机器人流水，用来取 [HIT:] 与 [SENT:]
 *
 * 注意：这里只做纯文本打分，不含 @、图片加成、批量上下文，
 *      所以结果是"默默不说话"的下界，不是真实决策率。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { intentScore } from '../rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
let logDir = path.join(ROOT, 'logs');
let threshold = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--threshold' || args[i] === '-t') { threshold = Number(args[++i]); }
  else if (!args[i].startsWith('-')) { logDir = path.resolve(args[i]); }
}

if (!fs.existsSync(logDir)) {
  console.error('日志目录不存在: ' + logDir);
  console.error('用法: node tools/measure-quietness.mjs [日志目录] [--threshold N]');
  process.exit(2);
}

/* ---------- 配置 ---------- */
let cfg = {};
const cfgPath = path.join(ROOT, 'config.json');
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 没有就用默认 */ }
if (threshold == null) threshold = (cfg.intent && cfg.intent.threshold) || 10;
if (cfg.intent) cfg.intent = { ...cfg.intent, threshold };

/* ---------- 取文件 ---------- */
const all = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
const napFiles = all.filter((f) => /napcat/i.test(f));
const srvFiles = all.filter((f) => /^server-/.test(f));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/* ---------- 解析收到的消息 ---------- */
const msgs = [];
for (const f of napFiles) {
  const lines = strip(fs.readFileSync(path.join(logDir, f), 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    const m = /^(\d{2}-\d{2}) \d{2}:\d{2}:\d{2} \[info\][^|]*\| 接收 <- 群聊 \[([^\]]*?)\((\d+)\)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[4] || '';
    const who = /^\[([^\]]*?)\((\d+)\)\]\s*(.*)$/.exec(rest);
    const text = (who ? who[3] : rest).trim();
    if (text) msgs.push({ day: m[1], gid: m[3], text });
  }
}

/* ---------- 解析触发/发送 ---------- */
let hits = 0, sents = 0;
for (const f of srvFiles) {
  const t = strip(fs.readFileSync(path.join(logDir, f), 'utf8'));
  hits += (t.match(/\[HIT:/g) || []).length;
  sents += (t.match(/\[SENT:/g) || []).length;
}

if (!msgs.length && !hits) {
  console.error('没有可分析的日志。需要协议端日志（napcat*.log）或机器人日志（server-*.log）。');
  console.error('目录: ' + logDir);
  process.exit(1);
}

/* ---------- 打分 ---------- */
const buckets = [['负分', 0], ['0-2', 0], ['3-5', 0], ['6', 0], ['7-9', 0], ['≥10', 0]];
const bmap = new Map(buckets);
let sum = 0;
const scored = [];
for (const m of msgs) {
  const s = intentScore(cfg, m.text, { threshold }).score;
  sum += s;
  scored.push({ ...m, s });
  const k = s < 0 ? '负分' : s <= 2 ? '0-2' : s <= 5 ? '3-5' : s === 6 ? '6' : s <= 9 ? '7-9' : '≥10';
  bmap.set(k, bmap.get(k) + 1);
}

const total = msgs.length;
const days = [...new Set(msgs.map((m) => m.day))].sort();

/* ---------- 输出 ---------- */
console.log('');
console.log('安静的量化 · 用真实日志重放打分');
console.log('='.repeat(58));
console.log('  日志目录   : ' + logDir);
console.log('  协议端日志 : ' + (napFiles.join(', ') || '（无）'));
console.log('  机器人日志 : ' + (srvFiles.length ? srvFiles.length + ' 个 server-*.log' : '（无）'));
console.log('  阈值       : ' + threshold + (cfg.intent && cfg.intent._说明 ? '（config.intent.threshold）' : ''));
if (days.length) console.log('  时间跨度   : ' + days[0] + ' → ' + days[days.length - 1] + '（' + days.length + ' 天）');
console.log('');

if (total) {
  console.log('收到的消息 : ' + total + ' 条');
  console.log('');
  console.log('分数分布');
  const maxBar = 34;
  let maxV = 0;
  for (const [, v] of bmap) maxV = Math.max(maxV, v);
  for (const [k, v] of bmap) {
    const pct = (v / total * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.max(0, Math.round(v / maxV * maxBar)));
    console.log('  ' + k.padEnd(5) + String(v).padStart(6) + '  ' + pct + '%  ' + bar);
  }
  const over = scored.filter((x) => x.s >= threshold).length;
  console.log('');
  console.log('  平均分         : ' + (sum / total).toFixed(2));
  console.log('  单凭文本过阈值 : ' + over + ' 条（' + (over / total * 100).toFixed(1) + '%）');
  console.log('  → ' + (100 - over / total * 100).toFixed(1) + '% 的消息在调用模型之前就出局');
  console.log('');
  console.log('分数最高 5 条');
  scored.sort((a, b) => b.s - a.s);
  for (const x of scored.slice(0, 5)) console.log('  ' + String(x.s).padStart(4) + '  ' + x.text.slice(0, 40));
  console.log('分数最低 5 条');
  for (const x of scored.slice(-5)) console.log('  ' + String(x.s).padStart(4) + '  ' + x.text.slice(0, 40));
}

if (hits || sents) {
  console.log('');
  console.log('实际运行（有上下文的真实决策）');
  console.log('  触发 [HIT]  : ' + hits);
  console.log('  发出 [SENT] : ' + sents);
  if (total) {
    console.log('  触发率      : ' + (hits / total * 100).toFixed(2) + '%');
    console.log('');
    console.log('  纯文本打分与真实触发率的差距，来自 @、图片加成、批量上下文。');
    console.log('  前者是"默默不说话"的下界，后者才是实际行为。');
  }
}

console.log('');
console.log('='.repeat(58));
