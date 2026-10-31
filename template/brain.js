#!/usr/bin/env node
/**
 * brain.js —— 大脑层：OpenAI 兼容接口（DeepSeek）+ 多轮上下文 + 识图 + 联网搜索。
 *
 * provider:
 *   "deepseek" → 真实调用（baseUrl 可换成任何 OpenAI 兼容网关）
 *   "mock"     → 不联网，返回固定格式的假回复，用于端到端联调
 *
 * 联网：用 DeepSeek 官方 Search API（/v1/tools/search），做成 function calling，
 *       由模型自己决定要不要搜——不是每条消息都搜，省次数也省上下文。
 */
'use strict';
import fs from 'node:fs';

const DEFAULTS = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  temperature: 0.9,
  maxTokens: 260,
  vision: true,
  timeoutMs: 30000,
  extraBody: { thinking: { type: 'disabled' } },  // 聊天场景关思考模式，省 5~10 倍输出费用
  search: { enabled: true, maxRounds: 2, maxSearches: 1, count: 5, needContent: false, charLimit: 2600 }
};

/* 搜索单价：5 元 / 1000 次成功请求 */
const SEARCH_PRICE_PER_CALL = 5 / 1000;

function makeBrain(cfg, logger) {
  const c = Object.assign({}, DEFAULTS, cfg || {});
  const S = Object.assign({}, DEFAULTS.search, (cfg && cfg.search) || {});
  S.maxSearches = Math.max(0, Number(S.maxSearches) || 0);
  // key 优先用配置里的 apiKey，其次从 apiKeyEnv 指定的环境变量读（避免把密钥写进 json）
  const RESOLVED_KEY = c.apiKey || (c.apiKeyEnv ? (process.env[c.apiKeyEnv] || '') : '');
  const log = logger || ((...a) => console.log(...a));
  const usage = { prompt: 0, completion: 0, calls: 0, searches: 0 };

  const api = (c.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');

  /* ---------- 图片 → data URL ---------- */
  async function toDataUrl(url) {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    try {
      if (url.startsWith('file://')) {
        const p = url.replace('file://', '');
        const b = fs.readFileSync(p);
        if (b.length > 4 * 1024 * 1024) { log('[brain] 图片过大，跳过'); return null; }
        const ext = (p.split('.').pop() || 'jpg').toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        return 'data:' + mime + ';base64,' + b.toString('base64');
      }
      // 图片下载必须有自己的超时：图床半死不活时，不能把整个群的处理流程挂死
      // （_process 卡住 → 该群的 _inflight 锁永远不释放 → 这个群相当于假死）
      const imgCtrl = new AbortController();
      const imgTimer = setTimeout(() => imgCtrl.abort(), c.imageTimeoutMs || 10000);
      let r;
      try { r = await fetch(url, { signal: imgCtrl.signal }); }
      finally { clearTimeout(imgTimer); }
      if (!r || !r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4 * 1024 * 1024) { log('[brain] 图片过大，跳过'); return null; }
      const mime = r.headers.get('content-type') || 'image/jpeg';
      return 'data:' + mime.split(';')[0] + ';base64,' + buf.toString('base64');
    } catch (e) {
      log('[brain] 图片下载失败:', e.message);
      return null;
    }
  }

  /** 带退避的重试：429 / 5xx / 网络错误重试 3 次，其余立即失败 */
  async function fetchRetry(makeReq, label) {
    let last;
    for (let i = 0; i < 3; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
      try {
        const r = await makeReq(ctrl.signal);
        if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); }
        else return r;
      } catch (e) { last = e; }
      finally { clearTimeout(timer); }
      if (i < 2) await new Promise(x => setTimeout(x, 400 * Math.pow(3, i)));
    }
    log('[brain] ' + label + ' 重试 3 次仍失败：' + (last && last.message));
    throw last;
  }

  /* ---------- 联网搜索 ---------- */
  async function webSearch(query, oriQuestion) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
    try {
      const r = await fetch(api + '/v1/tools/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESOLVED_KEY },
        body: JSON.stringify({
          query: String(query).slice(0, 128),
          count: S.count,
          ori_question: oriQuestion ? String(oriQuestion).slice(0, 128) : undefined,
          need_content: !!S.needContent
        }),
        signal: ctrl.signal
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        log('[search] HTTP ' + r.status + ' ' + t.slice(0, 150));
        return null;
      }
      const j = await r.json();
      const results = Array.isArray(j.results) ? j.results : [];
      if (results.length) usage.searches++;
      return results;
    } catch (e) {
      log('[search] 失败：' + e.message);
      return null;
    } finally { clearTimeout(timer); }
  }

  /** 把搜索结果压成给模型看的紧凑文本，控制长度 */
  function compact(results) {
    if (!results || !results.length) return '（没有搜到结果）';
    let out = '';
    results.forEach((r, i) => {
      const body = r.summary || r.snippet || r.content || '';
      const line = `[${i + 1}] ${r.title || '(无标题)'}\n${String(body).slice(0, 500)}\n来源：${r.url}${r.date ? '（' + r.date.slice(0, 10) + '）' : ''}\n`;
      if (out.length + line.length > S.charLimit) return;
      out += line;
    });
    return out || '（结果过长已过滤）';
  }

  /* ---------- 工具定义 ---------- */
  const TOOLS = [{
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索实时信息。遇到你不确定的事实、新闻、价格、日期、网络热梗、缩写/黑话、新出的产品/游戏/模型名，先搜再回答，别猜。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，1~128 字，尽量精确，可用 site: 等语法' }
        },
        required: ['query']
      }
    }
  }];

  const SEARCH_HINT = '\n\n【联网】你可以调用 web_search 联网查资料。遇到你不确定的、需要实时信息的问题（新闻、价格、最新版本、网络梗、你不认识的缩写或名字），先搜一下再回答，不要瞎编。查不到就直说查不到。';

  /* ---------- 单次模型调用 ---------- */
  async function chat(messages, withTools) {
    const body = Object.assign({
      model: c.model,
      messages,
      temperature: c.temperature,
      max_tokens: c.maxTokens,
      stream: false
    }, c.extraBody || {});
    if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto'; }

    {
      const send = (b) => fetchRetry(signal => fetch(api + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESOLVED_KEY },
        body: JSON.stringify(b),
        signal
      }), 'chat');

      let r = await send(body);
      // 换非 DeepSeek 模型时 extraBody（比如 thinking）可能不被支持 → 400。
      // 去掉它重试一次，避免"换个模型就全挂"。
      if (r.status === 400 && c.extraBody && Object.keys(c.extraBody).length) {
        log('[brain] HTTP 400，去掉 extraBody 重试一次（可能是该模型不支持这些参数）');
        const bare = Object.assign({}, body);
        for (const k of Object.keys(c.extraBody)) delete bare[k];
        r = await send(bare);
      }
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200));
      }
      const j = await r.json();
      if (j.usage) {
        usage.prompt += j.usage.prompt_tokens || 0;
        usage.completion += j.usage.completion_tokens || 0;
        usage.calls++;
      }
      return (j.choices && j.choices[0] && j.choices[0].message) || {};
    }
  }

  /**
   * @param {object} p
   * @param {string} p.persona    系统人格
   * @param {Array}  p.history    [{role:'user'|'assistant', content}]
   * @param {string} p.text       当前这条消息
   * @param {Array}  p.images     [{url}] 可选
   * @returns {Promise<string>}
   */
  async function reply(p) {
    const searchOn = S.enabled === true && c.provider !== 'mock';
    let persona = p.persona || '你是一个群聊助手，说话简短口语化，一次不超过两句话。';
    if (searchOn) persona += SEARCH_HINT;

    if (c.provider !== 'mock' && !RESOLVED_KEY) {
      throw new Error('缺少 API key：请在 config.llm.apiKey 填入，或设置环境变量 ' + (c.apiKeyEnv || 'DEEPSEEK_API_KEY'));
    }

    if (c.provider === 'mock') {
      await new Promise(r => setTimeout(r, 300));
      const tail = (p.text || '').slice(-20);
      return '收到「' + tail + '」，我这条是 mock 回复。';
    }

    let userContent = p.text || '';
    if (c.vision && p.images && p.images.length) {
      const parts = [];
      if (userContent) parts.push({ type: 'text', text: userContent });
      for (const img of p.images.slice(0, 3)) {
        const du = await toDataUrl(img.url);
        if (du) parts.push({ type: 'image_url', image_url: { url: du } });
      }
      if (parts.length > 1) userContent = parts;
    }

    const messages = [{ role: 'system', content: persona }];
    for (const h of (p.history || []).slice(-16)) messages.push({ role: h.role, content: h.content });
    messages.push({ role: 'user', content: userContent });

    /* --- 带工具调用的循环 --- */
    let rounds = 0;
    let searchesDone = 0;
    while (true) {
      const msg = await chat(messages, searchOn && rounds < S.maxRounds);
      const calls = msg.tool_calls || [];

      if (!calls.length) return String(msg.content || '').trim();

      // 模型要搜索：把 assistant 的 tool_calls 和结果都写回上下文
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });

      for (const call of calls) {
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (e) {}
        if (searchesDone >= S.maxSearches) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: '已达本次回复的搜索次数上限，请直接用已有信息回答。' });
          continue;
        }
        const q = args.query || args.q || p.text || '';
        searchesDone++;
        const results = await webSearch(q, p.text);
        const text = compact(results);
        log('[search] ' + q + ' → ' + (results ? results.length + ' 条' : '失败'));
        messages.push({ role: 'tool', tool_call_id: call.id, content: text });
      }

      rounds++;
      if (rounds >= S.maxRounds + 1) {
        // 兜底：再要一轮纯文本，不给工具
        const fin = await chat(messages, false);
        return String(fin.content || '').trim();
      }
    }
  }

  function stats() {
    return Object.assign({}, usage, {
      estCostCNY: estimateCost(usage, c.model),
      estSearchCNY: usage.searches * SEARCH_PRICE_PER_CALL
    });
  }

  return { reply, search: webSearch, stats, config: c, searchConfig: S };
}

/**
 * 粗略成本估算（按 DeepSeek 官方价，单位：元/百万 tokens）
 * flash  高峰：输入未命中 2 / 命中 0.04 / 输出 8
 * flash  空闲：输入未命中 1 / 命中 0.02 / 输出 4
 * v4-pro 高峰：输入未命中 9 / 命中 0.30 / 输出 27
 */
/** DeepSeek 高峰时段：工作日 9–12、14–18（按本机时区近似，节假日不区分） */
function isPeakHour(d = new Date()) {
  const day = d.getDay();
  if (day === 0 || day === 6) return false;   // 周末全天空闲价
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 成本估算（偏保守：输入一律按「缓存未命中」计价，不区分命中，实际会比这个便宜）
 */
function estimateCost(u, model, peak = isPeakHour()) {
  const isPro = /pro/i.test(model || '');
  const inMiss = isPro ? (peak ? 9 : 4.5) : (peak ? 2 : 1);
  const out = isPro ? (peak ? 27 : 13.5) : (peak ? 8 : 4);
  return (u.prompt / 1e6) * inMiss + (u.completion / 1e6) * out;
}

export { makeBrain, estimateCost, SEARCH_PRICE_PER_CALL };
