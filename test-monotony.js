#!/usr/bin/env node
/**
 * test-monotony.js —— 人格单调性检测（需要 DEEPSEEK_API_KEY）
 *
 *   node test-monotony.js
 *
 * 连续 20 轮不同话题，统计：
 *   - 回复完全重复率
 *   - 开头 2 字多样性
 *   - 结尾 4 字多样性
 *   - 平均长度 / 语气词密度
 *   - 是否触发"裂缝"（逻辑提到白米饭时该有停顿）
 */
'use strict';
import fs from 'node:fs';
import { parsePersonaText } from './persona-file.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBrain } from './brain.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.DEEPSEEK_API_KEY || process.env.DSK || '';
if (!KEY) { console.log('需要 DEEPSEEK_API_KEY'); process.exit(0); }

const brain = makeBrain({
  provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: KEY,
  model: 'deepseek-flash', temperature: 0.95, maxTokens: 220, vision: false,
  extraBody: { thinking: { type: 'disabled' } }, search: { enabled: false }
}, () => {});

const prompts = [
  '早上好', '今天好累啊', '你觉得我该不该换个工作', '刚才那个方案失败了',
  '有人受伤了', '夸夸我', '你喜欢吃什么', '晚上一起打游戏吗',
  '我好焦虑', '你唱歌好听吗', '明天要考试', '我被骂了',
  '你怎么看加班', '陪我聊会儿天', '我失恋了', '周末去哪玩',
  '你累不累', '再说一句加油的话', '有人离开我们了', '最后说一句吧'
];

function stats(arr) {
  const uniq = new Set(arr);
  const heads = arr.map(s => s.replace(/\s/g, '').slice(0, 2));
  const tails = arr.map(s => s.replace(/\s/g, '').slice(-4));
  const lens = arr.map(s => [...s].length);
  return {
    重复率: ((1 - uniq.size / arr.length) * 100).toFixed(0) + '%',
    开头多样性: new Set(heads).size + '/' + arr.length,
    结尾多样性: new Set(tails).size + '/' + arr.length,
    平均长度: (lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0) + '字',
    语气词: arr.filter(s => /[呀哦呢]/.test(s)).length + '/' + arr.length,
    最像的一条: heads.filter(h => heads.filter(x => x === h).length > 1).slice(0, 3)
  };
}

const cfgMon = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const setMon = parsePersonaText(fs.readFileSync(path.join(HERE, cfgMon.personaFile), 'utf8'));
const MON_PERSONAS = [setMon.default, ...setMon.easter].filter(p => p && p.text);

for (const P of MON_PERSONAS) {
  const name = P.name || P.id;
  const persona = P.text;
  const out = [];
  console.log(`\n${'='.repeat(50)}\n${name}（${prompts.length} 轮）\n`);
  for (let i = 0; i < prompts.length; i++) {
    const r = await brain.reply({ persona, history: [], text: prompts[i], images: [] });
    out.push(r);
    console.log(`${String(i + 1).padStart(2)}. ${prompts[i]}  →  ${r.replace(/\n/g, ' ').slice(0, 60)}`);
  }
  console.log('\n统计：', JSON.stringify(stats(out), null, 1));
}
console.log('\n用量：', JSON.stringify(brain.stats()));
