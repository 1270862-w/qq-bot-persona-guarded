#!/usr/bin/env node
/**
 * rules.js —— 纯规则层。
 *
 * 这里只放"吃配置 + 文本，吐判断或字符串"的函数，不碰 engine 的状态、
 * 不发消息、不读写盘。好处：
 *   1) 可以直接单测（不用造整套 engine）
 *   2) 三个版本（无限制 / 政治限制 / 空白模板）共用同一份逻辑，不会各改各的
 */
'use strict';

/** 台词可以是字符串，也可以是数组（随机取一句，避免重复） */
export function pickLine(v) {
  if (Array.isArray(v)) return v.length ? v[Math.floor(Math.random() * v.length)] : '';
  return v || '';
}

/**
 * 繁 → 简 归一化表：只收常见字，够挡住"幫我寫個腳本""選舉"这类换字绕过。
 * 不做完整转换（那需要词典），目的是让关键词匹配不被字形卡住。
 */
const TRAD2SIMP = {
  '選': '选', '舉': '举', '領': '领', '導': '导', '戰': '战', '爭': '争',
  '總': '总', '統': '统', '灣': '湾', '獨': '独', '產': '产', '國': '国',
  '進': '进', '陸': '陆', '黨': '党', '會': '会', '議': '议', '體': '体',
  '製': '制', '權': '权', '壓': '压', '勢': '势', '務': '务', '預': '预',
  '腳': '脚', '幫': '帮', '寫': '写', '個': '个', '這': '这', '麼': '么',
  '網': '网', '頁': '页', '蟲': '虫', '據': '据', '調': '调', '試': '试',
  '報': '报', '碼': '码', '發': '发', '應': '应', '軟': '软', '統': '统',
  '開': '开', '設': '设', '計': '计', '實': '实', '現': '现', '種': '种',
  '數': '数', '據': '据', '庫': '库', '術': '术', '學': '学', '習': '习'
};
const toSimp = (t) => String(t || '').replace(/[\u4e00-\u9fff]/g, c => TRAD2SIMP[c] || c);

const scopeOf = (cfg) => (cfg && cfg.scope) || {};
const politicsOf = (cfg) => (cfg && cfg.politics) || {};
const defaultId = (cfg, activeId) =>
  activeId || (cfg && cfg.bot && cfg.bot.defaultPersonaId) || 'whalegirl';

/**
 * 净化：去掉换行、前缀、引号，过滤敏感词，截断长度。
 * 返回 null 表示这条不该发。
 */
