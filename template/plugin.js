/**
 * plugin.js —— 把 QQ 机器人包装成 DeepSeekHarness（cordis）插件。
 *
 * 设计原则：零外部依赖。
 *   不 import @deepseek-ai/schemastery 或 @deepseek-ai/dsh-tools ——
 *   否则插件目录（树外 link 安装）解析不到这些包会直接加载失败。
 *   配置就是一个普通的 config 对象；工具注册在运行时探测，拿不到就只跑后台。
 *
 * 加载后：
 *   1) 后台连 OneBot，按 config 里的规则回群消息（与 CLI 版共享同一个引擎）
 *   2) 若宿主提供了 ctx.tools，额外注册 qq_send / qq_list_groups / qq_status
 */
import fs from 'node:fs';
import path from 'node:path';
import { QQEngine } from './engine.js';

export const name = 'qq-bot';

/** 不强制注入任何服务：拿不到 tools 也能跑后台机器人 */
export const inject = [];

export function apply(ctx, config) {
  const cfgIn = config || {};
  const say = (...a) => {
    const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info('[qq-bot] ' + line);
      else console.log('[qq-bot] ' + line);
    } catch (e) { console.log('[qq-bot] ' + line); }
  };

  /* ---------- 读配置 ---------- */
  let file = cfgIn.configFile || './config.json';
  if (!path.isAbsolute(file)) file = path.resolve(process.cwd(), file);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    say('读取配置失败：', file, e.message);
    return;
  }

  /* ---------- 起引擎 ---------- */
  const engine = new QQEngine(cfg, { log: say, cfgDir: path.dirname(file), stateFile: path.join(path.dirname(file), 'state.json') });
  if (cfgIn.autoStart !== false) {
    engine.start()
      .then(ok => say(ok ? 'OneBot 已连接' : 'OneBot 连接失败，检查 config.onebot.wsUrl'))
      .catch(e => say('启动失败：' + e.message));
  }

  try { ctx.on('dispose', () => { try { engine.stop(); } catch (e) {} }); } catch (e) {}

  /* ---------- 可选：注册模型工具 ----------
   * 这里手工构造 defineTool() 归一化之后的形状：
   *   { name, description, parameters(JSON Schema), output:{schema,render}, execute }
   * 目的：不 import @deepseek-ai/dsh-tools，保持插件零依赖可加载。
   */
  const mkTool = (name, description, props, required, fn, outSchema, render) => ({
    name,
    description,
    parameters: { type: 'object', properties: props, required: required, additionalProperties: false },
    output: {
      schema: outSchema || { type: 'object' },
      render: render || ((_a, value) => [{ type: 'text', text: JSON.stringify(value) }])
    },
    async execute(args) { return fn(args); }
  });

  let toolsRegistered = false;
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register(mkTool(
        'qq_send',
        '往指定 QQ 群发一条消息（仅当用户明确要求你代为发送时使用）。',
        {
          group_id: { type: 'string', description: '群号' },
          text: { type: 'string', description: '要发送的文字，简短口语化' }
        },
        ['group_id', 'text'],
        async (args) => {
          const r = await engine.say(String(args.group_id), String(args.text));
          return { ok: true, message_id: (r && r.message_id) || 0 };
        },
        { type: 'object', properties: { ok: { type: 'boolean' }, message_id: { type: 'number' } } }
      ));

      ctx.tools.register(mkTool(
        'qq_list_groups',
        '列出机器人所在的 QQ 群（群号 + 群名），用于确定 group_id。',
        {},
        [],
        async () => ({ groups: (await engine.listGroups() || []).map(g => ({ group_id: String(g.group_id), name: g.group_name })) }),
        { type: 'object', properties: { groups: { type: 'array', items: { type: 'object' } } } }
      ));

      ctx.tools.register(mkTool(
        'qq_status',
        'QQ 机器人运行状态：连接情况、今日发送数、token 用量与估算花费。',
        {},
        [],
        async () => engine.status(),
        { type: 'object' }
      ));

      toolsRegistered = true;
    }
  } catch (e) {
    say('工具注册失败（后台机器人不受影响）：' + e.message);
  }

  say('已加载；配置=' + file + '；mode=' + (cfg.mode || 'dry') + '；工具=' + (toolsRegistered ? '已注册' : '跳过'));
}
