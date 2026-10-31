#!/usr/bin/env node
/**
 * onebot.js —— OneBot v11 客户端（零依赖，Node >= 22 内置 WebSocket）
 *
 * 电脑上跑 QQ 机器人的标准姿势：
 *   NapCatQQ / Lagrange.Core / LLOneBot  →  提供 OneBot v11（HTTP API + 正向 WS）
 *   本文件连上去收发消息，不需要点屏幕、不需要无障碍。
 *
 * 典型配置：
 *   WS   ws://127.0.0.1:3001       （事件推送）
 *   HTTP http://127.0.0.1:3000     （调用 API）
 *   access_token 自己设
 */
'use strict';
import { EventEmitter } from 'node:events';

/* ---------- 消息段处理 ---------- */
/** 把 OneBot 的 message（string 或 segment 数组）拍平成文本 + 图片列表 */
function flatten(message, selfId) {
  // 字符串形式：酷Q系（CQHTTP / go-cqhttp）默认发 CQ 码串，
  // 里面既有 @ 也有图片，都要解析出来，否则 @ 判断和识图都会失效。
  if (typeof message === 'string') {
    const ats = [];
    const images = [];
    let atMe = false;
    let text = '';

    const unescape = (x) => String(x || '')
      .replace(/&#91;/g, '[').replace(/&#93;/g, ']')
      .replace(/&#44;/g, ',').replace(/&amp;/g, '&');

    const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
    let last = 0, m;
    while ((m = re.exec(message)) !== null) {
      text += unescape(message.slice(last, m.index));
      last = re.lastIndex;
      const type = m[1];
      const params = {};
      for (const kv of (m[2] || '').split(',')) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        if (i > 0) params[kv.slice(0, i)] = unescape(kv.slice(i + 1));
      }
      switch (type) {
        case 'at': {
          const qq = String(params.qq || '');
          if (qq === 'all') text += '@全体成员';
          else {
            if (selfId && qq === String(selfId)) atMe = true;
            ats.push({ qq, name: params.name || qq });
            text += '@' + (params.name || qq);
          }
          break;
        }
        case 'image':
          images.push({ url: params.url || '', file: params.file || '' });
          text += '[图片]';
          break;
        case 'face': text += '[表情]'; break;
        case 'mface': text += '[表情包]'; break;
        case 'record': text += '[语音]'; break;
        case 'video': text += '[视频]'; break;
        case 'reply': break;
        default: break;
      }
    }
    text += unescape(message.slice(last));
    const atOthers = ats.some(a => !selfId || a.qq !== String(selfId));
    return { text: text.trim(), images, atMe, ats, atOthers, segments: [] };
  }

  const segs = Array.isArray(message) ? message : [];
  let text = '';
  const images = [];
  let atMe = false;
  const ats = [];          // 被 @ 的人（qq + 昵称），用来判断"这句话是跟谁说的"
  for (const s of segs) {
    const d = s.data || {};
    switch (s.type) {
      case 'text':
        text += d.text || '';
        break;
      case 'at':
        if (String(d.qq) === 'all') text += '@全体成员';
        else {
          if (selfId && String(d.qq) === String(selfId)) atMe = true;
          ats.push({ qq: String(d.qq), name: String(d.name || d.qq) });
          text += '@' + (d.name || d.qq);
        }
        break;
      case 'image':
        images.push({ url: d.url || d.file || '', file: d.file || '' });
        text += '[图片]';
        break;
      case 'face':
        text += '[表情]';
        break;
      case 'mface':
        text += '[表情包]';      // 商城表情，通常没有 url，识图拿不到
        break;
      case 'record':
        text += '[语音]';
        break;
      case 'video':
        text += '[视频]';
        break;
      case 'reply':
        break;
      default:
        break;
    }
  }
  // 保留原始段类型：自检和排错时能看出"这张图到底带不带 url"
  const atOthers = ats.some(a => !selfId || a.qq !== String(selfId));
  return { text: text.trim(), images, atMe, ats, atOthers, segments: segs.map(s => s.type) };
}

/* ---------- 客户端 ---------- */
class OneBotClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.wsUrl = opts.wsUrl || '';
    this.httpUrl = (opts.httpUrl || '').replace(/\/$/, '');
    this.accessToken = opts.accessToken || '';
    this.reconnectMs = opts.reconnectMs || 3000;
    this.apiTimeout = opts.apiTimeout || 15000;
    this.log = opts.log || ((...a) => console.log(...a));

    this.selfId = opts.selfId ? String(opts.selfId) : null;   // 配置里写了就先用
    this.connected = false;
    this._ws = null;
    this._closed = false;
    this._seq = 0;
    this._pending = new Map();   // echo → {resolve, reject, timer}
    this.heartbeatMs = opts.heartbeatMs || 30000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs || 8000;
    this._hb = null;
    this._hbFails = 0;
    this._lastFrame = 0;
  }

  /** 主动获取自己的 QQ 号：有的协议端不发 lifecycle，@ 判断就会失效 */
  async _fetchSelfId() {
    if (this.selfId) return;
    try {
      const r = await this.callApi('get_login_info');
      const id = r && (r.user_id || (r.data && r.data.user_id));
      if (id) {
        this.selfId = String(id);
        this.log('[onebot] 已登录 QQ:', this.selfId);
        this.emit('ready', { selfId: this.selfId });
      }
    } catch (e) { /* 拿不到就算了，靠昵称匹配 */ }
  }

  /* --------- 连接 --------- */
  connect() {
    if (!this.wsUrl) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };

      const url = this.accessToken
        ? this.wsUrl + (this.wsUrl.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.accessToken)
        : this.wsUrl;

      let ws;
      try { ws = new WebSocket(url); }
      catch (e) { this.log('[onebot] WS 创建失败:', e.message); finish(false); return; }

      this._ws = ws;

      ws.addEventListener('open', () => {
        this.connected = true;
        this.log('[onebot] WS 已连接', this.wsUrl);
        this._startHeartbeat();
        this._fetchSelfId();     // 没等到 lifecycle 就主动问一次
        finish(true);
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev.data));

      ws.addEventListener('error', (ev) => {
        this.log('[onebot] WS 错误', (ev && ev.message) || '');
        finish(false);
      });

      ws.addEventListener('close', () => {
        this.connected = false;
        if (this._hb) { clearInterval(this._hb); this._hb = null; }
        this.log('[onebot] WS 断开');
        finish(false);
        if (!this._closed) {
          setTimeout(() => this.connect().catch(() => {}), this.reconnectMs);
        }
      });
    });
  }

  /**
   * 心跳：每 30 秒发一次 get_status，8 秒内没回就算一次失败；
   * 连续 2 次失败判定为半开连接，主动断开触发重连。
   * （TCP 假死时 close 事件永远不会来，只有这个能救）
   */
  _startHeartbeat() {
    if (this._hb) clearInterval(this._hb);
    this._hbFails = 0;
    this._hb = setInterval(() => {
      if (!this.connected || !this._ws) return;
      const echo = 'hb-' + (++this._seq);
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        this._hbFails++;
        this.log('[onebot] 心跳超时 ' + this._hbFails + ' 次');
        if (this._hbFails >= 2) {
          this.log('[onebot] 判定半开连接，主动重连');
          try { this._ws.close(); } catch (e) {}
        }
      }, this.heartbeatTimeoutMs);
      this._pending.set(echo, {
        resolve: () => { this._hbFails = 0; clearTimeout(timer); },
        reject: () => {},
        timer
      });
      try { this._ws.send(JSON.stringify({ action: 'get_status', params: {}, echo })); } catch (e) {}
    }, this.heartbeatMs);
  }

  _onMessage(raw) {
    this._lastFrame = Date.now();
    let j;
    try { j = JSON.parse(typeof raw === 'string' ? raw : String(raw)); }
    catch (e) { return; }
    if (!j || typeof j !== 'object') return;   // null / 数字 / 字符串事件直接忽略

    // API 响应（WS 调用模式）
    if (j.echo && this._pending.has(j.echo)) {
      const p = this._pending.get(j.echo);
      this._pending.delete(j.echo);
      clearTimeout(p.timer);
      if (j.retcode === 0 || j.status === 'ok') p.resolve(j.data);
      else p.reject(new Error(j.wording || j.message || ('retcode=' + j.retcode)));
      return;
    }

    if (!j.post_type) return;

    // 拿登录号
    if (j.post_type === 'meta_event' && j.meta_event_type === 'lifecycle') {
      this.selfId = j.self_id;
      this.log('[onebot] 已登录 QQ:', this.selfId);
      this.emit('ready', { selfId: this.selfId });
      return;
    }

    this.emit('event', j);

    if (j.post_type === 'message' && j.message_type === 'group') {
      const f = flatten(j.message, j.self_id || this.selfId);
      this.emit('group.message', {
        groupId: j.group_id,
        userId: j.user_id,
        sender: (j.sender && (j.sender.card || j.sender.nickname)) || String(j.user_id),
        nickname: (j.sender && j.sender.nickname) || '',
        card: (j.sender && j.sender.card) || '',
        time: j.time,
        messageId: j.message_id,
        raw: j.raw_message || '',
        text: f.text,
        images: f.images,
        atMe: f.atMe,
        ats: f.ats || [],
        atOthers: !!f.atOthers,
        segments: f.segments || [],
        isSelf: String(j.user_id) === String(j.self_id || this.selfId)
      });
    }
  }

  /* --------- API 调用 --------- */
  async callApi(action, params = {}) {
    if (this.httpUrl) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.apiTimeout);
      try {
        const r = await fetch(this.httpUrl + '/' + action, {
          method: 'POST',
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            this.accessToken ? { Authorization: 'Bearer ' + this.accessToken } : {}
          ),
          body: JSON.stringify(params),
          signal: ctrl.signal
        });
        const j = await r.json();
        if (j.retcode !== 0 && j.status !== 'ok') {
          throw new Error(j.wording || j.message || ('retcode=' + j.retcode));
        }
        return j.data;
      } finally { clearTimeout(timer); }
    }

    // WS 调用兜底
    if (!this._ws || !this.connected) throw new Error('WS 未连接，无法调用 ' + action);
    const echo = 'dsh-' + (++this._seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error('API 超时: ' + action));
      }, this.apiTimeout);
      this._pending.set(echo, { resolve, reject, timer });
      this._ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendGroup(groupId, text) {
    return this.callApi('send_group_msg', {
      group_id: groupId,
      message: [{ type: 'text', data: { text } }]
    });
  }

  /** 带 @ 的回复 */
  sendGroupAt(groupId, userId, text) {
    return this.callApi('send_group_msg', {
      group_id: groupId,
      message: [
        { type: 'at', data: { qq: String(userId) } },
        { type: 'text', data: { text: ' ' + text } }
      ]
    });
  }

  getGroupList() { return this.callApi('get_group_list'); }

  close() {
    this._closed = true;
    try { this._ws && this._ws.close(); } catch (e) {}
  }
}

export { OneBotClient, flatten };
