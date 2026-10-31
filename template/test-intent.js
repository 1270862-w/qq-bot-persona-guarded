#!/usr/bin/env node
/**
 * test-intent.js —— 语义触发 / 表情转文字 / 临时日志 单测。
 *
 *   node test-intent.js
 */
'use strict';
import { intentScore } from './rules.js';
import { emojiToText, isEmojiOnly } from './emoji.js';
import { TempLog } from './templog.js';

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? '  — ' + d : '')); } };
const eq = (a, b, n) => ok(a === b, n, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));

const CFG = { intent: { threshold: 10 } };
const S = (t, ctx = {}) => intentScore(CFG, t, ctx);

console.log('\n① 语义触发打分');
ok(!S('在吗').hit, '光喊「在吗」不带名字，不算');
ok(!S('你怎么看这个').hit, '光有「你+怎么」不够 10 分');
  ok(!S('在吗，问个事').hit, '呼叫词在中段但没带名字，也不算');
  ok(!S('你觉得这东西靠谱吗').hit, '普通问句不够 10 分');
ok(!S('帮我看看这个').hit, '「帮我」单独不够 10 分');
ok(!S('你刚才说啥').hit, '「你+啥」不够 10 分');
ok(!S('这是啥？').hit, '问号+疑问词不够 10 分');
ok(!S('', { hasImage: true }).hit, '纯图片不再直接触发');
  ok(!S('', { hasImage: true, imageBonus: 2 }).hit, '图片+上下文仍不够，要文字够强');
  ok(S('在吗', { named: true }).hit, '带上名字才算呼叫');
  ok(!S('这是啥', { hasImage: true }).hit, '图片配弱问句还不够');
  ok(S('你帮我看看这张图', { hasImage: true }).hit, '图片+明确请求才触发');
ok(!S('哈哈哈哈').hit, '纯附和不触发');
ok(!S('嗯').hit, '短应答不触发');
ok(!S('').hit, '空消息不触发');
ok(!S('周五开黑吗').hit, '群友之间的短问句不抢话');
ok(S('你怎么看这个').score > S('今天吃什么').score, '对着我说的话分数更高');

console.log('\n② 表情转文字');
eq(emojiToText('😂😂'), '[笑哭][笑哭]', '笑哭转文字');
eq(emojiToText('👍'), '[点赞]', '点赞转文字');
ok(emojiToText('😀😀😀').includes('[表情]') || emojiToText('😀😀😀').includes('['), '未收录的表情写成 [表情]');
eq(emojiToText('吃饭了🍚'), '吃饭了[米饭]', '文字+表情混合');
eq(emojiToText(''), '', '空串返回空');
ok(isEmojiOnly('😂😂'), '纯表情识别');
ok(!isEmojiOnly('哈哈😂'), '带文字的不算纯表情');

console.log('\n③ 临时日志');
{
  const log = new TempLog({ size: 5, maxAgeMinutes: 60 });
  for (let i = 0; i < 8; i++) log.add(1, { sender: '甲', text: 'm' + i });
  eq(log.recent(1, 10).length, 5, '超过容量自动裁到上限');
  eq(log.recent(1, 2).at(-1).text, 'm7', '取到的是最新的');
  log.add(1, { sender: '我', text: '回复', isSelf: true });
  ok(log.segment(1, 3).includes('我: 回复'), '机器人发言也进日志');
  ok(log.sinceHuman(1) < 1000, '能算"多久没人说话"');
  eq(log.recent(99, 5).length, 0, '没聊过的群返回空');
}

console.log('\n' + '─'.repeat(46));
console.log(`  ${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
