#!/usr/bin/env node
/**
 * engine.js —— 业务核心，与"怎么启动"无关（CLI / 插件共用）。
 *
 *   const engine = new QQEngine(cfg, { log, cfgDir });
 *   await engine.start();
 *   engine.status();
 *   await engine.stop();
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OneBotClient } from './onebot.js';
import { makeBrain } from './brain.js';
import { GroupMemory } from './memory.js';
import { GroupAwareness } from './awareness.js';
import { loadPersonaFile } from './persona-file.js';
import { TempLog } from './templog.js';
import { verifySeal } from './politics-seal.js';
import { emojiToText } from './emoji.js';
import { PluginHost } from './plugin-host.js';
import * as R from './rules.js';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
const dayKey = () => new Date().toISOString().slice(0, 10);
const hourKey = () => new Date().toISOString().slice(0, 13);

/** 连 persona 文件都没有时的兜底 */
const FALLBACK_PERSONA = '你是一个群聊助手，说话简短口语化，一次不超过两句话。';

export class QQEngine {
  constructor(cfg, opts = {}) {
    // 公开版封印：政治限制被改过就拒绝启动，不给"悄悄放行"的机会
    if (cfg && cfg.politics && cfg.politics.sealed) {
      const v = verifySeal(cfg.politics.keywords);
      if (!v.ok) {
        throw new Error('[POLICY] ' + v.reason + '，拒绝启动。政治限制不可被修改或关闭。');
      }
    }
    this.cfg = cfg;
    this.log = opts.log || ((...a) => console.log(...a));
    this.cfgDir = opts.cfgDir || process.cwd();
    this.queueFile = opts.queueFile || '';
    this.stateFile = opts.stateFile || '';

    this.rules = {
      minIntervalMs: 5000, perGroupCooldownMs: 20000, maxPerHour: 20, dailyCap: 150,
      quietHours: ['00:30', '07:30'], maxReplyChars: 90, replyWithAt: true,
      ...(cfg.rules || {})
    };
    this.pro = {
      enabled: true, probability: 0.1, keywords: ['有人吗', '在干嘛', '好无聊'], maxPerHour: 3,
      ...(cfg.proactive || {})
    };

    // 自己的昵称 + 别名，用于判断"是不是在叫我"
    this.botNames = [(cfg.bot && cfg.bot.nick) || '']
      .concat((cfg.bot && cfg.bot.aliases) || [])
      .filter(Boolean);

    // 回复前缀清洗：所有可能的人格名都要认，不然换了人格前缀就洗不掉
    this._buildNamePrefix();

    // 作息表（若有）覆盖免打扰时段，保持单一来源
    if (cfg.schedule && cfg.schedule.enabled !== false) {
      this.rules.quietHours = [cfg.schedule.sleepAt || '00:00', cfg.schedule.wakeAt || '07:30'];
    }
    this._announced = new Map();
    this._inflight = new Set();   // 正在处理的群，防并发穿透节流

    this.state = { day: dayKey(), sent: 0, perHour: {}, lastReplyAt: {}, seen: new Set(), history: new Map() };
    if (this.stateFile) this._restoreState();

    this.personaCache = new Map();

    /* 彩蛋：关键词切换人格（多套） */
    this.easter = { enabled: false, durationMs: 3600000, globalReset: [], personas: [], ...(cfg.easter || {}) };
    /* 人格文件：一个文件装全部人格（默认 + 彩蛋），改文件即改人格 */
    this._loadPersonaSet();
    // 彩蛋人格按群隔离：群号 -> { activeId, activeUntil, echo }
    // 以前是实例级（一个群触发，所有群都变），真机测出串群后改成按群。
    this.personaByGroup = new Map();
    this._lastGid = '';
    this._personaOnAt = new Map();    // 切过去的人格冷却（按群）
    this._personaOffAt = new Map();   // 切回来的冷却（按群，独立计）
    this._personaHour = new Map();    // 每小时切换次数
    /* echo 存在每个群的 state 里，见 _pstate */

    /* 群记忆：一个群一个文件，物理隔离 */
    const memCfg = cfg.memory || {};
    // 实例隔离：不同插件实例各用一个目录，避免记忆互相混用
    // 结构：memory/<实例名>/<群号>/memory.json
    const instance = memCfg.instance || path.basename(this.cfgDir) || 'default';
    const memRoot = opts.memoryDir || path.join(this.cfgDir, 'memory', instance);
    this.mem = memCfg.enabled === false ? null
      : new GroupMemory(memRoot, {
          ...memCfg,
          aliases: memCfg.aliases || null   // 同义词表：{"双排":"开黑"}
        });
    this._memTick = new Map();

    /* 话题嗅觉：判断什么时候该开口（不调模型，纯内存） */
    const awCfg = cfg.awareness || {};
    this.aw = awCfg.enabled === false ? null
      : new GroupAwareness({
          windowMs: (awCfg.windowMinutes || 60) * 60000,
          activeMs: (awCfg.activeMinutes || 5) * 60000
        });
    this._awTickAt = 0;
    this._extracting = false;   // 记忆抽取全局锁

    /* 临时日志：每个群最近若干条消息，用来判断"是不是在跟我说话" */
    this.tempLog = new TempLog({ size: 10, maxAgeMinutes: 10, ...(cfg.templog || {}) });
    this.intent = { enabled: true, threshold: 3, imageCooldownMs: 20000, ...(cfg.intent || {}) };
    this.plugins = new PluginHost({ dir: path.join(this.cfgDir, 'plugins'), cfg: cfg.plugins || {}, brain: this.brain,
      personaOf: (gid) => {
        const id = this._currentPersonaId(gid);
        const all = [this.personaSet && this.personaSet.default, ...((this.personaSet && this.personaSet.easter) || [])].filter(Boolean);
        const p = all.find(x => x.id === id);
        return p ? { id: p.id, name: p.name, nick: p.nick, webSearch: p.webSearch } : null;
      },
      log: (...a) => this.log(...a) });
    this._visionAt = new Map();   // 每个群上次识图时间，防止刷图就答
    this._imgSeen = new Map();    // 群号 -> Map(图片指纹 -> 时间)，同图不重复识别
    this._pending = new Map();    // 群号 -> 待判断消息缓冲（满 20 条才看一次）
    // 图片档案：同一张图出现多次就拉黑，之后不再回
    // 存 <记忆目录>/image-archive.json，拉黑的再单独写一份到 blocked-images/
    this._imgArchive = {};
    this._imgArchiveDirty = false;
    this._loadImgArchive();

    this.brain = makeBrain(cfg.llm, this.log);
    this.client = new OneBotClient({ log: this.log, ...(cfg.onebot || {}) });
    this.client.on('ready', e => this.log('[engine] 已登录', e.selfId));
    this.client.on('group.message', m => {
      this.handle(m).catch(e => this.log('[ERR]', e.message));
    });
  }

  /* ================= 人格 ================= */

  /**
   * 重建"回复前缀清洗"正则。
   * 人格文件热重载可能改掉昵称/别名，这里必须跟着重建，否则新名字的「昵称：」洗不掉。
   */
  _buildNamePrefix() {
    const names = [...new Set([...(this.botNames || []), '小鲸鱼', '鲸鱼娘', '大肥鱼', '长征酱', '逻辑', 'AI'])];
    this._namePrefix = new RegExp('^(' + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')[:：]\\s*');
  }

