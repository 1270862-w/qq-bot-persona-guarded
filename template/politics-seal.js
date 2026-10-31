#!/usr/bin/env node
/**
 * politics-seal.js —— 政治限制的封印。
 *
 * 公开版启用：启动时核对关键词表与出厂值是否一致。
 * 不一致 = 有人动过政治限制 → 拒绝启动，而不是悄悄放行。
 *
 * 说明：明文代码没法做到"绝对改不了"，但可以让"改掉"这件事
 * 变成明确的启动失败，而不是无声无息地失效。
 */
'use strict';

/** 出厂关键词（与发布时 config.json 一致） */
export const BUILTIN_WORDS = ["政治", "主席", "总统", "选举", "文革", "台湾独立", "领导人", "政府", "战争", "上台", "politics", "zhengzhi"];

/** 出厂关键词的指纹 */
export const POLITICS_SEAL = 'bf0e01f0a19e853fe7d040285ab5ff6ef296f3d64f5381204974591de8e4c0ba';

function hash(words) {
  // 与生成时一致：排序后用 | 连接
  const text = [...words].sort().join('|');
  // 简易 sha256（Node 内置 crypto 在浏览器不可用，这里只在 Node 跑）
  return text;
}

/**
 * 校验当前关键词表。
 * 返回 { ok, reason }；ok=false 时调用方必须拒绝启动。
 */
export function verifySeal(words) {
  const list = Array.isArray(words) ? words : [];
  if (!list.length) return { ok: false, reason: '政治关键词表为空' };
  const sorted = [...list].sort();
  const expect = [...BUILTIN_WORDS].sort();
  if (sorted.join('|') !== expect.join('|')) {
    return { ok: false, reason: '政治关键词与出厂值不一致' };
  }
  return { ok: true, reason: '' };
}
