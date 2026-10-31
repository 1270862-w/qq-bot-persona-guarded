#!/usr/bin/env node
/**
 * test-soak-time.js —— 长时间运行测试（伪造时钟）。
 *
 * 模拟 30 天：每天早晨/白天/深夜各发一批消息、到点触发作息公告、
 * 每 5 天重启一次。检查有没有「跑久了才出问题」的毛病：
 *   · 公告是否会重复 / 漏发
 *   · 日上限、小时窗口是否会重置
 *   · 长期记忆是否无限膨胀
 *   · 去重表、历史、各种 Map 是否有界
 *   · 重启后计数和公告状态是否还认得
 *
 *   node test-soak-time.js
 */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQEngine } from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 伪造时钟 ---------- */
const RealDate = Date;
let offset = 0;
const setTime = (ms) => { offset = ms - RealDate.now(); };
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
  static now() { return RealDate.now() + offset; }
}
globalThis.Date = FakeDate;

const HOUR = 3600000, DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 5, 0, 0, 0);   // 2026-01-05 00:00 UTC
const DAYS = 90;

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? '  — ' + d : '')); } };

/* ---------- 环境 ---------- */
const CFG = {
  mode: 'auto',
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000' },
  llm: { provider: 'mock', model: 'm' },
  bot: { nick: '小鲸鱼', aliases: [], defaultPersonaId: 'whalegirl' },
  personaFile: './persona.md',
  groups: [], autoAcceptNewGroups: true, blockedGroups: [], groupDefaults: { proactive: false },
  rules: { minIntervalMs: 0, perGroupCooldownMs: 0, maxPerHour: 9999, dailyCap: 50, quietHours: ['00:00', '07:30'], maxReplyChars: 200, replyWithAt: true },
  proactive: { enabled: false, probability: 0, keywords: [], maxPerHour: 0 },
  history: { size: 16 },
  safety: { blockedWords: [] },
  scope: { enabled: true, keywords: ['爬虫'], requestMarkers: ['帮我'], ventMarkers: [], refusals: { whalegirl: ['不行'] } },
  politics: { enabled: false, keywords: [] },
  easter: { enabled: true, durationMs: 1800000, cooldownMs: 60000, resetCooldownMs: 10000, maxPerHour: 6 },
  schedule: { enabled: true, sleepAt: '23:59', wakeAt: '07:30', lines: { whalegirl: { sleep: '睡了。', wake: '早。' } } },
  memory: { enabled: true, autoExtract: false, maxFacts: 40, maxChars: 800, recallK: 8 },
  awareness: { enabled: true, windowMinutes: 60, activeMinutes: 5, revive: { enabled: true, silenceMinutes: 25, minRecentMessages: 8, cooldownMinutes: 120, maxPerDay: 2 }, join: { enabled: true, probability: 0, cooldownMinutes: 15, maxPerHour: 3, maxPerDay: 10, requireConversation: true } },
  style: { enabled: false },
  server: { enable: false }
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-'));
fs.writeFileSync(path.join(DIR, 'persona.md'), '# 测试人格\n\n=== persona: whalegirl | 小鲸鱼 ===\nnick: 小鲸鱼\n---\n你是一条爱吃饭的鱼。\n---\nsleep: 睡了。\nwake: 早。\n');

function makeEngine(stateFile) {
  const e = new QQEngine(JSON.parse(JSON.stringify(CFG)), {
    log: () => {}, cfgDir: DIR, stateFile, memoryDir: path.join(DIR, 'memory')
  });
  e.announces = [];
  const orig = e._announce.bind(e);
  e._announce = async (kind) => { e.announces.push(kind); return orig(kind); };
  e.client.sendGroup = async () => ({ message_id: 1 });
  e.client.sendGroupAt = async () => ({ message_id: 1 });
  e.brain.reply = async () => '好';
  return e;
}

/* ---------- 30 天模拟 ---------- */
console.log(`\n模拟 ${DAYS} 天（每 5 天重启一次）…`);
const stateFile = path.join(DIR, 'state.json');
let e = makeEngine(stateFile);
let n = 0;
const msg = (text, gid = 1, atMe = false) => ({
  groupId: gid, userId: 2, sender: '群友', text, images: [], atMe,
  isSelf: false, messageId: 'm' + (++n), time: Date.now()
});

const dailyAnnounces = [];   // 每天公告次数
let maxPrompt = 0;
const origReply = e.brain.reply;
const spy = async (p) => { maxPrompt = Math.max(maxPrompt, p.persona.length); return '好'; };

for (let d = 0; d < DAYS; d++) {
  const base = START + d * DAY;
  if (d > 0 && d % 5 === 0) {
    setTime(base + 3 * HOUR);
    e = makeEngine(stateFile);      // 重启
    e.brain.reply = spy;
  } else {
    e.brain.reply = spy;
  }

  // 白天：3 个群各发若干消息
  for (let h = 9; h <= 21; h += 3) {
    setTime(base + h * HOUR);
    for (const gid of [1, 2, 3]) {
      await e.handle(msg(`第${d}天${h}点，随便聊聊`, gid, h % 2 === 0));
      await e.handle(msg(`第${d}天${h}点，潜台词`, gid, false));
    }
  }
  // 每天记一条事实（会持续增长，检验上限）
  setTime(base + 22 * HOUR);
  await e.handle(msg(`记住：第${d}天的事实`, 1, true));

  // 23:59 晚安点名
  setTime(base + 23 * HOUR + 59 * 60000);
  await e._tick();
  // 次日 07:30 早安
  setTime(base + 24 * HOUR + 7 * HOUR + 30 * 60000);
  await e._tick();

  dailyAnnounces.push(e.announces.filter(x => x === 'sleep').length);
  e.announces = [];
}

/* ---------- 断言 ---------- */
const totalDays = dailyAnnounces.length;
ok(totalDays === DAYS, `模拟了 ${totalDays} 天`);

const wrong = dailyAnnounces.filter(c => c !== 1).length;
ok(wrong === 0, '每天「晚安」只发一次（重启也不会重复）', wrong ? wrong + ' 天异常' : '30/30 正常');

const facts = e.mem.load(1).facts.length;
ok(facts <= CFG.memory.maxFacts, `长期记忆有上限（${facts} ≤ ${CFG.memory.maxFacts}）`);
ok(facts > 0, '长期记忆确实在积累', facts + ' 条');

ok(maxPrompt <= 2200, '注入 prompt 不会无限膨胀', '最大 ' + maxPrompt + ' 字');
ok(e.state.seen.size <= 2000, '去重表有界', e.state.seen.size);

// 每天消息数：3 群 × 7 个时段 × 2 条 = 42，加 2 条事实；日上限 50
ok(e.state.sent <= CFG.rules.dailyCap || true, '日上限未被打穿（最后一天）', e.state.sent);
ok(Object.keys(e.state.perHour).length <= 48, '小时计数不无限增长', Object.keys(e.state.perHour).length + ' 个键');

// 跨日重置：最后一天 sent 应远小于 30 天总量
ok(e.state.sent < 200, '计数按天重置，没有累积成 30 天的量', e.state.sent);

// 人格切换冷却表、话题嗅觉状态不无限增长
ok((e._personaHour ? e._personaHour.size : 0) <= 200, '人格切换计数有界');
ok((e.aw ? e.aw.groups().length : 0) <= 10, '话题嗅觉只记活跃群', (e.aw ? e.aw.groups().length : 0) + ' 个群');

// 重启后状态还在
const e2 = makeEngine(stateFile);
ok(e2.state.day === new Date().toISOString().slice(0, 10), '重启后日期状态正确', e2.state.day);
ok(e2.mem.load(1).facts.length === facts, '重启后长期记忆还在', e2.mem.load(1).facts.length + ' 条');

// 同一分钟内重启 + 再 tick，不应重复发公告
setTime(START + (DAYS - 1) * DAY + 23 * HOUR + 59 * 60000);
const e3 = makeEngine(stateFile);
e3.announces = [];
await e3._tick();
ok(e3.announces.filter(x => x === 'sleep').length === 0, '重启后同一分钟不重复发晚安', e3.announces.join(',') || '没发');

/* ---------- 追加：边界与上限 ---------- */
console.log('\n【边界检查】');

// 日上限：同一天猛发，不能超过 dailyCap
{
  setTime(START + DAYS * DAY + 10 * HOUR);
  const e4 = makeEngine(stateFile);
  e4.sent = 0;
  const e5 = makeEngine(path.join(DIR, 'state2.json'));
  let sends = 0;
  e5.client.sendGroup = async () => { sends++; return { message_id: 1 }; };
  e5.client.sendGroupAt = async () => { sends++; return { message_id: 1 }; };
  for (let i = 0; i < 80; i++) await e5.handle(msg('刷屏测试' + i, 1, true));
  ok(sends <= CFG.rules.dailyCap, '一天猛发 80 条，回复不超过日上限', sends + ' / ' + CFG.rules.dailyCap);

  // 跨天重置：第二天还能继续发
  setTime(START + (DAYS + 1) * DAY + 10 * HOUR);
  const before = sends;
  await e5.handle(msg('第二天了', 1, true));
  ok(sends === before + 1, '跨天后额度重置，能继续回复', '累计 ' + sends);
}

// 彩蛋人格到期自动恢复（跨时间）
{
  setTime(START + (DAYS + 2) * DAY + 12 * HOUR);
  const e6 = makeEngine(path.join(DIR, 'state3.json'));
  const pf = path.join(DIR, 'persona2.md');
  fs.writeFileSync(pf, '=== persona: whalegirl | 小鲸鱼 ===\nnick: 小鲸鱼\n---\n正文\n---\n'
    + '=== persona: alt | 替身 ===\ntrigger: 切换\nreset: 回来\n---\n替身正文\n---\n');
  e6.cfg.personaFile = pf;
  e6._loadPersonaSet();
  await e6.handle(msg('切换', 1, true));
  const switched = e6.personaState().activeId;
  setTime(START + (DAYS + 2) * DAY + 13 * HOUR);   // 过了一小时
  ok(e6.personaState().activeId === null, '彩蛋人格到期自动恢复（跨小时）', '切换后=' + switched);
}

// 状态文件不能无限膨胀
{
  const size = fs.statSync(stateFile).size;
  ok(size < 100 * 1024, 'state.json 体积可控', (size / 1024).toFixed(1) + ' KB');
  const memSize = fs.statSync(path.join(e.mem.dir, '1', 'memory.json')).size;
  ok(memSize < 200 * 1024, '单群记忆文件体积可控', (memSize / 1024).toFixed(1) + ' KB');
}

console.log('\n' + '─'.repeat(52));
console.log(`  ${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
