// 验证：人格 + 历史 + 识图 是否真的拼进了请求体（不联网，用桩 fetch）
import fs from 'node:fs';
import { QQEngine } from './engine.js';

const cfg = JSON.parse(fs.readFileSync('./config.mock.json', 'utf8'));
cfg.llm.provider = 'deepseek';
cfg.llm.apiKey = 'sk-test';

let captured = null;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('chat/completions')) {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '在的在的，刚在打盹儿' } }], usage: { prompt_tokens: 820, completion_tokens: 14 } }) };
  }
  if (u.includes('.jpg')) {  // 图片下载
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer };
  }
  throw new Error('unexpected ' + u);
};

const e = new QQEngine(cfg, { log: () => {}, cfgDir: process.cwd() });

// 先塞两轮历史
e.pushHistory(123, 'user', '路人甲: 今天好热');
e.pushHistory(123, 'assistant', '热死了，我先去灌杯水');

const out = await e.brain.reply({
  persona: e.persona,
  history: e.state.history.get(123),
  text: '这张图是啥',
  images: [{ url: 'https://example.com/a.jpg' }]
});

console.log('=== 模型返回 ===', out);
console.log('=== 请求体检查 ===');
console.log('model:', captured.model, '| max_tokens:', captured.max_tokens, '| extraBody:', JSON.stringify(captured.thinking));
console.log('messages 条数:', captured.messages.length);
console.log('system 前 60 字:', captured.messages[0].content.slice(0, 60).replace(/\n/g, ' '));
console.log('system 是否含人设关键点:',
  ['蓝色大肥鱼', '傲娇', '干饭', 'DeepSleep', '口头禅'].filter(k => captured.messages[0].content.includes(k)));
console.log('历史条数:', captured.messages.filter(m => m.role !== 'system').length - 1);
const last = captured.messages[captured.messages.length - 1].content;
console.log('最后一条是数组(图文混排):', Array.isArray(last), '| 段数:', Array.isArray(last) ? last.length : '-');
if (Array.isArray(last)) console.log('段类型:', last.map(p => p.type));
