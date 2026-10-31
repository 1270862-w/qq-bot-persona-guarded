#!/usr/bin/env node
/**
 * mock-onebot.js —— 假的 OneBot v11 服务端，用来在没有 QQ 的情况下端到端联调。
 * 只用于测试，正式部署不需要它。
 *
 *   node mock-onebot.js        → WS 3001 / HTTP 3000，自动发几条测试群消息
 */
'use strict';
import http from 'node:http';
import fs2 from 'node:fs';

/** 昵称从配置读，避免三个版本各写一份 */
let MOCK_NICK = '助手';
try {
  const c = JSON.parse(fs2.readFileSync(new URL('./config.mock.json', import.meta.url), 'utf8'));
  MOCK_NICK = (c.bot && c.bot.nick) || MOCK_NICK;
} catch (e) { /* 用默认 */ }

let WebSocketServer;
try { ({ WebSocketServer } = await import('ws')); }
catch (e) { ({ WebSocketServer } = await import('/root/.dsh/node_modules/ws/index.js')); }

// 端口不写死：跟着 config.mock.json 的 onebot 配置走，改了配置这里自动跟
import fs from 'node:fs';
const _cfg = JSON.parse(fs.readFileSync(new URL('./config.mock.json', import.meta.url), 'utf8'));
const WS_PORT = Number(new URL(_cfg.onebot.wsUrl).port) || 3001;
const HTTP_PORT = Number(new URL(_cfg.onebot.httpUrl).port) || 3000;
const GROUP = 123456789;
let seq = 0;

/* ---------- HTTP API ---------- */
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch (e) {}
    const action = req.url.replace(/^\//, '').split('?')[0];
    res.setHeader('Content-Type', 'application/json');

    if (action === 'send_group_msg') {
      const text = (j.message || []).map(s => s.type === 'text' ? s.data.text : s.type === 'at' ? '@' + s.data.qq : '').join('');
      console.log('\n>>> [QQ 将发出] ' + text + '\n');
      return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: ++seq } }));
    }
    if (action === 'get_group_list') {
      return res.end(JSON.stringify({
        status: 'ok', retcode: 0,
        data: [{ group_id: GROUP, group_name: '测试群（mock）' }]
      }));
    }
    if (action === 'get_login_info') {
      return res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: MOCK_NICK } }));
    }
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  });
});
server.listen(HTTP_PORT, () => console.log('[mock] HTTP API  http://127.0.0.1:' + HTTP_PORT));

/* ---------- WS 事件 ---------- */
const wss = new WebSocketServer({ port: WS_PORT });
console.log('[mock] WS 事件  ws://127.0.0.1:' + WS_PORT);

function evt(text, opts = {}) {
  const id = ++seq;
  return {
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    time: Math.floor(Date.now() / 1000), self_id: 10001,
    group_id: GROUP, user_id: opts.userId || 20002,
    message_id: id,
    raw_message: text,
    sender: { user_id: opts.userId || 20002, nickname: opts.nick || '路人甲' },
    message: opts.segments || [{ type: 'text', data: { text } }]
  };
}

wss.on('connection', (ws) => {
  console.log('[mock] 有客户端连上了');
  ws.on('message', (data) => {
    try {
      const j = JSON.parse(String(data));
      if (j.echo) ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true }, echo: j.echo }));
    } catch (e) {}
  });
  ws.send(JSON.stringify({
    post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect',
    time: Math.floor(Date.now() / 1000), self_id: 10001
  }));

  const script = [
    { after: 2500, ev: evt('大家好，我是新来的', { nick: '路人甲' }) },
    {
      after: 5000, ev: evt(`@${MOCK_NICK} 在吗，问你个事`, {
        nick: '路人乙', userId: 20003,
        segments: [
          { type: 'at', data: { qq: '10001', name: MOCK_NICK } },
          { type: 'text', data: { text: ' 在吗，问你个事' } }
        ]
      })
    },
    { after: 9000, ev: evt('今天好无聊啊有人吗', { nick: '路人丙', userId: 20004 }) },
    {
      after: 13000, ev: evt('[图片]', {
        nick: '路人丁', userId: 20005,
        segments: [
          { type: 'at', data: { qq: '10001', name: MOCK_NICK } },
          { type: 'text', data: { text: ' 这张图是啥' } },
          { type: 'image', data: { url: 'https://example.com/a.jpg', file: 'a.jpg' } }
        ]
      })
    },
    { after: 17000, ev: evt('散了吧', { nick: '路人甲' }) }
  ];

  for (const s of script) {
    setTimeout(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify(s.ev));
    }, s.after);
  }
});
