#!/usr/bin/env node
/**
 * test-memory-quality.js —— 长期记忆"质量"基准（不是容量基准）
 *
 * 之前的压测只回答"存得下几条"，回答不了"该想起的那条能不能想起来"。
 * 这个脚本用带标注的数据集算 recall@k / MRR，并单测三件事：
 *   ① 近义干扰项能不能区分
 *   ② 时间衰减真的在起作用吗
 *   ③ 过时事实会不会被新事实压过去
 *
 *   node test-memory-quality.js
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroupMemory } from './memory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GID = 9001;

/** 带标注的数据集：5 个话题簇，每簇含近义干扰项 */
const FACTS = [
  // 开黑
  ['老王每周四晚上固定开黑', ['开黑', '周四']],
  ['老王周五一般不玩', ['开黑', '周五']],
  ['开黑时间最近改到十点半', ['开黑', '时间']],
  ['开黑都在那个语音频道', ['开黑', '频道']],
  // 吃饭
  ['小美一点辣都不吃', ['吃', '小美辣']],
  ['小美不吃香菜', ['吃', '小美香菜']],
  ['中午大家常点黄焖鸡', ['吃', '中午']],
  ['楼下新开了家面馆', ['吃', '面馆']],
  // 宠物
  ['小美养了只猫叫团子', ['宠物', '团子']],
  ['阿强养了条狗叫豆豆', ['宠物', '豆豆']],
  ['团子特别怕生', ['宠物', '团子怕生']],
  ['豆豆爱吃骨头', ['宠物', '豆豆骨头']],
  // 绰号黑话
  ['老王是群主', ['绰号', '群主']],
  ['小美是美工', ['绰号', '美工']],
  ['退群的黑话叫毕业', ['黑话', '退群']],
  ['发红包叫撒币', ['黑话', '红包']],
];

/** 查询 → 期望命中的事实（包含任一即算对） */
const QUERIES = [
  ['周四有人开黑吗', ['老王每周四晚上固定开黑']],
  ['周五打不打', ['老王周五一般不玩']],
  ['开黑几点开始', ['开黑时间最近改到十点半']],
  ['小美吃辣吗', ['小美一点辣都不吃']],
  ['小美吃香菜吗', ['小美不吃香菜']],
  ['团子是谁', ['小美养了只猫叫团子', '团子特别怕生']],
  ['豆豆是谁', ['阿强养了条狗叫豆豆', '豆豆爱吃骨头']],
  ['团子怕人吗', ['团子特别怕生']],
  ['谁是群主', ['老王是群主']],
  ['退群怎么说', ['退群的黑话叫毕业']],
  ['红包怎么叫', ['发红包叫撒币']],
  ['楼下有什么吃的', ['楼下新开了家面馆']],
  ['中午吃什么', ['中午大家常点黄焖鸡']],
  ['豆豆吃什么', ['豆豆爱吃骨头']],
  ['小美是做什么的', ['小美是美工']],
  ['开黑在哪', ['开黑都在那个语音频道']],
  // —— 难例：改写、指代、不给原词 ——
  ['那个双排的活动一般哪天', ['老王每周四晚上固定开黑']],
  ['她一点辣的都不碰对吧', ['小美一点辣都不吃']],
  ['那两只小动物分别是谁的', ['小美养了只猫叫团子', '阿强养了条狗叫豆豆']],
  ['换个群要怎么说', ['退群的黑话叫毕业']],
  ['群里的老资格是谁', ['老王是群主']],
];

function newMem(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-'));
  return new GroupMemory(dir, { maxFacts: 120, recallK: 5, ...over });
}

function seed(m, aging = {}) {
  const now = Date.now();
  const DAY = 86400000;
  for (const [text, tags] of FACTS) {
    m.addFact(GID, text, 'seed');
    const f = m.load(GID).facts.find(x => x.text === text);
    if (f) f.ts = now - (aging[tags[0]] || 0) * DAY;   // 按簇设置年龄
  }
  m.save(GID);
}

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? '  — ' + d : '')); } };

