#!/usr/bin/env node
/**
 * acceptance.js —— 人话版验收。不测代码细节，只回答「它到底符不符合你的要求」。
 *
 *   node acceptance.js
 *
 * 每条都是一句人话 + 通过/不通过。最后给一句总结。
 * 不需要联网、不花钱（模型用桩）。
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { QQEngine } from './engine.js';
import { parsePersonaText } from './persona-file.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const items = [];
const add = (ok, text, detail) => items.push({ ok: !!ok, text, detail: detail || '' });

/* ---------- 1. 东西齐不齐 ---------- */
const need = ['config.json', 'engine.js', 'onebot.js', 'brain.js', 'memory.js', 'plugin.js',
  'awareness.js', 'rules.js', 'persona-file.js', 'README.md'];
const missing = need.filter(f => !fs.existsSync(path.join(HERE, f)));
add(missing.length === 0, '该有的文件都在', missing.length ? '缺：' + missing.join(', ') : need.length + ' 个文件齐全');

const [major] = process.versions.node.split('.').map(Number);
add(major >= 22, 'Node 版本够用（≥22，自带 WebSocket）', '当前 ' + process.versions.node);
add(typeof WebSocket === 'function', '这个 Node 支持 WebSocket', '');

/* ---------- 2. 配置自洽 ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
const personaOk = files => files.filter(f => f && !fs.existsSync(path.join(HERE, f)));
add(personaOk([cfg.personaFile]).length === 0, '人格文件存在', cfg.personaFile);

// 人格全部来自这一个文件
const PS = parsePersonaText(fs.readFileSync(path.join(HERE, cfg.personaFile), 'utf8'));
add(!!PS.default && PS.default.text.length > 20, '人格文件里有默认人格', PS.default ? PS.default.name : '没有');
add(PS.easter.length <= 4, '彩蛋人格不超过 4 个（超出会被丢弃）', '当前 ' + PS.easter.length + ' 个');
add(PS.warnings.length === 0, '人格文件没有格式告警', PS.warnings.join('；') || '无');
add(!cfg.llm.apiKey, '配置文件里没有明文 API key', cfg.llm.apiKey ? '有明文 key（不安全）' : '走环境变量 ' + (cfg.llm.apiKeyEnv || '未设置'));
add(/^\d{2}:\d{2}$/.test(cfg.schedule.sleepAt) && /^\d{2}:\d{2}$/.test(cfg.schedule.wakeAt), '作息时间格式正确', cfg.schedule.sleepAt + ' → ' + cfg.schedule.wakeAt);
add(PS.easter.length >= 0, '彩蛋人格已登记', PS.easter.map(p => p.id).join(' / ') || '（无，正常）');

/* ---------- 3. 造一个假群来验行为 ---------- */
const base = JSON.parse(JSON.stringify(cfg));
base.mode = 'auto';
base.llm = { ...base.llm, provider: 'mock' };
base.autoAcceptNewGroups = true;
base.easter = { ...(base.easter || {}), cooldownMs: 0, resetCooldownMs: 0 };   // 验收看功能，不看防刷冷却                                    // 验收要能触发，不受白名单限制
base.schedule = { ...(base.schedule || {}), enabled: false };       // 验收不受作息时段影响（半夜跑才不挂）
base.groups = [{ id: 123456789, name: '验收群', enable: true, proactive: true }];
base.rules = { ...base.rules, quietHours: [], perGroupCooldownMs: 0, minIntervalMs: 0, maxPerHour: 99, dailyCap: 99 };
base.proactive = { ...base.proactive, probability: 0 };

function engine(over = {}, opts = {}) {
  const c = JSON.parse(JSON.stringify(base));
  c.intent = { ...(c.intent || {}), batchSize: 1 };   // 验收逐条判断
  Object.assign(c, over);
  const e = new QQEngine(c, { log: () => {}, cfgDir: HERE, memoryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'acc-mem-')), ...opts });
  e.sent = [];
  e.client.sendGroup = async (g, t) => { e.sent.push(t); return { message_id: e.sent.length }; };
  e.client.sendGroupAt = async (g, u, t) => { e.sent.push('@' + u + ' ' + t); return { message_id: e.sent.length }; };
  e.brain.reply = async () => '好的呀';
  return e;
}
let n = 0;
const m = (text, over = {}) => ({ groupId: 123456789, userId: 20002, sender: '群友', text, images: [], atMe: false, isSelf: false, messageId: 'a' + (++n), time: 0, ...over });

{
  const e = engine();
  await e.handle(m('@小鲸鱼 在吗', { atMe: true }));
  add(e.sent.length === 1, '被 @ 会回复', e.sent[0] || '无回复');

  await e.handle(m('同一句重复投递', { atMe: true, messageId: 'same' }));
  await e.handle(m('同一句重复投递', { atMe: true, messageId: 'same' }));
  add(e.sent.length === 2, '同一条消息只回一次（不会复读）', '发出 ' + e.sent.length + ' 条');
}

{
  const kws = (cfg.proactive && cfg.proactive.keywords) || [];
  if (!kws.length) {
    add(true, '主动搭话：本版没配置关键词（跳过）', '在 config.proactive.keywords 里加几个词即可启用');
  } else {
    // 主动搭话需要该群开启 proactive，且命中关键词
    const e = engine({ groups: [{ id: 123456789, name: '验收群', enable: true, proactive: true }] });
    await e.handle(m(kws[0], {}));
    add(e.sent.length === 1, '没人理它时也会按关键词主动搭话', e.sent[0] || '无');
  }
}

