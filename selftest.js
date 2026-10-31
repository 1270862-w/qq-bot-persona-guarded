#!/usr/bin/env node
/**
 * selftest.js —— 真机自检：把"能不能跑"拆成一条条可验证的检查。
 *
 *   node bot.js --selftest              离线检查 + 连协议端看事件形状
 *   node bot.js --selftest --wait 30    多等一会儿，抓一条真实群消息
 *   node bot.js --selftest --send <群号> 额外发一条测试消息（会打扰群，慎用）
 *
 * 设计原则：能静态查的静态查；必须连协议端的打印真实数据形状；
 * 任何失败都给出"下一步查什么"，而不是只报红。
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { OneBotClient } from './onebot.js';
import { parsePersonaText } from './persona-file.js';
import { intentScore } from './rules.js';
import { emojiToText } from './emoji.js';

const ok = (c, msg, detail = '') => ({ ok: !!c, level: c ? 'ok' : 'bad', msg, detail });
const warn = (msg, detail = '') => ({ ok: null, level: 'warn', msg, detail });
const info = (msg, detail = '') => ({ ok: null, level: 'info', msg, detail });

function line(r) {
  const mark = r.level === 'ok' ? '✅' : r.level === 'bad' ? '❌' : r.level === 'warn' ? '⚠️ ' : 'ℹ️ ';
  return `${mark} ${r.msg}${r.detail ? '  ← ' + r.detail : ''}`;
}

export async function runSelfTest(cfg, opts = {}) {
  const cfgDir = opts.cfgDir || process.cwd();
  const log = opts.log || console.log;
  const waitSec = Math.max(3, Number(opts.wait) || 20);
  const sendGroup = opts.sendGroup || null;
  const rows = [];
  const add = (r) => { rows.push(r); log(line(r)); };

  log('\n' + '═'.repeat(64));
  log('  真机自检');
  log('═'.repeat(64));

  /* ---------- 1. 配置 ---------- */
  log('\n【1】配置');
  add(ok(cfg && cfg.onebot && cfg.onebot.wsUrl, '协议端 WS 地址', cfg.onebot && cfg.onebot.wsUrl));
  add(ok(cfg && cfg.onebot && cfg.onebot.httpUrl, '协议端 HTTP 地址', cfg.onebot && cfg.onebot.httpUrl));
  add(ok(['dry', 'manual', 'auto'].includes(cfg.mode), '投递模式合法', cfg.mode));
  if (cfg.mode === 'dry') add(warn('当前是 dry 模式', '只会写日志、不会真发消息'));
  const keyEnv = (cfg.llm && cfg.llm.apiKeyEnv) || 'DEEPSEEK_API_KEY';
  add(ok(!!process.env[keyEnv], 'API key 环境变量已设置', process.env[keyEnv] ? keyEnv + ' = ***' : keyEnv + ' 未设置'));
  const groups = (cfg.groups || []).map(g => String(g.id));
  add(ok(groups.length > 0 || cfg.autoAcceptNewGroups, '群白名单或自动接纳已开启',
    groups.length ? groups.length + ' 个群' : 'autoAcceptNewGroups=' + !!cfg.autoAcceptNewGroups));

  /* ---------- 2. 人格文件 ---------- */
  log('\n【2】人格文件');
  const pf = path.isAbsolute(cfg.personaFile || '') ? cfg.personaFile : path.resolve(cfgDir, cfg.personaFile || './persona.md');
  if (!fs.existsSync(pf)) {
    add(ok(false, '人格文件存在', pf));
  } else {
    const parsed = parsePersonaText(fs.readFileSync(pf, 'utf8'));
    add(ok(!!parsed.default && parsed.default.text.length > 20, '默认人格已解析',
      parsed.default ? parsed.default.name + ' / ' + parsed.default.text.length + ' 字' : '没有默认人格'));
    add(ok(parsed.easter.length <= 4, '彩蛋人格数量合规', parsed.easter.length + ' 个'));
    for (const w of parsed.warnings) add(warn('人格文件告警', w));
    if (parsed.easter.length) {
      add(info('彩蛋触发词', parsed.easter.map(p => `${p.id}:${(p.trigger || [])[0] || '无'}`).join(' | ')));
    }
  }

  /* ---------- 3. 记忆目录 ---------- */
  log('\n【3】记忆目录');
  const instance = (cfg.memory && cfg.memory.instance) || path.basename(cfgDir) || 'default';
  const memRoot = path.join(cfgDir, 'memory', instance);
  add(info('实例隔离目录', path.relative(cfgDir, memRoot) || memRoot));
  try {
    fs.mkdirSync(memRoot, { recursive: true });
    add(ok(true, '记忆目录可写'));
  } catch (e) {
    add(ok(false, '记忆目录可写', e.message));
  }

  /* ---------- 4. 语义触发 ---------- */
  log('\n【4】语义触发（离线打分）');
  const samples = ['在吗', '你觉得这个怎么样', '帮我看看这个报错', '今天吃什么', '哈哈哈', '哈哈哈哈'];
  for (const t of samples) {
    const r = intentScore(cfg, emojiToText(t), {});
    add(info(`「${t}」`, `${r.score}/${r.threshold} ${r.hit ? '→ 会回' : '→ 不回'}`));
  }
  add(info('提示', '分数贴阈值时最容易误判；可在 config.intent.threshold 调'));

  /* ---------- 5. 协议端 ---------- */
  log('\n【5】协议端连接');
  const client = new OneBotClient({ log: () => {}, ...(cfg.onebot || {}) });
  let connected = false;
  try {
    connected = await Promise.race([
      client.connect(),
      new Promise(r => setTimeout(() => r(false), 8000))
    ]);
  } catch (e) { connected = false; }
  add(ok(connected, 'WS 已连接', connected ? (client.selfId ? 'QQ ' + client.selfId : '已连上') : '检查 wsUrl / 协议端是否登录'));

  if (connected) {
    try {
      const gl = await client.callApi('get_group_list');
      const list = (gl && gl.data) || [];
      add(ok(Array.isArray(list), 'HTTP API 可用（get_group_list）', list.length + ' 个群'));
      if (list.length) {
        add(info('群列表', list.slice(0, 8).map(g => `${g.group_id}(${g.group_name || ''})`).join(' ')));
      }
    } catch (e) {
      add(ok(false, 'HTTP API 可用（get_group_list）', e.message));
    }

    /* 抓真实消息，看字段形状 */
    log(`\n【6】抓真实群消息（最多等 ${waitSec} 秒，期间在群里发一句话）`);
    const captured = [];
    client.on('group.message', m => { if (captured.length < 8) captured.push(m); });
    const t0 = Date.now();
    // 收满整个等待窗口：图片/表情往往在中间，提前退出会漏掉
    while (Date.now() - t0 < waitSec * 1000) {
      await new Promise(r => setTimeout(r, 500));
      if (captured.length >= 8) break;
    }
    if (!captured.length) {
      add(warn('没抓到群消息', '在群里随便发一句话再跑一次，或加 --wait 30'));
    } else {
      const m = captured[0];
      add(ok(!!m.groupId && !!m.userId && !!m.messageId, '消息基本字段齐全',
        `群=${m.groupId} 人=${m.userId} id=${m.messageId}`));
      add(ok(typeof m.text === 'string', '文本字段是字符串', JSON.stringify((m.text || '').slice(0, 20))));
      const hasImg = (m.images || []).length > 0;
      add(info('图片段', hasImg ? m.images.map(i => Object.keys(i).join('+')).join(' / ') : '本条消息没有图片'));
      if (hasImg) {
        const withUrl = (m.images || []).filter(i => i.url);
        add(ok(withUrl.length === (m.images || []).length, '图片带 url（识图可以直接用）',
          withUrl.length ? withUrl.length + ' 张有 url' : '只有 file 没有 url → 需要补 get_image 调用'));
      }
      const types = new Set();
      for (const x of captured) for (const t of (x.segments || [])) types.add(t);
      add(info('见到的消息段类型', [...types].join(',') || '（没有段信息）'));
      const allImgs = captured.flatMap(x => x.images || []);
      if (allImgs.length) {
        add(ok(allImgs.every(i => i.url), '图片段带 url',
          allImgs.map(i => i.url ? 'url✓' : 'file=' + (i.file || '?') + ' url✗').join(' / ')));
      } else {
        add(warn('这段时间没收到图片', '发一张图再跑一次，才能验证识图链路'));
      }
    }
  } else {
    add(warn('跳过协议端检查', '连不上就看不到真实数据形状'));
  }

  /* ---------- 7. 发送测试（可选） ---------- */
  if (sendGroup && connected) {
    log('\n【7】发送测试');
    try {
      const r = await client.sendGroup(sendGroup, '自检消息，可以忽略。');
      add(ok(!!r, '能往群里发消息', '发送成功'));
    } catch (e) {
      add(ok(false, '能往群里发消息', e.message));
    }
  }

  try { client.close(); } catch (e) { /* ignore */ }

  /* ---------- 汇总 ---------- */
  const bad = rows.filter(r => r.level === 'bad').length;
  const warnN = rows.filter(r => r.level === 'warn').length;
  log('\n' + '─'.repeat(64));
  log(`  结果：${bad ? bad + ' 项失败' : '关键项全部通过'}${warnN ? `，${warnN} 项提醒` : ''}`);
  if (bad) log('  把上面 ❌ 的整段贴出来，照着 detail 修。');
  log('─'.repeat(64) + '\n');
  return { ok: bad === 0, bad, warn: warnN, rows };
}