/* ---------- ① 召回质量：recall@5 / MRR ---------- */
console.log('\n① 召回质量（16 个查询，含近义干扰项）');
{
  const m = newMem();
  seed(m);
  let hit = 0, rr = 0;
  for (const [q, expect] of QUERIES) {
    const r = m.recall(GID, q, 5).map(f => f.text);
    const rank = r.findIndex(t => expect.includes(t));
    if (rank >= 0) { hit++; rr += 1 / (rank + 1); }
    else console.log(`     未命中：「${q}」→ ${r.slice(0, 3).join(' / ') || '（空）'}`);
  }
  const recall = hit / QUERIES.length;
  const mrr = rr / QUERIES.length;
  console.log(`     recall@5 = ${(recall * 100).toFixed(1)}%   MRR = ${mrr.toFixed(3)}`);
  ok(recall >= 0.85, '召回率 ≥ 85%', (recall * 100).toFixed(1) + '%');
  ok(mrr >= 0.7, 'MRR ≥ 0.70（正确条目平均排在前 1.4 位）', mrr.toFixed(3));
}

/* ---------- ② 时间衰减 ---------- */
console.log('\n② 时间衰减（同一批事实，越老越难被想起）');
{
  // 两条事实与查询同等相关，只有年龄不同 → 新的必须排在前面
  const m = newMem();
  const DAY = 86400000;
  m.addFact(GID, '团子特别怕生', 'x');
  m.load(GID).facts[0].ts = Date.now() - 365 * DAY;
  m.addFact(GID, '团子爱吃小黄鱼', 'x');
  m.load(GID).facts[1].ts = Date.now() - 1 * DAY;
  m.save(GID);
  const top = m.recall(GID, '团子', 5).map(f => f.text);
  const iNew = top.indexOf('团子爱吃小黄鱼');
  const iOld = top.indexOf('团子特别怕生');
  console.log(`     新事实第 ${iNew + 1} 位，一年前的旧事实第 ${iOld < 0 ? '未召回' : iOld + 1} 位`);
  ok(iNew === 0, '同等相关时，新事实排第一', '实际第 ' + (iNew + 1) + ' 位');
  ok(iOld < 0 || iOld > iNew, '一年前的旧事实排在后面', '旧事实第 ' + (iOld + 1) + ' 位');
}

/* ---------- ③ 过时事实 ---------- */
console.log('\n③ 过时事实（约定改了以后，新的要压过旧的）');
{
  const m = newMem();
  m.addFact(GID, '开黑时间定在周四晚上八点', 'x');
  const old = m.load(GID).facts[0];
  old.ts = Date.now() - 30 * 86400000;
  m.addFact(GID, '开黑时间改成周五晚上九点', 'x');
  m.save(GID);
  const top = m.recall(GID, '开黑时间几点', 3).map(f => f.text);
  ok(top[0] && top[0].includes('周五'), '新约定排在旧约定前面', top.slice(0, 2).join(' / '));
}

/* ---------- ④ 强化：反复用到的事实更容易被想起 ---------- */
console.log('\n④ 强化（被反复召回的记忆权重上升）');
{
  const m = newMem();
  seed(m);
  const q = '楼下那家面馆怎么样';
  const before = m.recall(GID, q, 8).map(f => f.text).indexOf('楼下新开了家面馆');
  for (let i = 0; i < 3; i++) m.prompt(GID, q);
  const facts = m.load(GID).facts;
  const f = facts.find(x => x.text === '楼下新开了家面馆');
  ok((f.hits || 0) >= 1, '被召回的事实计数增加了', 'hits=' + (f.hits || 0));
  const after = m.recall(GID, q, 8).map(x => x.text).indexOf('楼下新开了家面馆');
  ok(after >= 0 && after <= 4, '强化后能稳定进前 5', `前 ${before < 0 ? '未进前8' : before + 1} 后 ${after + 1}`);
}

/* ---------- ⑤ 不该召回的不召回 ---------- */
console.log('\n⑤ 精确性（无关话题不硬塞）');
{
  const m = newMem();
  seed(m);
  const r = m.recall(GID, '今天天气真不错', 10);
  ok(r.length <= 5, '无关话题最多回 5 条', '实际 ' + r.length);
  ok(!r.some(f => f.text.includes('团子') || f.text.includes('黄焖鸡')), '无关话题不塞具体记忆');
}

/* ---------- ⑥ 同义词召回 ---------- */
console.log('\n⑥ 同义词（配置里的 aliases 把别名映射到标准说法）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-'));
  const m = new GroupMemory(dir, { maxFacts: 120, recallK: 5, aliases: { 双排: '开黑', 上分: '开黑' } });
  m.addFact(GID, '老王每周四晚上固定开黑', 'seed');
  const r = m.recall(GID, '那个双排的活动一般哪天', 5).map(f => f.text);
  ok(r.some(t => t.includes('开黑')), '别名「双排」能召回「开黑」相关记忆', r[0] || '（空）');
}

console.log('\n' + '─'.repeat(52));
console.log(`  ${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
