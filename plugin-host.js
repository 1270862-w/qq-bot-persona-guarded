#!/usr/bin/env node
/**
 * plugin-host.js —— 插件宿主：把"发言插口"和"消息钩子"开放给外部模块。
 *
 *   plugins/<名字>/index.js
 *     export default {
 *       name: 'demo',
 *       setup(ctx) {
 *         ctx.emit.use((out) => ({ ...out, text: out.text + '~' }));  // 发送前改文本
 *         ctx.emit.after((out, r) => {});                             // 发送后观察
 *         ctx.on('message', (msg) => {});                             // 收到消息
 *       }
 *     }
 *
 * 三条硬规则：
 *   1. 插件只能改文本，拿不到 client，发不出消息
 *   2. 插件改完的文本还要过一遍净化 / 政治 / 边界
 *   3. 插件抛异常只丢这个钩子，不影响主流程
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { intentScore } from './rules.js';

export class PluginHost {
  constructor({ dir, cfg = {}, brain = null, personaOf = null, log = () => {} } = {}) {
    this.personaOf = personaOf;
    this.brain = brain;
    this.dir = dir;
    this.cfg = cfg;
    this.log = log;
    this.mods = [];
    this._use = [];
    this._after = [];
    this._msg = [];
    this._prompt = [];
  }

  _ctx(name) {
    return {
      name,
      log: (...a) => this.log('[plugin:' + name + ']', ...a),
      // 唯一的联网入口：插件只能拿到结果，发不了消息
      search: async (q) => {
        if (!this.brain || !this.brain.search) return null;
        try { return await this.brain.search(String(q), String(q)); }
        catch (e) { this.log('[plugin] 搜索失败：' + e.message); return null; }
      },
      // 和聊天触发同一套语义打分：插件不用自己猜"这句话值不值得学"
      score: (text) => intentScore(this.cfg, String(text || ''), {}),
      // 让模型做小事（提实体/关键词），不联网、不发消息
      ask: async (q) => {
        if (!this.brain || !this.brain.reply) return '';
        try {
          const r = await this.brain.reply({
            persona: '你只输出结果，不解释。', history: [], text: String(q || ''), images: []
          });
          return String(r || '').trim();
        } catch (e) { return ''; }
      },
      persona: (gid) => (this.personaOf ? this.personaOf(gid) : null),
      config: this.cfg[name] || {},
      emit: {
        use: (fn) => this._use.push(this._safe(fn, name, 'emit.use')),
        after: (fn) => this._after.push(this._safe(fn, name, 'emit.after'))
      },
      on: (evt, fn) => { if (evt === 'message') this._msg.push(this._safe(fn, name, 'on')); },
      // 人格补全：插件可以往 prompt 里追加"这个群该怎么说"
      prompt: { use: (fn) => this._prompt.push(this._safe(fn, name, 'prompt.use')) }
    };
  }

  _safe(fn, name, tag) {
    return (...a) => {
      try { return fn(...a); } catch (e) { this.log('[plugin:' + name + '] ' + tag + ' 出错：' + e.message); return undefined; }
    };
  }

  async load() {
    this._use = []; this._after = []; this._msg = []; this._prompt = [];   // 重载前清空钩子
    const list = this.cfg.enabled || [];
    if (!list.length) return;
    for (const name of list) {
      const file = path.join(this.dir, name, 'index.js');
      if (!fs.existsSync(file)) { this.log('[plugin] 找不到 ' + name + '，跳过'); continue; }
      try {
        const mod = await import(pathToFileURL(file).href);
        const m = mod.default || mod;
        if (!m || typeof m.setup !== 'function') { this.log('[plugin] ' + name + ' 没有 setup，跳过'); continue; }
        await m.setup(this._ctx(name));
        this.mods.push(name);
        this.log('[plugin] 已加载 ' + name);
      } catch (e) {
        this.log('[plugin] ' + name + ' 加载失败：' + e.message);
      }
    }
  }

  /** 热加载：plugins 目录有改动就重新扫描（AI 投递插件后无需重启） */
  watch() {
    if (this._watching) return;
    const parent = path.dirname(this.dir);
    if (!fs.existsSync(parent)) return;
    this._watching = true;
    try {
      let t = null;
      fs.watch(parent, { recursive: true }, (evt, name) => {
        if (name && !String(name).includes('plugins')) return;
        clearTimeout(t);
        t = setTimeout(() => {
          this.log('[plugin] 检测到目录变化，重新加载');
          this.load().catch(e => this.log('[plugin] 重载失败：' + e.message));
        }, 1200);
        if (t.unref) t.unref();
      });
      this.log('[plugin] 已监听 plugins 目录');
    } catch (e) { this.log('[plugin] 监听失败：' + e.message); }
  }

  /** 发送前：插件改文本（不允许改 gid/kind） */
  async transform(out) {
    let cur = { ...out };
    for (const fn of this._use) {
      const r = await fn({ ...cur });
      if (r === null) return null;                 // 插件主动丢弃
      if (r && typeof r.text === 'string') cur.text = r.text;
    }
    return cur;
  }

  /** 人格补全：返回追加到 prompt 的文本 */
  promptAdd(msg) {
    let add = '';
    for (const fn of this._prompt) {
      const r = fn({ gid: msg.groupId, text: msg.text, persona: '' });
      if (typeof r === 'string' && r) add += '\n' + r;
    }
    return add;
  }

  after(out, result) { for (const fn of this._after) fn(out, result); }
  message(msg) { for (const fn of this._msg) fn(msg); }
}