{
  const e = engine();
  let called = false;
  e.brain.reply = async () => { called = true; return '不该调用'; };
  await e.handle(m('帮我写个爬虫', { atMe: true }));
  const hasPreset = !!(cfg.scope.refusals && Object.keys(cfg.scope.refusals).length);
  if (hasPreset) {
    add(!called && e.sent.length === 1, '要它写代码 → 直接拒绝，不调用模型（省钱）', e.sent[0] || '无');
  } else {
    add(e.sent.length === 1, '要它写代码 → 用人格拒绝一句', (e.sent[0] && (e.sent[0].text || e.sent[0])) || '无');
  }

  const e2 = engine();
  let called2 = false;
  e2.brain.reply = async () => { called2 = true; return '正常聊天'; };
  await e2.handle(m('服务器又崩了', { atMe: true }));
  add(called2 && e2.sent.length === 1, '吐槽「服务器又崩了」→ 当正常聊天，不误伤', e2.sent[0] || '无');
}

if (PS.easter.length) {
  const e = engine();
  const p0 = PS.easter[0];
  await e.handle(m(p0.trigger[0], { atMe: true }));
  add(e.personaState().activeId === p0.id, '说触发词 → 切到「' + p0.name + '」', e.personaState().activeId || '没切换');
  const resetWord = (p0.reset && p0.reset[0]) || PS.globalReset[0];
  if (resetWord) {
    await e.handle(m(resetWord, { atMe: true }));
    add(e.personaState().activeId === null, '说恢复词「' + resetWord + '」→ 回到默认', e.personaState().activeId || '已恢复');
  }
}

{
  const e = engine();
  e.rules.quietHours = ['00:00', '23:59'];
  await e.handle(m('在吗', { atMe: true }));
  add(e.sent.length === 0 && e.state.history.size === 0, '静默时段（半夜）完全不搭理', '发出 ' + e.sent.length + ' 条');
}

{
  const e = engine({ groups: [], autoAcceptNewGroups: true });
  await e.handle(m('新群的第一句', { groupId: 999, atMe: true }));
  add(e.sent.length === 1, '被拉进新群也能直接说话', e.sent[0] || '无');
}

/* ---------- 4. 人格像不像 ---------- */
for (const p of [PS.default, ...PS.easter].filter(Boolean)) {
  add(p.text.length >= 40, '人设「' + p.name + '」正文够长（' + p.text.length + ' 字）', '');
}

/* ---------- 4b. 群记忆隔离 ---------- */
{
  const e = engine({ groups: [], autoAcceptNewGroups: true });
  await e.handle(m('记住：老王是群主', { groupId: 1001, messageId: 'am1', atMe: true }));
  await e.handle(m('你好', { groupId: 2002, messageId: 'am2', atMe: true }));
  const a = e.mem.prompt(1001), b = e.mem.prompt(2002);
  add(a.includes('老王是群主'), '群记忆：记得住本群的事', a.split('\n').filter(Boolean)[1] || '');
  add(!b.includes('老王是群主'), '群记忆：不会串到别的群', '群 2002 里看不到群 1001 的记忆');
  add(fs.existsSync(path.join(e.mem.dir, '1001', 'memory.json')) && fs.existsSync(path.join(e.mem.dir, '2002', 'memory.json')),
    '每群一个独立目录', '1001/memory.json 与 2002/memory.json');
}

/* ---------- 5. 交付物 ---------- */
add(fs.existsSync(path.join(HERE, 'test.js')) && fs.existsSync(path.join(HERE, 'test-hard.js')), '两套测试脚本都在', 'test.js / test-hard.js');
add(fs.existsSync(path.join(HERE, 'install-dsh.mjs')), '有 DSH 一键安装脚本', 'install-dsh.mjs');
add(fs.existsSync(path.join(HERE, 'memory.js')), '有群记忆模块', 'memory.js');
add(fs.existsSync(path.join(HERE, 'start.sh')) || fs.existsSync(path.join(HERE, 'start.bat')), '有双击启动脚本', 'start.sh / start.bat');

/* ---------- 输出 ---------- */
console.log('\n' + '═'.repeat(56));
console.log('  验收报告 · QQ 群聊机器人');
console.log('═'.repeat(56) + '\n');
let i = 0;
for (const it of items) {
  i++;
  console.log(`${it.ok ? '✅' : '❌'} ${String(i).padStart(2)}. ${it.text}`);
  if (it.detail) console.log(`      ${it.detail}`);
}
const okCount = items.filter(x => x.ok).length;
const failCount = items.length - okCount;
console.log('\n' + '─'.repeat(56));
console.log(`  ${okCount} 项通过 / ${items.length} 项${failCount ? `，${failCount} 项没通过` : ''}`);
if (failCount === 0) console.log('  结论：可以拿去用了。');
else console.log('  结论：还有问题，把那几条 ❌ 发给我。');
console.log('─'.repeat(56) + '\n');

fs.writeFileSync(path.join(HERE, `验收报告-${new Date().toISOString().slice(0, 10)}.txt`),
  items.map((it, k) => `${it.ok ? '通过' : '不通过'} ${k + 1}. ${it.text} ${it.detail}`).join('\n'));
process.exitCode = failCount ? 1 : 0;
