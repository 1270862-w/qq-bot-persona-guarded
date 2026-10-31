#!/usr/bin/env node
/**
 * server.js —— 本地控制服务（"把服务器跑起来"的那一半）
 *
 *   node server.js            启机器人 + 控制面板
 *
 * 面板接口（默认只绑 127.0.0.1，外网访问不到）：
 *   GET  /status            运行状态、今日发送数、token 用量、估算花费
 *   GET  /groups            机器人所在的群
 *   POST /send              发消息 { "group_id": "123", "text": "hi" }
 *   GET  /health            ok
 *
 * 需要 token 时在 config.server.token 填一个字符串，
 * 之后请求带 ?token=xxx 或 Authorization: Bearer xxx。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { QQEngine } from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.QQCFG || path.join(HERE, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const QUEUE = path.join(HERE, 'queue.jsonl');
fs.mkdirSync(path.join(HERE, 'logs'), { recursive: true });

const day = () => new Date().toISOString().slice(0, 10);
function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(HERE, 'logs', 'server-' + day() + '.log'), line + '\n'); } catch (e) {}
}

const engine = new QQEngine(CFG, { log, queueFile: QUEUE, stateFile: path.join(HERE, 'state.json'), cfgDir: path.dirname(CFG_PATH) });

/* ---------- 控制面板 ---------- */
const SRV = Object.assign({ host: '127.0.0.1', port: 8123, token: '' }, CFG.server || {});

function authed(req, url) {
  if (!SRV.token) return true;
  const q = url.searchParams.get('token');
  const h = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return q === SRV.token || h === SRV.token;
}
function json(res, code, obj) {
  const b = JSON.stringify(obj, null, 1);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(b);
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (!authed(req, url)) return json(res, 401, { error: 'unauthorized' });

  if (url.pathname === '/health') return json(res, 200, { ok: true });
  if (url.pathname === '/status') return json(res, 200, engine.status());
  if (url.pathname === '/groups') {
    engine.listGroups()
      .then(g => json(res, 200, { groups: (g || []).map(x => ({ group_id: String(x.group_id), name: x.group_name })) }))
      .catch(e => json(res, 500, { error: e.message }));
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        if (!j.group_id || !j.text) return json(res, 400, { error: 'group_id 和 text 必填' });
        const r = await engine.say(String(j.group_id), String(j.text));
        json(res, 200, { ok: true, message_id: r && r.message_id });
      } catch (e) { json(res, 500, { error: e.message }); }
    });
    return;
  }
  json(res, 404, { error: 'not found', paths: ['/health', '/status', '/groups', '/send'] });
});

/* ---------- 启动 ---------- */
log(`配置=${path.basename(CFG_PATH)} mode=${CFG.mode} 自动接纳新群=${CFG.autoAcceptNewGroups === true}`);

engine.client.on('ready', async () => {
  try {
    const gs = await engine.listGroups();
    log(`[ready] 已登录，在 ${(gs || []).length} 个群`);
  } catch (e) { log('[ready] 拉群列表失败:', e.message); }
});

if (CFG.server && CFG.server.enable === false) {
  log('控制面板已关闭（config.server.enable=false），只跑机器人');
} else {
  httpServer.listen(SRV.port, SRV.host, () => {
    log(`控制面板 http://${SRV.host}:${SRV.port}  (${SRV.token ? '需要 token' : '无 token，仅本机可访问'})`);
  });
}

const ok = await engine.start();
log(ok ? 'OneBot 已连接，开始听群消息' : '⚠️ OneBot 连接失败：检查 NapCat 是否启动、wsUrl/accessToken 对不对');

process.on('SIGINT', () => { log('退出'); engine.stop(); httpServer.close(); process.exit(0); });

setInterval(() => {
  const s = engine.status();
  log(`[usage] 已发 ${s.sentToday} 条 | 调用 ${s.usage.calls} 次 | 估算 ¥${s.usage.estCostCNY.toFixed(3)}`);
}, 600000);