  /** 人格文件：绝对路径 → 配置同目录 → 插件目录，逐级回退 */
  _readPersona(file, label) {
    if (!file) return null;
    if (this.personaCache.has(file)) return this.personaCache.get(file);
    const cands = path.isAbsolute(file)
      ? [file]
      : [path.resolve(this.cfgDir, file), path.resolve(MODULE_DIR, file)];
    for (const p of cands) {
      try {
        const t = fs.readFileSync(p, 'utf8').trim();
        if (t) {
          this.personaCache.set(file, t);
          this.log('[persona] ' + label + '已加载 ' + p + '（' + t.length + ' 字）');
          return t;
        }
      } catch (e) { /* 试下一个 */ }
    }
    this.log('[persona] ' + label + '没找到：' + file);
    return null;
  }

  /**
   * 读取人格文件（一个文件装全部人格）。
   * 改文件后下次调用会自动重新加载（按 mtime 判断），不用重启。
   */
  _loadPersonaSet() {
    const rel = (this.cfg && this.cfg.personaFile) || './persona.md';
    this._personaPath = path.isAbsolute(rel) ? rel : path.resolve(this.cfgDir, rel);
    try { this._personaMtime = fs.statSync(this._personaPath).mtimeMs; } catch (e) { this._personaMtime = 0; }

    const set = loadPersonaFile(this._personaPath, fs, this.log);
    this.personaSet = set;

    const def = set.default;
    this.persona = (def && def.text) || this.cfg.persona || FALLBACK_PERSONA;
    if (def) {
      if (def.nick) this.cfg.bot = { ...(this.cfg.bot || {}), nick: def.nick };
      const al = (def.aliases || []).filter(Boolean);
      if (al.length) this.cfg.bot = { ...(this.cfg.bot || {}), aliases: al };
      this.log('[persona] 默认人格「' + def.name + '」已加载（' + this.persona.length + ' 字）');
    }
    // 人格文件里的彩蛋优先于 config；没有就用 config 里的（向后兼容）
    if (set.easter.length) {
      this.easter.personas = set.easter;
      if (set.globalReset.length) this.easter.globalReset = set.globalReset;
      this.log('[persona] 彩蛋人格 ' + set.easter.length + ' 个：' + set.easter.map(p => p.id).join(' / '));
    }
    // 按人格 id 索引的晚安/早安台词
    this._personaLines = {};
    for (const p of [def, ...set.easter].filter(Boolean)) {
      if (p.sleep || p.wake) this._personaLines[p.id] = { sleep: p.sleep, wake: p.wake };
    }
    // 昵称进触发名单
    if (def) {
      const names = new Set([...(this.botNames || []), def.nick, ...(def.aliases || [])].filter(Boolean));
      this.botNames = [...names];
      this._buildNamePrefix();          // 新昵称/别名要能被前缀清洗认出来
    }
  }

  /** 文件变了就重载（按 mtime，开销只是一次 stat） */
  _maybeReloadPersonas() {
    if (!this._personaPath) return;
    // 节流：statSync 在手机上约 0.5ms，每条消息都查会把吞吐拖慢几十倍。
    // 2 秒检查一次，热重载的体感没有区别。
    const t = now();
    if (t - (this._personaStatAt || 0) < 2000) return;
    this._personaStatAt = t;
    try {
      const m = fs.statSync(this._personaPath).mtimeMs;
      if (m !== this._personaMtime) {
        this.log('[persona] 检测到人格文件变化，重新加载');
        this._loadPersonaSet();
      }
    } catch (e) { /* 文件暂时不可读就保持现状 */ }
  }

  _personaSpec() {
    this._maybeReloadPersonas();
    return Array.isArray(this.easter.personas) ? this.easter.personas : [];
  }

  /** 取某个群的彩蛋状态（没给群号就用最近处理的群，兼容旧调用） */
  _pstate(gid) {
    const k = String(gid == null || gid === '' ? (this._lastGid || '') : gid);
    let st = this.personaByGroup.get(k);
    if (!st) { st = { activeId: null, activeUntil: 0, echo: null }; this.personaByGroup.set(k, st); }
    return st;
  }

  /** 当前生效人格：彩蛋未过期用彩蛋人格，否则默认（按群） */
  activePersona(gid) {
    this._maybeReloadPersonas();
    const st = this._pstate(gid);
    if (st.activeUntil > now() && st.activeId) {
      const spec = this._personaSpec().find(p => p.id === st.activeId);
      const t = spec && (spec.text || this._readPersona(spec.personaFile, '彩蛋人格'));
      if (t) return t;
    }
    return this.persona;
  }

  personaState(gid) {
    const st = this._pstate(gid);
    const on = st.activeUntil > now() && !!st.activeId;
    return { activeId: on ? st.activeId : null, until: on ? st.activeUntil : 0, leftMs: on ? st.activeUntil - now() : 0 };
  }

  /**
   * 切人格的节流：切换和恢复各算各的冷却（互不阻塞），
   * 外加每群每小时次数上限。返回 false 表示这次不放行。
   */
  _allowPersonaSwitch(gid, kind) {
    const e = this.easter;
    const map = kind === 'on' ? this._personaOnAt : this._personaOffAt;
    const cool = kind === 'on' ? (e.cooldownMs ?? 60000) : (e.resetCooldownMs ?? 10000);
    const last = map.get(gid) || 0;
    const nowTs = now();
    if (nowTs - last < cool) {
      this.log('[彩蛋] ' + (kind === 'on' ? '切换' : '恢复') + '冷却中，忽略（还需 '
        + Math.ceil((cool - (nowTs - last)) / 1000) + ' 秒）');
      return false;
    }
    const hk = String(gid) + '|' + hourKey();
    const used = this._personaHour.get(hk) || 0;
    if (used >= (e.maxPerHour ?? 6)) {
      this.log('[彩蛋] 本群本小时切换次数已达上限（' + used + '）');
      return false;
    }
    map.set(gid, nowTs);
    this._personaHour.set(hk, used + 1);
    if (this._personaHour.size > 200) {
      const keep = hourKey();
      for (const k of [...this._personaHour.keys()]) if (!k.endsWith(keep)) this._personaHour.delete(k);
    }
    return true;
  }

  /** 台词可以是字符串，也可以是数组（随机取一句，避免重复） */
  _pickLine(v) {
    return R.pickLine(v);
  }

  async _activate(msg, spec) {
    if (!spec.text && !this._readPersona(spec.personaFile, '彩蛋人格')) {
      this.log('[彩蛋] 人格文件缺失，忽略');
      return;
    }
    const st = this._pstate(msg.groupId);
    st.activeId = spec.id;
    const dur = spec.durationMs != null ? spec.durationMs : this.easter.durationMs;
    st.activeUntil = dur > 0 ? now() + dur : Number.MAX_SAFE_INTEGER;
    this.log('[彩蛋] 人格切换 → ' + spec.id + '（' + Math.round((dur || 0) / 60000) + ' 分钟后自动恢复）');
    const line = this._pickLine(spec.switchLine);
    if (line) await this._say(msg, line);
  }

  async _deactivate(msg, spec) {
    const st = this._pstate(msg.groupId);
    const prev = st.activeId;
    st.activeId = null;
    st.activeUntil = 0;
    this.log('[彩蛋] 人格恢复 → 默认人格（退出 ' + prev + '）');
    // 切回来时留下一点模糊印象，下一次回复会带上
    if (spec && spec.echo) st.echo = spec.echo;
    const line = this._pickLine(spec && spec.resetLine);
    if (line) await this._say(msg, line);
    // 退场词是这个人格说的，紧接着让默认人格"上线"，否则风格断层
    const back = this._pickLine(this.easter.returnLine);
    if (back) {
      if ((this.cfg.mode || 'dry') !== 'dry') await sleep(600);
      await this._say(msg, back);
    }
  }

