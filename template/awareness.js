#!/usr/bin/env node
/**
 * awareness.js —— 话题嗅觉：判断"现在该不该开口"。
 *
 * 只做一件事：按群记录最近谁说了什么、多久没人说话、机器人上次发言是什么时候。
 * 具体策略（什么时候引出话题、什么时候插话）放在 engine 里，方便调参。
 *
 * 不调用模型、不写盘，纯内存，开销可以忽略。
 */
'use strict';

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const hourKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 13);

export class GroupAwareness {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 60 * 60 * 1000;   // 历史保留窗口（判断群里有没有人气）
    this.activeMs = opts.activeMs || 5 * 60 * 1000;    // 活跃窗口（判断现在是不是真在聊）
    this.maxEntries = opts.maxEntries || 60;
    this.state = new Map();
  }

  _s(gid) {
    gid = String(gid);                 // 群号一律转字符串，避免数字/字符串两套 key
    let s = this.state.get(gid);
    if (!s) {
      s = { msgs: [], lastHumanAt: 0, lastBotAt: Date.now(), joinAt: 0, reviveAt: 0, reviveDay: {}, joinHour: {}, joinDay: {} };
      this.state.set(gid, s);
    }
    return s;
  }

  noteHuman(gid, sender, text, ts = Date.now()) {
    const s = this._s(gid);
    s.msgs.push({ ts, sender: String(sender || ''), text: String(text || '').slice(0, 120) });
    if (s.msgs.length > this.maxEntries) s.msgs.shift();
    s.lastHumanAt = ts;
  }

  noteBot(gid, ts = Date.now()) {
    const s = this._s(gid);
    s.lastBotAt = ts;
  }

  prune(gid, now = Date.now()) {
    const s = this._s(gid);
    const cut = now - this.windowMs;
    while (s.msgs.length && s.msgs[0].ts < cut) s.msgs.shift();
    return s;
  }

  /** 给策略用的快照 */
  snapshot(gid, now = Date.now()) {
    const s = this.prune(gid, now);
    const senders = new Set(s.msgs.map(m => m.sender));
    const active = s.msgs.filter(m => now - m.ts <= this.activeMs);
    const activeSenders = new Set(active.map(m => m.sender));
    return {
      recentCount: s.msgs.length,
      distinctSenders: senders.size,
      activeCount: active.length,
      activeSenders: activeSenders.size,
      silenceMs: s.lastHumanAt ? now - s.lastHumanAt : Infinity,
      sinceBotMs: s.lastBotAt ? now - s.lastBotAt : Infinity,
      hasQuestion: s.msgs.slice(-4).some(m => /[?？]|吗|呢|怎么|为什么|谁|咋/.test(m.text)),
      lastTexts: s.msgs.slice(-6).map(m => m.sender + ': ' + m.text),
      lastHumanAt: s.lastHumanAt,
      lastBotAt: s.lastBotAt,
      joinAt: s.joinAt,
      reviveAt: s.reviveAt
    };
  }

  /** 计数：今天/这小时已经主动说了几次 */
  count(gid, kind, now = Date.now()) {
    const s = this._s(gid);
    if (kind === 'revive') return s.reviveDay[dayKey(now)] || 0;
    return s.joinDay[dayKey(now)] || 0;
  }

  countHour(gid, kind, now = Date.now()) {
    const s = this._s(gid);
    if (kind !== 'join') return 0;
    return s.joinHour[hourKey(now)] || 0;
  }

  bump(gid, kind, now = Date.now()) {
    const s = this._s(gid);
    if (kind === 'revive') {
      s.reviveAt = now;
      s.reviveDay[dayKey(now)] = (s.reviveDay[dayKey(now)] || 0) + 1;
    } else {
      s.joinAt = now;
      s.joinHour[hourKey(now)] = (s.joinHour[hourKey(now)] || 0) + 1;
      s.joinDay[dayKey(now)] = (s.joinDay[dayKey(now)] || 0) + 1;
    }
    // 清理旧日期键，避免无限增长
    for (const k of Object.keys(s.reviveDay)) if (k !== dayKey(now)) delete s.reviveDay[k];
    for (const k of Object.keys(s.joinDay)) if (k !== dayKey(now)) delete s.joinDay[k];
    for (const k of Object.keys(s.joinHour)) if (k !== hourKey(now)) delete s.joinHour[k];
  }

  groups() { return [...this.state.keys()]; }
}
