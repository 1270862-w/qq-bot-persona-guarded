#!/usr/bin/env node
/**
 * test-resilience.js —— 三个"极端情况"专项：
 *   ① 图片下载超时（图床挂死 → 不拖死整个群）
 *   ② 记忆抽取全局锁（多群同时触发 → 不抢算力）
 *   ③ 400 自动去掉 extraBody（换模型参数不兼容 → 不直接挂）
 *
 *   node test-resilience.js
 */
'use strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeBrain } from './brain.js';
import { QQEngine } from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (d ? ' — ' + d : '')); } };

/** 起一个 HTTP 服务，handler 自定义；返回 {url, close, hits} */
function server(handler) {
  return new Promise(resolve => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => { hits.push({ url: req.url, body }); handler(req, res, hits.length); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + srv.address().port,
      hits,
      close: () => srv.close()
    }));
  });
}

/* ---------- ① 图片下载超时 ---------- */
console.log('\n① 图片下载超时');
{
  const hang = await server(() => { /* 永远不回 */ });
  const api = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  });

  const brain = makeBrain({
    provider: 'deepseek', baseUrl: api.url, apiKey: 'k', model: 'm',
    vision: true, imageTimeoutMs: 400, extraBody: {}, maxTokens: 20
  }, () => {});

  const t0 = Date.now();
  const out = await brain.reply({
    persona: 'p', history: [], text: '看图',
    images: [{ url: hang.url + '/slow.jpg' }]
  });
  const ms = Date.now() - t0;

  ok(ms < 3000, '图床挂死时不会无限等待', ms + 'ms');
  ok(out === 'ok', '主流程照常返回');
  const last = api.hits[api.hits.length - 1];
  ok(!last.body.includes('image_url'), '拉不到的图片不会被塞进请求体');
  hang.close(); api.close();
}

/* ---------- ② 记忆抽取全局锁 ---------- */
console.log('\n② 记忆抽取全局锁');
{
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.mock.json'), 'utf8'));
  cfg.mode = 'auto';
  cfg.memory = { ...(cfg.memory || {}), enabled: true, autoExtract: true, everyMessages: 3 };
  const e = new QQEngine(cfg, { log: () => {}, cfgDir: HERE, memoryDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')) });

  let calls = 0;
  e.brain.reply = async () => { calls++; return '[]'; };
  e.pushHistory(1, 'user', '群友: 老王是群主');   // 抽取需要历史内容
  e._memTick.set(1, 2);              // 下一条正好到 3，触发抽取
  e._extracting = true;              // 模拟"另一个群正在抽"
  await e._maybeExtract({ groupId: 1, text: 'x' });
  ok(calls === 0, '已有提取在跑时直接跳过（不抢算力）');

  e._extracting = false;
  e._memTick.set(1, 2);
  await e._maybeExtract({ groupId: 1, text: 'x' });
  ok(calls === 1, '没人在跑时正常触发');
  ok(e._extracting === false, '结束后锁被释放（finally）');
}

/* ---------- ③ 400 自动去掉 extraBody ---------- */
console.log('\n③ 换模型参数不兼容');
{
  const api = await server((req, res, n) => {
    if (n === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown field: thinking', code: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  });

  const brain = makeBrain({
    provider: 'deepseek', baseUrl: api.url, apiKey: 'k', model: 'qwen',
    vision: false, maxTokens: 20, extraBody: { thinking: { type: 'disabled' } }
  }, () => {});

  const out = await brain.reply({ persona: 'p', history: [], text: 'hi', images: [] });
  ok(out === 'ok', '遇到 400 会自动去掉 extraBody 重试');
  ok(api.hits.length === 2, '一共发了两次请求（第一次失败、第二次成功）', 'hits=' + api.hits.length);
  ok(api.hits[0].body.includes('thinking'), '第一次带了 extraBody');
  ok(!api.hits[1].body.includes('thinking'), '第二次没带');
  api.close();
}

console.log('\n' + '─'.repeat(50));
console.log(`  ${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