  /** 彩蛋台词直发（遵守 dry/manual/auto） */
  async _say(msg, text) {
    return this._emit(msg.groupId, text, {
      kind: 'announce',
      atUid: this.rules.replyWithAt && msg.atMe ? msg.userId : null
    });
  }

  /* ================= 生命周期 ================= */
  async start() {
    await this.plugins.load();
    this.plugins.watch();
    const ok = await this.client.connect();
    if (!this._timer && this.cfg.schedule && this.cfg.schedule.enabled !== false) {
      this._tick().catch(() => {});
      this._timer = setInterval(() => this._tick().catch(() => {}), 20000);
    }
    // 话题嗅觉每分钟评估一次（冷场引出 / 伺机插话）
    if (!this._awTimer && this.aw) {
      this._awTimer = setInterval(() => this._awarenessTick().catch(() => {}), 60000);
    }
    return ok;
  }

  async stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._awTimer) { clearInterval(this._awTimer); this._awTimer = null; }
    if (this.mem) this.mem.flushAll();     // 退出前把没落盘的记忆写完
    this.client.close();
  }

  /* ================= 判断 ================= */

  groupCfg(groupId) {
    const found = (this.cfg.groups || []).find(g => String(g.id) === String(groupId));
    if (found) return found;
    // 自动接纳：被拉进任何新群都能开口（用 groupDefaults 的保守默认值）
    if (this.cfg.autoAcceptNewGroups === true) {
      if ((this.cfg.blockedGroups || []).some(x => String(x) === String(groupId))) return null;
      return {
        id: groupId, name: '(自动接纳 ' + groupId + ')', enable: true,
        proactive: (this.cfg.groupDefaults || {}).proactive === true, auto: true
      };
    }
    return null;
  }

  inQuietHours() {
    const q = this.rules.quietHours;
    if (!q || q.length !== 2) return false;
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const a = toMin(q[0]), b = toMin(q[1]);
    return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
  }

  rollDay() {
    if (this.state.day === dayKey()) return;
    this.state.day = dayKey();
    this.state.sent = 0;
    this.state.perHour = {};
    this._saveState();
  }

  /** 清掉不属于今天的按小时计数，避免 state.json 天长日久堆成山 */
  _pruneHourly() {
    const today = dayKey();
    for (const k of Object.keys(this.state.perHour)) {
      if (!k.includes(today)) delete this.state.perHour[k];
    }
  }

  /* 计数持久化：重启不丢今日用量（否则重启一次就等于刷新了日上限） */
  _saveState() {
    if (!this.stateFile) return;
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({
        day: this.state.day, sent: this.state.sent,
        perHour: this.state.perHour, lastReplyAt: this.state.lastReplyAt,
        announced: [...this._announced.keys()]      // 公告记录也要落盘，否则重启会重发
      }));
    } catch (e) { this.log('[state] 保存失败：' + e.message); }
  }

  _restoreState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      // 公告记录无论哪一天都恢复：防止跨零点后的同一条重发
      for (const k of (raw.announced || [])) this._announced.set(k, true);
      if (raw.day !== dayKey()) return;          // 计数跨天就作废
      this.state.sent = Number(raw.sent) || 0;
      this.state.perHour = raw.perHour || {};
      this.state.lastReplyAt = raw.lastReplyAt || {};
      this._pruneHourly();
      this.log('[state] 恢复计数：今日已发 ' + this.state.sent);
    } catch (e) { /* 首次运行 / 文件损坏：当作全新开始 */ }
  }

  /** 时间块：只给时段和星期，不给年份 */
  _timeBlock() {
    const d = new Date();
    const wd = ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()];
    const h = d.getHours();
    const seg = h < 6 ? '凌晨' : h < 11 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
    return '\n\n【现在】' + wd + '，' + seg + ' ' + h + ' 点';
  }

  decide(msg, g) {
    if (msg.isSelf) return { yes: false, why: '自己发的' };
    if (!msg.text && !msg.images.length) return { yes: false, why: '空消息' };
    if (msg.text && msg.text.length > 800) return { yes: false, why: '太长' };

    const st = this.state;
    if (st.sent >= this.rules.dailyCap) return { yes: false, why: '日上限' };
    if ((st.perHour[hourKey()] || 0) >= this.rules.maxPerHour) return { yes: false, why: '小时上限' };
    if (this.inQuietHours()) return { yes: false, why: '免打扰' };
    if (now() - (st.lastReplyAt['__global'] || 0) < this.rules.minIntervalMs) return { yes: false, why: '全局间隔' };
    if (now() - (st.lastReplyAt[msg.groupId] || 0) < this.rules.perGroupCooldownMs) return { yes: false, why: '本群冷却' };

    if (msg.atMe) return { yes: true, why: '@我(at段)', kind: 'mention' };
    // 明确 @ 了别人：这句话是跟那个人说的，不凑热闹。
    // 兜底：有的客户端不给 at 段，只给「@张三」这种纯文本，也按 @ 别人处理。
    let othersAt = !!msg.atOthers;
    if (!othersAt && !msg.atMe) {
      const m = String(msg.text || '').match(/^@([^\s\u2005]+)/);
      if (m && !this._activeNames(msg.groupId).some(n => n && (m[1] === n || m[1].includes(n)))) othersAt = true;
    }
    if (othersAt) return { yes: false, why: '@的是别人' };
    // 有的客户端会把 @ 拍平成纯文本，所以再按昵称匹配一次
    const called = this._activeNames(msg.groupId).some(n => msg.text.includes('@' + n) || msg.text.includes(n));
    if (called) return { yes: true, why: '被叫名字', kind: 'mention' };

    // 直接请求（"我问你个事""请求你…"）：不用等分批，立刻接
    if (R.isDirectRequest(emojiToText(msg.text || ''))) {
      return { yes: true, why: '直接请求', kind: 'request' };
    }

    // —— 语义触发：取代原来的随机概率 ——
    // 依据：当前这句话 + 临时日志里的现场（刚才是谁在说、机器人是不是刚说过话）
    if (this.intent.enabled !== false) {
      const text = emojiToText(msg.text || '');
      const hasImage = !!(msg.images && msg.images.length);
      // 注意：handle 已经把当前这条写进临时日志了，这里要排除掉，
      // 否则"别人刚问过吗"会因为自己这条而误判，把自己扣分。
      const recent = this.tempLog.recent(msg.groupId, 9).slice(0, -1);
      const afterBot = now() - (st.lastReplyAt[msg.groupId] || 0) < 120000;   // 上次在本群回过话
      const recentQuestion = recent.slice(-3).some(e => !e.isSelf && /[?？]|吗|呢/.test(e.text));
      // 图片：不再"看到就识图"，先按现场判断值不值得看
      let imageBonus = 0;
      if (hasImage) {
        // 档案里已标记为重复刷图：永久不再回
        if (this._imgBlocked(msg.images)) return { yes: false, why: '重复刷图（已拉黑）' };
        // 内容去重：同一张图（url/file 一致）在 TTL 内不再识别，省调用也防重复记
        const key = this._imgKey(msg.images);
        if (key) {
          const seen = this._imgSeen.get(msg.groupId);
          const ts = seen && seen.get(key);
          if (ts && now() - ts < (this.intent.imageDedupMs ?? 90000)) {   // 0 = 关闭去重
            return { yes: false, why: '重复图片（已看过）' };
          }
        }
        const coolMs = this.intent.imageCooldownMs ?? 20000;   // 0 = 关闭冷却
        if (now() - (this._visionAt.get(msg.groupId) || 0) < coolMs) {
          return { yes: false, why: '图片冷却中' };
        }
        const humanRecent = recent.filter(x => !x.isSelf).length;
        const chatting = humanRecent >= 2;
        if (text.trim()) imageBonus += 1;                          // 配了文字
        if (afterBot) imageBonus += 2;                             // 刚回过话，多半是回应我
        if (chatting) imageBonus += 2;                             // 有上下文
        if (!text.trim() && !afterBot && !chatting) imageBonus -= 2;  // 纯刷图，不接
      }

      const th = this._intentThreshold(msg.groupId);
      const r = R.intentScore(this.cfg, text, {
        hasImage, imageBonus, afterBot, recentQuestion, threshold: th,
        othersAt: !!msg.atOthers          // @了别人：这句话里的"你"指的是那个人
      });
      if (r.hit) {
        if (hasImage) {
          this._visionAt.set(msg.groupId, now());
          const key = this._imgKey(msg.images);
          if (key) {
            let seen = this._imgSeen.get(msg.groupId);
            if (!seen) { seen = new Map(); this._imgSeen.set(msg.groupId, seen); }
            seen.set(key, now());
            while (seen.size > 30) seen.delete(seen.keys().next().value);   // 只留最近 30 张
          }
        }
        return { yes: true, why: `语义触发 ${r.score}/${r.threshold}`, kind: hasImage ? 'vision' : 'intent' };
      }
    }
    if (this.pro.enabled && g.proactive && this.pro.keywords.length) {
      const proHour = st.perHour['pro_' + hourKey()] || 0;
      if (proHour < this.pro.maxPerHour && this.pro.keywords.some(k => msg.text.includes(k))) {
        return { yes: true, why: '关键词', kind: 'proactive' };
      }
    }
    return { yes: false, why: '未触发' };
  }

  sanitize(text) {
    return R.sanitize(this.cfg, text, this._namePrefix);
  }

  /* ================= 主流程 ================= */

  _countSent(groupId) {
    this.state.sent++;
    this.state.lastReplyAt[groupId] = now();
    this.state.lastReplyAt['__global'] = now();
    this.state.perHour[hourKey()] = (this.state.perHour[hourKey()] || 0) + 1;
    this._saveState();
  }

  pushHistory(groupId, role, content) {
    const h = this.state.history.get(groupId) || [];
    h.push({ role, content });
    const cap = ((this.cfg.history && this.cfg.history.size) || 16) * 2;
    while (h.length > cap) h.shift();
    this.state.history.set(groupId, h);
  }

  async handle(msg) {
    this._maybeReloadPersonas();
    this.rollDay();
    // 静默时段：完全不受理（彩蛋触发也一并忽略）
    if (this.isSleeping()) return;

    this._lastGid = msg.groupId;      // 兼容不带群号的调用（测试/外部工具）

    const g = this.groupCfg(msg.groupId);
    if (!g || g.enable === false) return;

    // 去重
    const key = String(msg.messageId || (msg.groupId + ':' + msg.userId + ':' + msg.time));
    if (this.state.seen.has(key)) return;
    this.state.seen.add(key);
    if (this.state.seen.size > 2000) this.state.seen = new Set([...this.state.seen].slice(-1000));

    // 记一笔"有人说话了"——话题嗅觉靠这个判断冷暖和节奏
    const plainText = emojiToText(msg.text || '');
    if (this.aw && !msg.isSelf) this.aw.noteHuman(msg.groupId, msg.sender, plainText);
    // 临时日志：判断"要不要接话"的现场依据
    this.tempLog.add(msg.groupId, {
      sender: msg.sender, text: plainText,
      hasImage: !!(msg.images && msg.images.length), isSelf: msg.isSelf
    });
    if (!msg.isSelf && msg.images && msg.images.length) this._imgNote(msg.images);
    if (!msg.isSelf) {
      const buf = this._pending.get(msg.groupId) || [];
      buf.push({ text: plainText, ts: now() });
      while (buf.length > (this.intent.batchSize || 20)) buf.shift();
      this._pending.set(msg.groupId, buf);
    }

    // 同一个群同一时刻只处理一条。
    // 模型要 1~2 秒才返回，冷却时间戳是等返回后才写的；
    // 不在这里串行化，同一秒连发的几条消息会全部穿透节流各回一遍。
    if (this._inflight.has(msg.groupId)) return;
    this._inflight.add(msg.groupId);
    try {
      await this._process(msg, g);
    } catch (err) {
      this.log('[ERR] 处理消息异常：' + err.message);
    } finally {
      this._inflight.delete(msg.groupId);
    }
  }

  async _process(msg, g) {
    const pst = this._pstate(msg.groupId);   // 本群的彩蛋状态
    // 记人（零成本）：谁在这个群说话
    if (this.mem && !msg.isSelf) {
      this.mem.noteMember(msg.groupId, msg.userId, msg.sender);
      this.mem.flush(msg.groupId);
      // 显式记忆：「记住：xxx」
      const m = /记住[:：,，\s]+([^\n]{2,120})/.exec(msg.text || '');
      if (m && this.mem.addFact(msg.groupId, m[1], msg.sender)) {
        this.log('[memory] 群 ' + msg.groupId + ' 记住：' + m[1].slice(0, 40));
      }
    }

    // 不再无条件写正式历史：只有"被回答过"的对话才进正式日志（在 _deliver 里写）

    /* 彩蛋关键词：优先于普通回复，命中即返回 */
    if (this.easter.enabled && msg.text && !msg.isSelf) {
      const t = msg.text;
      // 是否"对着它说"：@ 了、或者提到昵称。只有这种语气才算有效指令。
      const directed = msg.atMe || this._activeNames(msg.groupId).some(n => n && t.includes(n));
      const dur = this.easter.durationMs;
      const renew = (id) => {
        if (dur > 0 && pst.activeUntil > now()) {
          pst.activeUntil = now() + dur;
          this.log('[彩蛋] 续期「' + id + '」→ ' + Math.round(dur / 60000) + ' 分钟');
        }
      };

      const hit = this._personaSpec().find(p => (p.trigger || []).some(k => k && t.includes(k)));
      if (hit) {
        if (pst.activeId === hit.id) {
          // 已经是这个人格了：被叫到时续期，多人聊天里不会聊着聊着就掉回默认
          if (directed) renew(hit.id);
          this.log('[彩蛋] 已是「' + hit.id + '」，忽略重复触发');
          return;
        }
        if (!this._allowPersonaSwitch(msg.groupId, 'on')) return;
        this.log('[彩蛋] 命中「' + hit.id + '」触发词：' + t.slice(0, 30));
        return this._activate(msg, hit);
      }

      const cur = this._personaSpec().find(p => p.id === pst.activeId);
      const off = (cur && (cur.reset || []).some(k => k && t.includes(k)))
        || (this.easter.globalReset || []).some(k => k && t.includes(k));
      if (off && pst.activeUntil > now()) {
        // 恢复词的"误伤"防护：只有对着它说、或整句就是这一句（<=8 字）才生效。
        // 否则群友闲聊里顺口带出恢复词，会把人格直接打回默认。
        const shortMsg = t.trim().length <= 8;
        if (directed || shortMsg) {
          if (!this._allowPersonaSwitch(msg.groupId, 'off')) return;
          this.log('[彩蛋] 命中恢复词：' + t.slice(0, 30));
          return this._deactivate(msg, cur);
        }
        this.log('[彩蛋] 恢复词出现在普通语句里，忽略（群友闲聊不算指令）');
      }

      // 被叫到时续期：活跃对话里人格不会自然过期
      if (pst.activeId && directed) renew(pst.activeId);
    }

    // 分批判断：@ / 被叫名字 / 直接请求 → 立刻处理并清空缓冲；
    // 否则先攒着，攒满 batchSize 条才看一次，避免每句话都插嘴。
    const plainReq = emojiToText(msg.text || '');
    const namedNow = this._activeNames(msg.groupId).some(n => n && (plainReq.includes('@' + n) || plainReq.includes(n)));
    // 呼叫词不再单独触发：得带上名字（"小鲸鱼在吗"）或 @ 才算
    const immediate = msg.atMe || namedNow || R.isDirectRequest(plainReq);
    if (immediate) {
      this._pending.set(msg.groupId, []);          // 被点名：抛弃当前的积压
    } else if ((this._pending.get(msg.groupId) || []).length < (this.intent.batchSize || 20)) {
      return;                                       // 没攒够，先不说话
    } else {
      // 满一批：不是只看最后一条，而是把整批过一遍，取最高分那条当重点
      const batch = this._pending.get(msg.groupId) || [];
      const th = this._intentThreshold(msg.groupId);
      let best = -Infinity, bestText = '';
      for (const b of batch) {
        const sc = R.intentScore(this.cfg, b.text, { threshold: th }).score;
        if (sc > best) { best = sc; bestText = b.text; }
      }
      this._pending.set(msg.groupId, []);
      // 整批都不够格时，别急着放弃：主动搭话关键词也算数
      if (best < th) {
        const kwHit = this.pro.enabled && g.proactive && this.pro.keywords.length
          && batch.some(b => this.pro.keywords.some(k => b.text.includes(k)));
        if (!kwHit) return;
      }
      msg._focus = bestText;                        // 留给 prompt 标重点
    }

    const d = this.decide(msg, g);
    if (!d.yes) {
      // 静默丢弃也要留痕：为什么没回
      this.log('[skip] 不回：' + (d.why || '未触发'));
      // 不说话的时候，记下来慢慢学；隔一阵自己查
      this.plugins.message(msg);
      return;
    }
    this.log(`[HIT:${d.kind}] ${msg.sender}(${msg.userId}): ${msg.text.slice(0, 60)}`);

    let reply;
    if (this._politicsHit(msg.text)) {
      this.log('[guard] 政治话题 → 拒绝');
      reply = this.sanitize(this._politicsLine(msg.groupId));
    } else if (this._scopeHit(msg.text)) {
      this.log('[scope] 开发类请求 → 拒绝（' + (this._currentPersonaId(msg.groupId)) + '）');
      reply = await this._refuse(msg);
    } else {
      let persona = this.activePersona(msg.groupId);
      if (this.mem) persona += this.mem.prompt(msg.groupId, msg.text);   // 只注入本群
      if (!this.personaState(msg.groupId).activeId && pst.echo) {
        persona += '\n\n【残留记忆】' + pst.echo + '（只在这次回复里隐约透出来，别直白解释。）';
        pst.echo = null;
      }
      let txt;
      try {
        const anchor = this._personaAnchor(msg.groupId);
        if (anchor) persona += '\n\n【必须保持的格式】' + anchor;
        const recentChat = this.tempLog.segment(msg.groupId, 8);
        const ctxBlock = recentChat ? '\n\n【刚才群里在聊】\n' + recentChat : '';
        const focusBlock = (msg._focus ? '\n\n【重点】' + msg._focus : '') + this._searchNudge() + this.plugins.promptAdd(msg);
        txt = await this.brain.reply({
          persona: persona + ctxBlock + focusBlock + this._timeBlock() + this._politicsRule() + this._scopeRule() + this._styleRule(),
          history: (this.state.history.get(msg.groupId) || []).slice(-16),
          text: (msg.sender ? msg.sender + '：' : '') + (emojiToText(msg.text || '') || '[用户发来图片]'),
          images: msg.images
        });
      } catch (err) {
        // 网络中断 / 5xx / 超时：这条消息直接放弃，不能把进程带崩
        this.log('[ERR] 模型调用失败，本轮跳过：' + err.message);
        return;
      }
      reply = this.sanitize(txt);
      // 人格若声明了"必须带的格式"（如逻辑的 // 修正），这里强制补齐
      reply = await this._enforceStyle(reply, msg);
    }
    if (!reply) return this.log('[skip] 回复为空/命中敏感词');
    await this._deliver(msg, reply, d.kind);
  }

  /** 按 dry/manual/auto 投递一条回复 */
  async _deliver(msg, reply, kind) {
    const mode = this.cfg.mode || 'dry';
    if (mode === 'dry') {
      this.log(`[DRY] ${msg.sender}: ${msg.text.slice(0, 40)} → ${reply}`);
      return this.pushHistory(msg.groupId, 'assistant', reply);
    }
    if (mode === 'manual') {
      const id = now().toString(36);
      if (this.queueFile) {
        fs.appendFileSync(this.queueFile, JSON.stringify({
          id, ts: now(), groupId: msg.groupId, sender: msg.sender, text: msg.text, reply, status: 'pending'
        }) + '\n');
      }
      return this.log(`[QUEUE ${id}] ${msg.sender}: ${msg.text.slice(0, 40)} → ${reply}`);
    }
    const r = await this._emit(msg.groupId, reply, {
      kind: kind || 'reply',
      atUid: this.rules.replyWithAt && msg.atMe ? msg.userId : null,
      sender: msg.sender, src: msg.text
    });
    if (!r) return;
    // 被回答的对话才进正式日志（成对写入），临时日志随即清空
    this.pushHistory(msg.groupId, 'user', msg.sender + ': ' + (emojiToText(msg.text || '') || '[图片]'));
    this.pushHistory(msg.groupId, 'assistant', reply);
    this.tempLog.clear(msg.groupId);
    this._pending.set(msg.groupId, []);
    this._maybeExtract(msg).catch(() => {});
  }

  /* ============ 能力边界：只聊天 + 识图 ============ */

  _scope() { return this.cfg.scope || {}; }

  /** 命中开发/写码类关键词 */
  /**
   * 是否构成「开发类请求」——三层判断，避免只看关键词误伤：
   *   1) 必须提到开发话题（keywords）
   *   2) 必须有请求语气（requestMarkers）
   *   3) 没有吐槽/感叹语气（ventMarkers）
   * 只提到但不像请求的，交给模型按上下文判断（system prompt 里还有软约束兜底）。
   */
  _scopeHit(text) {
    return R.scopeHit(this.cfg, text);
  }

  /* ---------- 强限制：政治话题 ---------- */

  _pol() { return this.cfg.politics || {}; }

  /** 命中即拒——政治话题没有"只是提起"这回事，不做意图判断 */
  _politicsHit(text) {
    return R.politicsHit(this.cfg, text);
  }

  /** 按当前人格选话术（各自 3 句轮换） */
  _politicsLine(gid) {
    return R.politicsLine(this.cfg, this.personaState(gid).activeId);
  }

  /** 拼进 prompt 的硬规则，兜住关键词漏网的 */
  _politicsRule(gid) {
    return R.politicsRule(this.cfg, this.personaState(gid).activeId);
  }

  _refusalLine(gid) {
    return R.refusalLine(this.cfg, this.personaState(gid).activeId) || R.refusalFallback(this.cfg);
  }

  /**
   * 拒绝一个开发类请求。
   *   ① 配置里给这个人格写了话术 → 直接用（不调模型，省钱、可预期）
   *   ② 没写 → 让模型用当前人格说一句（自然，多一次调用）
   *   ③ 模型失败/输出为空 → 冷兜底「抱歉，我做不到。」
   */
  /** 这段文本像不像代码（拒绝路径必须挡住，否则等于绕过能力边界） */
  _looksLikeCode(t) {
    const x = String(t || '');
    return /```|^\s*(def |import |from \w+ import|function |const |let |var |class |public |private |void |print\(|console\.log|#include|SELECT )/m.test(x)
      || /(^|\n)\s*(for|while|if)\s*\([^)]*\)\s*\{/.test(x);
  }

  async _refuse(msg) {
    const preset = R.refusalLine(this.cfg, this.personaState(msg.groupId).activeId);
    if (preset) return this.sanitize(preset);

    const mode = (this.cfg.scope && this.cfg.scope.refusalMode) || 'hybrid';
    if (mode !== 'fixed') {
      try {
        const txt = await this.brain.reply({
          persona: this.activePersona(msg.groupId)
            + '\n\n【任务】对方在让你做开发类的事（写代码/改代码/部署/查报错）。'
            + '用你的人格说一句拒绝，一句话，语气像平时说话，不要解释规则、不要说"我的设定"，不要输出任何代码。'
            + '拒绝之后可以自然带一句别的，但别超过两句。',
          history: [], text: msg.text || '', images: []
        });
        const clean = this.sanitize(txt);
        // 拒绝里夹代码 = 绕过能力边界，直接作废走冷兜底
        if (clean && this._looksLikeCode(clean)) {
          this.log('[scope] 人格化拒绝里出现代码，丢弃');
        } else if (clean) return clean;
      } catch (e) {
        this.log('[scope] 人格化拒绝失败：' + e.message);
      }
    }
    return this.sanitize(R.refusalFallback(this.cfg)) || '抱歉，我做不到。';
  }

  /** 篇幅规则：从配置生成，改一次全人格生效 */
  _styleRule() {
    return R.styleRule(this.cfg);
  }

  /** 拼进 system prompt 的软约束（兜住关键词漏网的情况） */
  _scopeRule() {
    return R.scopeRule(this.cfg);
  }

  /* ================= 作息：晚安 / 早安 ================= */

  _schedule() { return this.cfg.schedule || {}; }

  _toMin(s) { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); }

  /** 当前该不该静默（不受理任何对话） */
  isSleeping() { return this.inQuietHours(); }

  _loadImgArchive() {
    try {
      const dir = this.mem ? this.mem.dir : this.cfgDir;
      const f = path.join(dir, 'image-archive.json');
      if (fs.existsSync(f)) this._imgArchive = JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (e) { this._imgArchive = {}; }
  }

  _saveImgArchive() {
    if (!this._imgArchiveDirty) return;
    this._imgArchiveDirty = false;
    try {
      const dir = this.mem ? this.mem.dir : this.cfgDir;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'image-archive.json'), JSON.stringify(this._imgArchive));
    } catch (e) { /* 只读盘也能跑，内存里还在 */ }
  }

  /** 记一笔图片出现次数；到阈值就拉黑，并写进 blocked-images/ */
  _imgNote(images) {
    const key = this._imgKey(images);
    if (!key) return;
    const rec = this._imgArchive[key] || { count: 0, first: now(), last: 0, blocked: false };
    rec.count++;
    rec.last = now();
    const limit = (this.cfg.images && this.cfg.images.blockAfter) || 3;
    if (!rec.blocked && rec.count >= limit) {
      rec.blocked = true;
      try {
        const dir = path.join(this.mem ? this.mem.dir : this.cfgDir, 'blocked-images');
        fs.mkdirSync(dir, { recursive: true });
        const name = key.replace(/[^\w.-]/g, '_').slice(0, 80) + '.json';
        fs.writeFileSync(path.join(dir, name), JSON.stringify({ key, count: rec.count, first: rec.first, last: rec.last }, null, 1));
      } catch (e) {}
      this.log('[image] 标记为重复刷图，不再回：' + key.slice(0, 40));
    }
    this._imgArchive[key] = rec;
    this._imgArchiveDirty = true;
    clearTimeout(this._imgSaveTimer);
    this._imgSaveTimer = setTimeout(() => this._saveImgArchive(), 3000);
    if (this._imgSaveTimer.unref) this._imgSaveTimer.unref();
  }

  _imgBlocked(images) {
    const key = this._imgKey(images);
    const rec = key && this._imgArchive[key];
    return !!(rec && rec.blocked);
  }

  /** 图片指纹：优先 file（协议端一般给内容哈希），没有再退回 url */
  _imgKey(images) {
    return (images || []).map(i => i.file || i.url || '').filter(Boolean).sort().join('|');
  }

  /**
   * 强制说话方式：人格可以用 requirePattern 声明"每句话必须带的东西"。
   * 不符合就重试一次；仍不符合，用兜底句保证一定带上。
   */
  async _enforceStyle(reply, msg) {
    const id = this._currentPersonaId(msg.groupId);
    const all = [this.personaSet && this.personaSet.default, ...((this.personaSet && this.personaSet.easter) || [])].filter(Boolean);
    const p = all.find(x => x.id === id);
    if (!p || !p.requirePattern) return reply;
    let re;
    try { re = new RegExp(p.requirePattern); } catch (e) { return reply; }
    if (re.test(reply)) return reply;

    // 第一次补救：明确提醒后再生成一次
    try {
      const again = await this.brain.reply({
        persona: this.activePersona(msg.groupId) + '\n\n【必须】' + (p.requireHint || '回复必须带上指定格式'),
        history: (this.state.history.get(msg.groupId) || []).slice(-8),
        text: emojiToText(msg.text || '') || '[用户发来图片]', images: []
      });
      const clean = this.sanitize(again);
      if (clean && re.test(clean)) return clean;
      if (clean && p.requireFallback) return this.sanitize(clean + '\n' + p.requireFallback);
      if (clean) return clean;
    } catch (e) { /* 补救失败就走兜底 */ }

    return this.sanitize((p.requireFallback ? reply + '\n' + p.requireFallback : reply));
  }

  /** 联网搜索的"多用"提示：需要事实/时效信息时先查再答 */
  _searchNudge() {
    const on = !this.cfg.search || this.cfg.search.enabled !== false;
    return on ? '\n\n【联网】遇到需要事实核查、最新消息、具体数据、你不确定的事，先用搜索工具查一下再回答；闲聊不用查。' : '';
  }

  /** 当前人格的格式锚点（抵消长对话里的指令衰减） */
  _personaAnchor(gid) {
    const id = this._currentPersonaId(gid);
    const all = [this.personaSet && this.personaSet.default, ...((this.personaSet && this.personaSet.easter) || [])].filter(Boolean);
    const p = all.find(x => x.id === id);
    return (p && p.anchor) || '';
  }

  /** 当前人格应答的名字：彩蛋中必须用它自己的名字，默认人格用默认名字 */
  _activeNames(gid) {
    const id = this._currentPersonaId(gid);
    const all = [this.personaSet && this.personaSet.default, ...((this.personaSet && this.personaSet.easter) || [])].filter(Boolean);
    const p = all.find(x => x.id === id);
    const names = p ? [p.name, p.nick, ...(p.aliases || [])].filter(Boolean) : [];
    return names.length ? names : this.botNames;
  }

  /** 当前人格的"回话率"：人格文件里写了就用它，否则用全局阈值 */
  _intentThreshold(gid) {
    const id = this._currentPersonaId(gid);
    const all = [this.personaSet && this.personaSet.default, ...((this.personaSet && this.personaSet.easter) || [])].filter(Boolean);
    const p = all.find(x => x.id === id);
    return (p && p.replyRate) || this.intent.threshold || 3;
  }

  /** 当前人格 id：彩蛋中 → 彩蛋人格；否则 → 配置里的默认人格 */
  _currentPersonaId(gid) {
    return this.personaState(gid).activeId
      || (this.personaSet && this.personaSet.default && this.personaSet.default.id)
      || (this.cfg.bot && this.cfg.bot.defaultPersonaId) || 'whalegirl';
  }

  /** 公告发给谁：白名单群 + 最近有消息的群 */
  _announceGroups() {
    const ids = new Set();
    for (const g of (this.cfg.groups || [])) if (g.enable !== false) ids.add(String(g.id));
    for (const gid of this.state.history.keys()) ids.add(String(gid));
    return [...ids].filter(id => this.groupCfg(id));
  }

  _lineFor(kind) {
    const sch = this._schedule();
    const lines = sch.lines || {};
    const fromFile = (this._personaLines || {})[this._currentPersonaId()] || {};
    const set = fromFile[kind] ? fromFile : (lines[this._currentPersonaId()] || lines.whalegirl || {});
    return kind === 'sleep' ? set.sleep : set.wake;
  }

  async _announce(kind) {
    const text = this._lineFor(kind);
    if (!text) return;
    const groups = this._announceGroups();
    const mode = this.cfg.mode || 'dry';
    const tag = kind === 'sleep' ? '晚安' : '早安';
    if (!groups.length) return this.log('[schedule] ' + tag + '：没有可发公告的群');

    for (const gid of groups) {
      await this._emit(gid, text, { kind: 'announce', sender: '(作息公告)' });
    }
    this.log('[schedule] ' + tag + '公告已发：' + groups.length + ' 个群，人格=' + this._currentPersonaId());
  }

  /** 每 20 秒跑一次：到点发公告（同一个点当天只发一次） */
  async _tick() {
    const sch = this._schedule();
    if (sch.enabled === false) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const cur = now.getHours() * 60 + now.getMinutes();
    const sleepAt = this._toMin(sch.sleepAt || '00:00');
    const wakeAt = this._toMin(sch.wakeAt || '07:30');

    if (cur === sleepAt && !this._announced.get(day + ':sleep')) {
      this._announced.set(day + ':sleep', true);
      await this._announce('sleep');
    }
    if (cur === wakeAt && !this._announced.get(day + ':wake')) {
      this._announced.set(day + ':wake', true);
      await this._announce('wake');
    }
    // 顺手清理旧记录，避免 Map 无限增长
    if (this._announced.size > 40) {
      for (const k of [...this._announced.keys()]) if (!k.startsWith(day)) this._announced.delete(k);
    }
  }

  /**
   * 低频记忆抽取：每 N 条消息调一次模型，从对话里提炼群内特有的信息。
   * 默认关闭（memory.autoExtract），开了才有额外开销：每 N 条一次调用。
   */
  async _maybeExtract(msg) {
    const mc = this.cfg.memory || {};
    if (!this.mem || mc.autoExtract !== true) return;
    const every = Math.max(3, Number(mc.everyMessages) || 40);
    const n = (this._memTick.get(msg.groupId) || 0) + 1;
    this._memTick.set(msg.groupId, n);
    if (n % every !== 0) return;

    // 全局只允许一个提取在跑：多个群同时到点时，别跟主聊天抢算力、也别撞 429。
    // 这次跳过不影响：计数已经进位，下个周期自然会再触发。
    if (this._extracting) { this.log('[memory] 已有提取在跑，本次跳过'); return; }
    this._extracting = true;

    const hist = (this.state.history.get(msg.groupId) || [])
      .slice(-20).map(h => h.content).join('\n').slice(0, 1500);
    if (!hist) { this._extracting = false; return; }
    try {
      const out = await this.brain.reply({
        persona: '你是群聊记忆提取器。只提取"有信息量、以后用得上"的群内信息：'
          + '外号/称呼、黑话、固定安排、人物身份、内部梗。'
          + '不要提取：谁只是说了句话、X=群成员 这类废话、一次性的情绪。'
          + '同一件事只输出一条；每条不超过 20 字；最多 5 条。'
          + '只输出 JSON 字符串数组，例如 ["老王=群主","退群叫毕业","周四晚固定开黑"]；没有就输出 []。',
        history: [], text: hist, images: []
      });
      const m = out.match(/\[[\s\S]*?\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const added = this.mem.addFacts(msg.groupId, arr.filter(x => typeof x === 'string'), 'auto');
      if (added) this.log('[memory] 群 ' + msg.groupId + ' 新增 ' + added + ' 条');
    } catch (e) {
      this.log('[memory] 抽取失败：' + e.message);
    } finally {
      this._extracting = false;
    }
  }

  /** 发送一条待批队列里的回复（manual 模式的消费端） */
  async sendQueued(rec) {
    if (!rec || !rec.reply) throw new Error('队列记录不完整');
    // 人工批准的内容：已经过净化，这里 force 直接发，但仍过政治红线
    const r = await this._emit(rec.groupId, rec.reply, {
      kind: 'reply', force: true, guardScope: false, sender: rec.sender || '(待批)'
    });
    if (!r) throw new Error('发送被拦截（红线/上限），请检查日志');
    return r;
  }

  /* ================= 话题嗅觉：什么时候该开口 ================= */

  _awCfg() { return this.cfg.awareness || {}; }

  /** 参与评估的群：白名单 + 最近有人说过话的群 */
  _awarenessGroups() {
    const ids = new Set();
    for (const g of (this.cfg.groups || [])) if (g.enable !== false) ids.add(String(g.id));
    for (const gid of this.aw.groups()) ids.add(String(gid));
    return [...ids];
  }

  /** 每分钟评估一次：先看冷场要不要开话题，再看有没有机会插话 */
  async _awarenessTick() {
    if (!this.aw) return;
    const cfg = this._awCfg();
    if (cfg.enabled === false) return;
    if (this.isSleeping()) return;                 // 静默时段不开口
    if (this.state.sent >= this.rules.dailyCap) return;

    const now = Date.now();
    this._awTickAt = now;

    for (const gid of this._awarenessGroups()) {
      const g = this.groupCfg(gid);
      if (!g || g.enable === false) continue;
      // 尊重群级开关：这个群没开 proactive 就绝不主动开口（含冷场引出和插话）
      if (g.proactive !== true) continue;
      if (this._inflight.has(gid)) continue;        // 正在回别人的话，别抢

      const snap = this.aw.snapshot(gid, now);
      if (!snap.recentCount) continue;

      // ① 冷场：安静够久 + 群里本来有人气 + 机器人也沉默够久
      const rv = cfg.revive || {};
      if (rv.enabled !== false) {
        const silence = (rv.silenceMinutes ?? 25) * 60000;
        const cool = (rv.cooldownMinutes ?? 120) * 60000;
        if (snap.silenceMs >= silence
          && snap.recentCount >= (rv.minRecentMessages ?? 8)
          && now - snap.lastBotAt >= cool
          && this.aw.count(gid, 'revive', now) < (rv.maxPerDay ?? 2)) {
          if (await this._startTopic(gid, g, snap)) { this.aw.bump(gid, 'revive', now); continue; }
        }
      }

      // ② 插话：真有人在聊 + 机器人自己安静了一阵 + 有接话的点
      const jn = cfg.join || {};
      if (jn.enabled !== false) {
        const needTalk = jn.requireConversation !== false;
        const talking = !needTalk || (snap.activeSenders >= 2 && snap.activeCount >= 3);
        const cool = (jn.cooldownMinutes ?? 15) * 60000;
        if (talking
          && snap.sinceBotMs >= (jn.minSilenceSinceBot ?? 10) * 60000
          && now - snap.joinAt >= cool
          && this.aw.countHour(gid, 'join', now) < (jn.maxPerHour ?? 3)
          && this.aw.count(gid, 'join', now) < (jn.maxPerDay ?? 10)
          && Math.random() < (jn.probability ?? 0.25)) {
          if (await this._joinTalk(gid, g, snap)) this.aw.bump(gid, 'join', now);
        }
      }
    }
  }

  /** 主动发言的统一出口（走 dry/manual/auto，且过一遍净化） */
  async _sendTo(gid, text) {
    // 无论成功、入队、dry 还是被拦，都算"尝试过开口"，
    // 否则 sinceBotMs 永远是 Infinity，每分钟重试会把额度烧光。
    if (this.aw) this.aw.noteBot(gid);
    const r = await this._emit(gid, text, { kind: 'proactive', sender: '(主动·话题)' });
    return !!r;
  }

  /** ① 冷场时开个话题 */
  async _startTopic(gid, g, snap) {
    const hist = snap.lastTexts.slice(-4);
    const prompt = '\n\n【任务 · 起个话题】这个群已经安静了一会儿。'
      + '你想主动开个话题，让大家愿意接。'
      + '要求：用你的人格口吻，1~2 句，不要提"冷场""没人说话""在吗"这类话，'
      + '不要@任何人。可以聊吃的、天气、游戏、最近发生的事，或者抛一个轻松的小问题。';
    try {
      const txt = await this.brain.reply({
        persona: this.activePersona(gid) + (this.mem ? this.mem.prompt(gid, hist.join(' ')) : '') + prompt + this._scopeRule() + this._styleRule(),
        history: hist.map(t => ({ role: 'user', content: t })),
        text: '（群里没人说话，你想开个话题）',
        images: []
      });
      return await this._sendTo(gid, txt);
    } catch (e) {
      this.log('[awareness] 起话题失败：' + e.message);
      return false;
    }
  }

  /** ② 别人正聊着时插一句 */
  async _joinTalk(gid, g, snap) {
    const hist = snap.lastTexts;
    const prompt = '\n\n【任务 · 插话】群里正在聊天（下面是最近几句）。'
      + '你像普通群友那样插一句：附和、吐槽、追问、补充都行。'
      + '要求：1 句，别总结别人的话，别长篇，不要@任何人。'
      + (snap.hasQuestion ? '刚有人问了问题，可以顺着接。' : '');
    try {
      const txt = await this.brain.reply({
        persona: this.activePersona(gid) + (this.mem ? this.mem.prompt(gid, hist.join(' ')) : '') + prompt + this._scopeRule() + this._styleRule(),
        history: hist.map(t => ({ role: 'user', content: t })),
        text: '（他们在聊，你可以插一句）',
        images: []
      });
      return await this._sendTo(gid, txt);
    } catch (e) {
      this.log('[awareness] 插话失败：' + e.message);
      return false;
    }
  }

  /* ================= 唯一出口：所有对外发言都必须走这里 ================= */

  /**
   * 全项目唯一允许调用 client.sendGroup / sendGroupAt 的地方。
   *
   * 无论谁想发消息——正常回复、彩蛋台词、作息公告、主动找话题、待批队列、对外工具——
   * 都必须经过 _emit()。它无条件做四件事：
   *   1) 净化（长度/敏感词/前缀）
   *   2) 红线检查（政治 / 能力边界）
   *   3) 额度检查（日上限，回复类还要查小时上限）
   *   4) 统一记账（_countSent + aw.noteBot）
   *
   * 这样新加的功能即使忘了写节流，也不会绕过这些保证。
   *
   * @param {string|number} gid
   * @param {string} text
   * @param {object} opts { kind, atUid, force, guardScope, sender, src }
   * @returns {Promise<object|null>} null = 没有真正发出（被丢弃/被拦）
   */
  async _emit(gid, text, opts = {}) {
    const kind = opts.kind || 'reply';
    const out = await this.plugins.transform({ gid, text, kind, meta: opts });
    if (!out || !out.text) return null;
    const clean = this.sanitize(out.text);
    if (!clean) { this.log('[emit:' + kind + '] 净化后为空，丢弃'); return null; }

    // 红线：所有出口一视同仁
    if (this._politicsHit && this._politicsHit(clean)) { this.log('[emit:' + kind + '] 政治红线，丢弃'); return null; }
    if (opts.guardScope !== false && this._scopeHit(clean)) { this.log('[emit:' + kind + '] 能力边界，丢弃'); return null; }

    // 额度：日上限对所有出口生效；小时上限只管"有人说话才发"的类型
    const st = this.state;
    if (kind !== 'announce' && st.sent >= this.rules.dailyCap) {
      this.log('[emit:' + kind + '] 日上限，丢弃');
      return null;
    }
    if ((kind === 'reply' || kind === 'proactive')
      && (st.perHour[hourKey()] || 0) >= this.rules.maxPerHour) {
      this.log('[emit:' + kind + '] 小时上限，丢弃');
      return null;
    }

    // 投递
    const mode = opts.force ? 'auto' : (this.cfg.mode || 'dry');
    if (mode === 'dry') { this.log('[DRY:' + kind + '] ' + clean); return { dry: true }; }
    if (mode === 'manual') {
      const id = now().toString(36);
      if (this.queueFile) {
        fs.appendFileSync(this.queueFile, JSON.stringify({
          id, ts: now(), groupId: gid, sender: opts.sender || '(主动)',
          text: opts.src || '', reply: clean, kind, status: 'pending'
        }) + '\n');
      }
      this.log('[QUEUE ' + id + ':' + kind + '] → ' + clean);
      return { queued: true, id };
    }

    let r;
    try {
      r = opts.atUid
        ? await this.client.sendGroupAt(gid, opts.atUid, clean)
        : await this.client.sendGroup(gid, clean);
    } catch (e) {
      this.log('[ERR:' + kind + '] 发送失败：' + e.message);
      return null;
    }

    // 统一记账
    this._countSent(gid);
    if (kind === 'proactive') {
      this.state.perHour['pro_' + hourKey()] = (this.state.perHour['pro_' + hourKey()] || 0) + 1;
    }
    if (this.aw) this.aw.noteBot(gid);
    this.log('[SENT:' + kind + '] → ' + clean);
    return r || {};
  }

  /* ================= 对外能力（插件用） ================= */
  say(groupId, text) {
    // 对外工具调用：显式指令，直接发；但仍要过净化 + 政治红线
    return this._emit(groupId, text, { kind: 'api', force: true, guardScope: false, sender: '(外部调用)' });
  }
  listGroups() { return this.client.getGroupList(); }

  status() {
    return {
      connected: this.client.connected,
      selfId: this.client.selfId,
      sentToday: this.state.sent,
      hourly: this.state.perHour[hourKey()] || 0,
      mode: this.cfg.mode,
      persona: this.personaState(),
      memory: this.mem ? this.mem.stats() : null,
      usage: this.brain.stats()
    };
  }
}
