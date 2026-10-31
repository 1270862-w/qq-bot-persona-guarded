#!/usr/bin/env node
/**
 * templog.js —— 临时日志：每个群最近若干条消息的滚动窗口。
 *
 * 和 state.history 的区别：
 *   history  给模型看的对话上下文（成对、有 role）
 *   templog  给"要不要开口"的判断用的原始现场（谁说了什么、有没有图、多久前）
 *
 * 只存内存，重启即清空；按条数和时间双重裁剪，不会无限增长。
 */
'use strict';

export class TempLog {
  constructor(opts = {}) {
    this.size = opts.size || 30;
    this.maxAgeMs = (opts.maxAgeMinutes || 60) * 60000;
    this.map = new Map();
  }

  _list(gid) {
    const k = String(gid);
    if (!this.map.has(k)) this.map.set(k, []);
    return this.map.get(k);
  }

  add(gid, entry) {
    const list = this._list(gid);
    list.push({
      sender: String(entry.sender || ''),
      text: String(entry.text || ''),
      hasImage: !!entry.hasImage,
      isSelf: !!entry.isSelf,
      ts: entry.ts || Date.now()
    });
    const cut = Date.now() - this.maxAgeMs;
    while (list.length && (list.length > this.size || list[0].ts < cut)) list.shift();
    return this;
  }

  recent(gid, n = 10) {
    return this._list(gid).slice(-n);
  }

  /** 拼成给模型/判断用的文本："甲: 你好\n乙: 在吗" */
  segment(gid, n = 10) {
    return this.recent(gid, n)
      .map(e => (e.isSelf ? '我' : e.sender) + ': ' + (e.text || (e.hasImage ? '[图片]' : '')))
      .join('\n');
  }

  /** 最近一条非机器人消息距今多少毫秒 */
  sinceHuman(gid) {
    const list = this._list(gid);
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].isSelf) return Date.now() - list[i].ts;
    return Infinity;
  }

  groups() { return [...this.map.keys()]; }
  clear(gid) { this.map.delete(String(gid)); }
}
