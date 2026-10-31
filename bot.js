#!/usr/bin/env node
/**
 * bot.js —— 命令行入口（薄壳）：只管启动、日志、自检。
 *
 *   node bot.js            常驻（按 config.mode）
 *   node bot.js --dry      强制只看不发
 *   node bot.js --check    连上后打印群列表并退出（部署自检）
 *   node bot.js --selftest 真机自检：配置/人格/记忆/触发/协议端/图片形状
 *   node bot.js --selftest --wait 30 --send <群号>   等更久、并发一条测试消息
 *   QQCFG=xxx.json node bot.js   指定配置文件
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQEngine } from './engine.js';
import { runSelfTest } from './selftest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.QQCFG || path.join(HERE, 'config.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const LOGDIR = path.join(HERE, 'logs');
const QUEUE = path.join(HERE, 'queue.jsonl');
fs.mkdirSync(LOGDIR, { recursive: true });

const ARGS = process.argv.slice(2);
const CHECK_ONLY = ARGS.includes('--check');
const SELFTEST = ARGS.includes('--selftest');
const WAIT_SEC = (() => { const i = ARGS.indexOf('--wait'); return i >= 0 ? Number(ARGS[i + 1]) || 20 : 20; })();
const SEND_GROUP = (() => { const i = ARGS.indexOf('--send'); return i >= 0 ? ARGS[i + 1] : null; })();
if (ARGS.includes('--dry')) CFG.mode = 'dry';

const readQueue = () => {
  try { return fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { return []; }
};
const writeQueue = (lines) => fs.writeFileSync(QUEUE, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

function day() { return new Date().toISOString().slice(0, 10); }
function log(...a) {
  const line = new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(path.join(LOGDIR, 'bot-' + day() + '.log'), line + '\n'); } catch (e) {}
}

/* ---------- manual 模式的消费端 ---------- */
async function cmdQueue() {
  const pending = readQueue().filter(x => x.status === 'pending');
  if (!pending.length) return console.log('没有待批的回复');
  console.log(`待批 ${pending.length} 条：`);
  for (const it of pending) {
    console.log(`  ${it.id}  [${it.sender}] ${String(it.text).slice(0, 30)}  →  ${it.reply}`);
  }
  console.log('\n批准：node bot.js approve <id>');
}

async function cmdApprove(id) {
  const lines = readQueue();
  const it = lines.find(x => x.id === id && x.status === 'pending');
  if (!it) { console.log('没有这个 id：' + id); process.exit(1); }
  let engine;
  try {
    engine = new QQEngine(CFG, { log, queueFile: QUEUE, cfgDir: path.dirname(CFG_PATH) });
  } catch (e) {
    if (String(e.message || '').includes('[POLICY]')) {
      console.error('启动失败：' + e.message);
      process.exit(1);
    }
    throw e;
  }
  await engine.start();
  await new Promise(r => {
    const t = setTimeout(r, 5000);
    engine.client.once('ready', () => { clearTimeout(t); r(); });
  });
  let r;
  try {
    r = await engine.sendQueued(it);
  } catch (e) {
    // 发送失败：保持 pending，让人可以重试；不要标记成 sent 骗自己
    log(`[APPROVE-FAIL ${id}] ${e.message}（仍是 pending，可重试）`);
    engine.stop();
    process.exit(1);
  }
  it.status = 'sent';
  it.sentAt = Date.now();
  writeQueue(lines);
  log(`[APPROVED ${id}] → 群 ${it.groupId}：${it.reply}（message_id=${r && r.message_id}）`);
  engine.stop();
  process.exit(0);
}

async function main() {
  log(`启动：mode=${CFG.mode}  配置=${path.basename(CFG_PATH)}`);
  let engine;
  try {
    engine = new QQEngine(CFG, { log, queueFile: QUEUE, stateFile: path.join(HERE, 'state.json'), cfgDir: path.dirname(CFG_PATH) });
  } catch (e) {
    if (String(e.message || '').includes('[POLICY]')) {
      console.error('启动失败：' + e.message);
      process.exit(1);
    }
    throw e;
  }

  engine.client.on('ready', async () => {
    try {
      const groups = await engine.listGroups();
      log('[ready] 在群数量:', (groups || []).length);
      for (const g of (groups || []).slice(0, 40)) {
        const on = engine.groupCfg(g.group_id);
        log(`   ${on ? '✔ 启用' : '   未启用'}  ${g.group_id}  ${g.group_name}`);
      }
      if (CHECK_ONLY) { engine.stop(); process.exit(0); }
    } catch (e) {
      log('[ready] 拉群列表失败:', e.message);
      if (CHECK_ONLY) process.exit(1);
    }
  });

  const ok = await engine.start();
  if (!ok) log('[warn] WS 连接失败：检查 NapCat/Lagrange 是否启动、端口与 access_token');

  if (CHECK_ONLY) setTimeout(() => process.exit(ok ? 0 : 1), 6000);

  process.on('SIGINT', () => {
    log('Ctrl+C，退出（未发消息，安全）');
    engine.stop();
    process.exit(0);
  });

  setInterval(() => {
    const s = engine.status();
    log(`[usage] 已发 ${s.sentToday} 条 | 本小时 ${s.hourly} | 调用 ${s.usage.calls} 次 | 估算 ¥${s.usage.estCostCNY.toFixed(3)}`);
  }, 600000);
}

const cmd = ARGS.find(a => !a.startsWith('--'));
if (SELFTEST) {
  runSelfTest(CFG, { cfgDir: HERE, log: (s) => console.log(s), wait: WAIT_SEC, sendGroup: SEND_GROUP })
    .then(r => { process.exitCode = r.ok ? 0 : 1; })
    .catch(e => { console.error('自检异常：' + e.message); process.exitCode = 1; });
} else if (cmd === 'queue') { cmdQueue(); }
else if (cmd === 'approve') { cmdApprove(ARGS[ARGS.indexOf('approve') + 1]); }
else main().catch(e => { console.error('FATAL', e); process.exit(1); });
