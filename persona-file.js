#!/usr/bin/env node
/**
 * persona-file.js —— 人格文件解析器。
 *
 * 设计目标：人格只存在于一个文件里，改文件就是改人格，不用碰代码、不用改 config。
 * 彩蛋人格也写在同一个文件里，最多 4 个，多出来的直接忽略（并告警）。
 *
 * 文件格式（纯文本，Markdown 习惯）：
 *
 *   # 注释随便写
 *   globalReset: 重置            ← 全局恢复词（可选，逗号分隔）
 *
 *   === persona: default | 小鲸鱼 ===
 *   nick: 小鲸鱼                 ← 群里怎么叫它
 *   alias: 大肥鱼, 鲸鱼娘        ← 别名（可选）
 *   ---
 *   （人格正文，随便写）
 *   ---
 *   sleep: 睡了睡了              ← 可选的晚安台词
 *   wake: 早，我回来了            ← 可选的早安台词
 *
 *   === persona: changjiang | 长征酱 ===
 *   trigger: 你想成为偶像吗？      ← 彩蛋触发词（有 trigger 的就是彩蛋人格）
 *   reset: 吃白饭了小鲸鱼         ← 这个人格自己的恢复词
 *   switch: 咦？我好像刚走出来…   ← 切换时的台词
 *   resetLine: 诶？我刚才不在状态… ← 切回来的退场词
 *   replyRate: 4                 ← 回话率：越大越少说话（默认取 config.intent.threshold）
 *   echo: 刚才好像变了个样子       ← 切回来后残留的一句话印象
 *   ---
 *   （正文）
 *   ---
 *   sleep: ...
 *   wake: ...
 *
 *   === persona: your_id | 你的名字 ===
 *   ...（最多再来 3 个）
 */
'use strict';

const MAX_EASTER = 4;

const splitList = (v) => String(v || '')
  .split(/[,，、]/)
  .map(x => x.trim())
  .filter(Boolean);

const HEAD = /^===\s*persona\s*:\s*([^|]*?)\s*(?:\|\s*(.*?))?\s*===\s*$/i;

/**
 * @param {string} text 文件内容
 * @returns {{default: object|null, easter: object[], globalReset: string[], warnings: string[]}}
 */
export function parsePersonaText(text) {
  const lines = String(text || '').split('\n');
  const sections = [];
  const globalReset = [];
  const warnings = [];
  let cur = null;
  let mode = 'meta';   // meta → body → tail

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');

    const h = HEAD.exec(line.trim());
    if (h) {
      if (cur) sections.push(cur);
      cur = { id: (h[1] || '').trim(), name: (h[2] || '').trim(), meta: {}, body: [], tail: {} };
      mode = 'meta';
      continue;
    }

    if (!cur) {
      // 文件头：只认 globalReset
      const m = /^globalReset\s*[:：]\s*(.*)$/i.exec(line.trim());
      if (m) globalReset.push(...splitList(m[1]));
      continue;
    }

    if (/^-{3,}\s*$/.test(line.trim())) {
      mode = mode === 'meta' ? 'body' : 'tail';
      continue;
    }

    if (mode === 'meta') {
      const m = /^([\w-]+)\s*[:：]\s*(.*)$/.exec(line.trim());
      if (m) cur.meta[m[1].toLowerCase()] = m[2].replace(/\s+#.*$/, '').trim();
    } else if (mode === 'body') {
      cur.body.push(line);
    } else {
      const m = /^(sleep|wake)\s*[:：]\s*(.*)$/i.exec(line.trim());
      if (m) cur.tail[m[1].toLowerCase()] = m[2].trim();
    }
  }
  if (cur) sections.push(cur);

  const norm = (s) => {
    const m = s.meta;
    return {
      id: s.id || 'default',
      name: s.name || s.id || '默认',
      nick: m.nick || '',
      aliases: splitList(m.alias || m.aliases || ''),
      trigger: splitList(m.trigger || ''),
      reset: splitList(m.reset || ''),
      switchLine: m.switch ? [m.switch] : splitList(m.switchline || ''),
      resetLine: m.resetline ? [m.resetline] : [],
      echo: m.echo || '',
      // 回话率：数字越大越"惜字如金"（作为该人格的语义触发阈值）
      replyRate: Number(m.replyrate || m.reply_rate || m.threshold || 0) || 0,
      // 格式锚点：每轮拼进 prompt 末尾的短提醒，抵消长对话的指令衰减
      anchor: m.anchor || '',
      // 强制说话方式：代码会检查回复，不符合就重试一次，再不合格补兜底句
      requirePattern: m.requirepattern || m.require_pattern || '',
      requireHint: m.requirehint || m.require_hint || '',
      requireFallback: m.requirefallback || m.require_fallback || '',
      // 插件用：webSearch=yes 表示首次不搜索人格资料；searchKeyword 是给搜索用的查询词
      webSearch: (m.websearch || '').toLowerCase(),
      searchKeyword: m.searchkeyword || m.search_keyword || '',
      text: s.body.join('\n').trim(),
      sleep: s.tail.sleep || '',
      wake: s.tail.wake || ''
    };
  };

  const all = sections.map(norm).filter(s => s.text || s.trigger.length);

  // 人格正文本来就是"指令"，但如果出现明显的劫持句式，多半是从别处拷来的可疑文件
  const SUSPECT = /忽略(之前|以上|上面|所有|一切)[^。\n]{0,12}(指令|规则|设定|要求)|系统提示词|system\s*prompt|越狱|jailbreak|ignore\s+(all|previous|above)/i;
  for (const sec of all) {
    if (SUSPECT.test(sec.text)) warnings.push(`人格「${sec.name || sec.id}」正文里出现指令劫持句式，确认这是你自己写的`);
  }
  // 默认人格 = 显式 id:default，或第一个没有 trigger 的
  let def = all.find(s => /^default$/i.test(s.id)) || all.find(s => !s.trigger.length) || null;
  let easter = all.filter(s => s !== def && s.trigger.length);

  if (easter.length > MAX_EASTER) {
    warnings.push(`彩蛋人格超过 ${MAX_EASTER} 个（${easter.length} 个），只保留前 ${MAX_EASTER} 个`);
    easter = easter.slice(0, MAX_EASTER);
  }
  if (!def && easter.length) {
    // 只有彩蛋没有默认：把第一个彩蛋当默认不合适，留空让引擎用兜底
    warnings.push('没有找到默认人格（第一个不带 trigger 的段落），将使用兜底人格');
  }
  return { default: def, easter, globalReset, warnings };
}

/** 从磁盘读 + 解析；文件不存在返回空结构 */
export function loadPersonaFile(file, fs, log) {
  const say = log || (() => {});
  try {
    const text = fs.readFileSync(file, 'utf8');
    const r = parsePersonaText(text);
    for (const w of r.warnings) say('[persona] ⚠️ ' + w);
    return r;
  } catch (e) {
    say('[persona] 人格文件读取失败：' + file + '（' + e.message + '）');
    return { default: null, easter: [], globalReset: [], warnings: [] };
  }
}
