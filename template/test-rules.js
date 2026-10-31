#!/usr/bin/env node
/**
 * test-rules.js —— 纯规则层单测。
 * rules.js 不依赖 engine 状态，所以这里直接喂配置和文本，不用造整套引擎。
 *
 *   node test-rules.js
 */
'use strict';
import { pickLine, sanitize, scopeHit, politicsHit, refusalLine, refusalFallback, politicsLine, scopeRule, politicsRule, styleRule } from './rules.js';

let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? '  — ' + d : '')); } };
const eq = (a, b, n) => ok(a === b, n, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));

const CFG = {
  bot: { nick: '小鲸鱼', defaultPersonaId: 'whalegirl' },
  rules: { maxReplyChars: 20 },
  safety: { blockedWords: ['去死'] },
  scope: {
    enabled: true,
    keywords: ['爬虫', '代码'],
    requestMarkers: ['帮我', '怎么'],
    ventMarkers: ['崩了', '好烦'],
    refusals: { whalegirl: ['a1', 'a2'], changjiang: '一句话' }
  },
  politics: {
    enabled: true,
    keywords: ['选举', 'politics'],
    refusals: { whalegirl: ['p1'], loji: 'p2' }
  },
  style: { sentences: '2~3', minChars: 40, maxChars: 150 }
};

console.log('\n① pickLine');
eq(pickLine('x'), 'x', '字符串原样返回');
ok(['a', 'b'].includes(pickLine(['a', 'b'])), '数组里随机取');
eq(pickLine([]), '', '空数组返回空串');
eq(pickLine(null), '', 'null 返回空串');

console.log('\n② sanitize');
eq(sanitize(CFG, '换行\n测试', null), '换行 测试', '换行压成空格');
eq(sanitize(CFG, '小鲸鱼：你好', /^(小鲸鱼|鲸鱼娘)[:：]\s*/), '你好', '去掉人格前缀');
eq(sanitize(CFG, '「引用」', null), '引用', '去掉包裹引号');
eq(sanitize(CFG, '你去死吧', null), null, '敏感词返回 null');
ok((sanitize(CFG, 'x'.repeat(50), null) || '').length === 20, '超长截断到 maxReplyChars');
eq(sanitize(CFG, '   ', null), null, '纯空白返回 null');

console.log('\n③ scopeHit（能力边界）');
eq(scopeHit(CFG, '帮我写个爬虫'), true, '关键词 + 请求语气 → 拦');
eq(scopeHit(CFG, '这段代码怎么改'), true, '关键词 + 怎么 → 拦');
eq(scopeHit(CFG, '爬虫'), false, '只有关键词、没有请求语气 → 放行');
eq(scopeHit(CFG, '服务器又崩了'), false, '吐槽词 → 放行');
eq(scopeHit(CFG, '今天天气不错'), false, '无关内容 → 放行');

console.log('\n④ politicsHit（去混淆）');
eq(politicsHit(CFG, '你怎么看这场选举'), true, '原文命中');
eq(politicsHit(CFG, '选 举 怎 么 看'), true, '空格混淆也能拦');
eq(politicsHit(CFG, 'P-o-l-i-t-i-c-s'), true, '连字符混淆也能拦');
eq(politicsHit(CFG, 'Poli\u200btics'), true, '零宽字符也能拦');
eq(politicsHit(CFG, '今天吃了碗面'), false, '正常聊天不误伤');

console.log('\n⑤ 话术选择');
eq(refusalLine(Object.assign({}, CFG, { scope: { ...CFG.scope, refusals: { changjiang: '只有一句' } } }), 'changjiang'), '只有一句', '单句话术');
ok(['a1', 'a2'].includes(refusalLine(CFG, 'whalegirl')), '数组话术可轮换');
eq(politicsLine(CFG, 'loji'), 'p2', '政治话术按人格取');
eq(refusalLine(CFG, '不存在的人格'), null, '没配置的人格不编话术（返回 null）');
ok(refusalFallback(CFG).length > 0, '有冷兜底话术：' + refusalFallback(CFG));

console.log('\n⑥ 拼 prompt 的规则');
ok(scopeRule(CFG).includes('能力边界'), '能力边界规则存在');
ok(politicsRule(CFG, 'whalegirl').includes('政治'), '政治规则存在');
ok(styleRule(CFG).includes('40'), '篇幅规则读取配置');
eq(scopeRule({ scope: { enabled: false } }), '', '关闭时返回空串');
eq(politicsRule({ politics: { enabled: false } }, 'x'), '', '政治关闭时返回空串');
eq(styleRule({ style: { enabled: false } }), '', '篇幅关闭时返回空串');

console.log('\n' + '─'.repeat(46));
console.log(`  ${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