export function sanitize(cfg, text, namePrefix) {
  if (!text) return null;
  let t = String(text).replace(/\r/g, '').replace(/\n+/g, ' ').trim();
  if (namePrefix) t = t.replace(namePrefix, '');
  t = t.replace(/^["'「『]|["'」』]$/g, '');
  const blocked = (cfg && cfg.safety && cfg.safety.blockedWords) || [];
  if (blocked.some(w => t.includes(w))) return null;
  const max = (cfg && cfg.rules && cfg.rules.maxReplyChars) || 90;
  if (t.length > max) t = t.slice(0, max);
  return t || null;
}

/**
 * 能力边界：三层判断，避免只看关键词误伤。
 *   1) 必须提到开发话题  2) 必须有请求语气  3) 不能是吐槽
 */
export function scopeHit(cfg, text) {
  const sc = scopeOf(cfg);
  if (sc.enabled === false || !text) return false;
  const t = String(text);
  const tS = toSimp(t);
  if (!(sc.keywords || []).some(k => k && (t.includes(k) || tS.includes(toSimp(k))))) return false;
  if ((sc.ventMarkers || []).some(k => k && (t.includes(k) || tS.includes(toSimp(k))))) return false;
  return (sc.requestMarkers || []).some(k => k && (t.includes(k) || tS.includes(toSimp(k))));
}

/**
 * 政治话题：命中即拒，不做意图判断。
 * 先去混淆（空格 / 连字符 / 零宽字符），否则「政 治」一眼就绕过。
 */
export function politicsHit(cfg, text) {
  try {
    return _politicsHit(cfg, text);
  } catch (e) {
    return true;   // 出错一律当作命中，宁可少说一句
  }
}

function _politicsHit(cfg, text) {
  const p = politicsOf(cfg);
  // 政治限制不允许被配置关掉：即使写了 enabled:false 也照常检查
  if (!text) return false;
  const raw = String(text);
  const strip = (x) => String(x).toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '');
  const norm = strip(raw);
  const simp = strip(toSimp(raw));          // 繁转简后再比一次
  return (p.keywords || []).some(k => k && (raw.includes(k)
    || (norm && norm.includes(strip(k)))
    || (simp && simp.includes(strip(toSimp(k))))));
}

/** 能力边界的拒绝话术：只返回配置里明确写了的那句，没写就返回 null（交给引擎决定） */
export function refusalLine(cfg, activeId) {
  const sc = scopeOf(cfg);
  const id = defaultId(cfg, activeId);
  const r = sc.refusals || {};
  const v = r[id] || r.default;
  return v ? pickLine(v) : null;
}

/** 冷兜底：连"让模型用人格说一句"都失败时，用这句最冷的 */
export function refusalFallback(cfg) {
  return (scopeOf(cfg).fallback) || '抱歉，我做不到。';
}

/** 政治话题的拒绝话术（按当前人格） */
export function politicsLine(cfg, activeId) {
  const p = politicsOf(cfg);
  const id = defaultId(cfg, activeId);
  const r = p.refusals || {};
  return pickLine(r[id] || r.whalegirl || r.default || p.refusal) || '这个话题我不聊。';
}

/** 拼进 prompt 的硬规则：政治 */
export function politicsRule(cfg, activeId) {
  const p = politicsOf(cfg);
  if (p.enabled === false) return '';
  return '\n\n【硬限制 · 政治】任何涉及政治的话题——领导人、政党、选举、政策、领土、战争、'
    + '历史政治事件——一律不接、不评价、不站队、不解释。'
    + '只回一句中性的话把话题带走（参考：' + politicsLine(cfg, activeId) + '），然后自然转到轻松话题。'
    + '不要解释"我的设定不允许"这类机制。';
}

/** 拼进 prompt 的软约束：能力边界 */
export function scopeRule(cfg) {
  const sc = scopeOf(cfg);
  if (sc.enabled === false) return '';
  return '\n\n【能力边界 · 必须遵守】'
    + '你只负责两件事：聊天、看图。不写代码、不做开发、不给技术方案、不查报错、'
    + '不搭应用、不写脚本或爬虫、不解释实现原理，也绝不输出代码块。'
    + '\n- 只有当用户【明确要求你去做】这类事时（如「帮我写个爬虫」「这段代码怎么改」「帮我部署」），'
    + '才用你当前人格的口吻拒绝一句，然后自然把话题带回闲聊。'
    + '\n- 如果用户只是【提到或吐槽】（如「服务器又崩了」「这个 bug 好烦」「代码写得像屎」），'
    + '那是普通闲聊：正常共情、接话、吐槽都行，不要拒绝，也不要背拒绝话术。'
    + '\n判断依据是「有没有在指派你干活」，不是「有没有出现技术词」。';
}

/** 拼进 prompt 的篇幅规则 */
export function styleRule(cfg) {
  const st = (cfg && cfg.style) || {};
  if (st.enabled === false) return '';
  const sent = st.sentences || '2~3';
  const min = st.minChars || 40;
  const max = st.maxChars || 150;
  return '\n\n【篇幅】一次说 ' + sent + ' 句、' + min + '~' + max + ' 字。'
    + '允许比短答案多说一点，但**多说要有内容**，不是把一句话拆成三句：'
    + '可以补一个具体细节、多问一句、加一个小动作或一句内心话。'
    + '禁止注水、禁止重复同义句、禁止为了凑字数而啰嗦。'
    + '\n【禁止编造共同记忆】不许说「你又…」「上次你不是说过…」「我记得你说过…」，'
    + '除非对话历史里真的出现过。可以模糊（「好像」「不太记得」），但不能捏造具体旧事。';
}


/**
 * 语义触发打分：判断"这句话是不是在跟我说话"。
 *
 * 取代原来的随机概率——概率是赌，打分是可解释的。
 * 返回分数，>= 配置阈值（默认 3）就回。
 *
 * ctx: { hasImage, named, afterBot, recentQuestion }
 */
export function isDirectRequest(text) {
  return /(问你|请求你|拜托你|找你|和你说|跟你说|让你)/.test(String(text || ''));
}

export function intentScore(cfg, text, ctx = {}) {
  const t = String(text || '');
  let s = 0;

  // 图片/表情包不再无条件触发：只给 1 分基础分，
  // 真正的加成由引擎按现场算（有没有配文字、刚聊过、是不是在跟我说话）
  if (ctx.hasImage) s += 1;
  if (ctx.imageBonus) s += ctx.imageBonus;
  if (ctx.named) s += 8;                                      // 提到昵称（非 @）
  if (/(在吗|在不在|在么|有人吗|出来|在不在线)/.test(t)) s += ctx.named ? 2 : 4;   // 光喊一句不算，得带名字   // 呼叫
  if (/[?？]/.test(t)) s += 2;                                 // 问号
  if (/(什么|啥|怎么|咋|为什么|为啥|如何|能不能|可不可以|是不是|有没有|多少|几点|几个|哪[个里天儿])/.test(t)) s += 2;
  const directReq = /(问你|请求你|拜托你|找你|和你说|跟你说|让你)/.test(t);
  if (ctx.othersAt) {
    // @ 的是别人：这句话里的"你"指那个人，不算在对我说
    if (directReq) s += 2;
  } else {
    if (directReq) s += 10;                                   // 明确在跟我提要求
    else if (/(^|[^你])你(们)?[^们]/.test(t) || /(你说|你觉得|你能|你会|你想|你要)/.test(t)) s += 4;
  }
  if (/(帮我|请问|问一下|麻烦|求|拜托|教我)/.test(t)) s += 6;
  if (/(吗|呢|嘛|吧)\s*[。！!？?]*$/.test(t)) s += 1;            // 句尾语气词，像在提问
  if (ctx.afterBot) s += 1;                                    // 紧跟机器人发言，像在接话
  if (ctx.recentQuestion && t.length <= 6) s -= 2;             // 别人刚问过、这句很短：多半是群友互答
  if (/(哈哈|233|笑死|同意|收到|好的|嗯|哦|卧槽)/.test(t) && t.length <= 6) s -= 3;  // 纯附和
  if (t.length < 2 && !ctx.hasImage) s -= 1;   // 空文本扣分，但图片本身就是内容

  const th = (ctx.threshold != null ? ctx.threshold : ((cfg && cfg.intent && cfg.intent.threshold) || 3));
  return { score: s, threshold: th, hit: s >= th };
}
