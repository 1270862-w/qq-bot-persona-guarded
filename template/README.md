# QQ 群聊机器人 · 空白模板

> 机制齐全、人格留空的模板。填一份 persona.md 就是你的机器人。

**这是仓库里的空白模板**（`template/` 目录），与根目录的开发版隔离，可单独下载使用。
与主版本的区别只有三处：`persona.md` 是留空的人格（含字段说明）、`config.json` 是空白配置（`mode: dry`、无群、token 为空）、不含真机测试记录。代码本身与主版本同代。

**版本：2.0.0**　|　许可证：GPL-3.0　|　测试：`npm test`

---

## 这是什么

一个跑在电脑上的 QQ 群聊机器人。通过 OneBot v11 协议接入 QQ（NapCat / LLOneBot / Lagrange），
用大模型按人格说话。**它只做两件事：聊天、识图。** 不写代码、不给技术方案、不查报错。

**它不是**：官方客户端、群管理工具、自动回复机器人、多平台框架。

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22**（自带 WebSocket，无需额外依赖） |
| 协议端 | NapCat / LLOneBot / Lagrange，需开启 HTTP(3000) 与 WS(3001) |
| 模型 | DeepSeek API（兼容 OpenAI 格式的其他服务也可） |
| 系统 | Linux / macOS / Windows（CI 覆盖 Ubuntu 与 Windows） |

**零外部依赖**：不需要 `npm install`。

---

## 快速开始

```bash
# 1. 起协议端并扫码登录一个小号，确认 HTTP 3000 / WS 3001 已开启
# 2. 复制配置和人格
cp config.example.json config.json
cp persona.example.md persona.md
# 3. 填 API key（不要写进 config.json）
export DEEPSEEK_API_KEY=sk-xxx
# 4. 自检，不联网不花钱
npm test
# 5. 连协议端看看群列表
node bot.js --check
# 6. dry 模式跑一天：只看日志不发消息
node bot.js
```

确认判断正确后，再把 `mode` 改成 `manual`（进队列待批）或 `auto`（直接发）。
**建议先在自己的测试群里跑。**

---

## 配置要点

| 字段 | 说明 |
|---|---|
| `onebot.wsUrl` / `httpUrl` | 协议端地址 |
| `llm.apiKeyEnv` | 读哪个环境变量取 key |
| `bot.nick` / `aliases` | 群里怎么叫它 |
| `personaFile` | 人格文件路径 |
| `mode` | `dry` / `manual` / `auto` |
| `groups` | 群白名单 |
| `rules` | 四层节流 |
| `scope` | 能力边界（拒绝开发类请求） |
| `politics` | 内容安全过滤 |
| `awareness` | 话题嗅觉 |
| `memory` | 长期记忆：`memory/<实例名>/<群号>/memory.json` |
| `schedule` | 作息 |
| `server` | 本地控制面板（默认关闭） |

---

## 触发方式（不靠概率，也不每次都要 @）

判断依据是「临时日志」里最近 30 条消息（`templog`）加上当前这句话，按规则打分：

| 信号 | 分 |
|---|---|
| 呼叫词（在吗 / 有人吗 / 出来） | +4 |
| 图片/表情包 | +1（有上下文才加分，见下） |
| 问号 | +2 |
| 疑问词（什么 / 怎么 / 为啥 / 啥 / 如何…） | +2 |
| 「你 / 你觉得 / 你能」 | +2 |
| 请求词（帮我 / 请问 / 教我） | +3 |
| 紧跟机器人发言（像在接话） | +1 |
| 纯附和（哈哈 / 嗯 / 收到） | −2 |

分数 ≥ `intent.threshold`（默认 3）就回复。**想更话痨调低，想更安静调高。**

**图片不再“看到就看”**：
- 纯刷图（没文字、没人说话、刚没回过）→ 不识别、不回复
- 配了文字 +1；群里正在聊 +2；刚回过话 +2
- 每个群有 **20 秒识图冷却**（`intent.imageCooldownMs`），不会连答

表情处理：
- emoji 会先转成文字再交给模型（`😂😂` → `[笑哭][笑哭]`）
- 纯表情消息**不触发回复**，只进临时日志
- 图片/表情包消息**直接触发识图**

原来的 `proactive.probability` 已移除。

---

## 人格

人格只存在于 **`persona.md` 一个文件**里——改文件就是改人格，不用碰代码。

- 默认人格 + 彩蛋人格都写在同一个文件
- 彩蛋人格最多 **4 个**，超出会被丢弃
- 运行中改文件会按 mtime 自动重载
- 格式见 `persona.example.md`

---

## 测试与覆盖率

```bash
npm run selftest         # 真机自检（连协议端，逐项验证）
npm test                 # 全部离线套件
npm test:api             # 真接口套件（需要 key）
node test-soak-time.js   # 90 天伪造时钟长跑
```

```bash
rm -rf cov
NODE_V8_COVERAGE=cov node test-all.js
node coverage.mjs cov
```

输出每文件行覆盖 / 函数覆盖 / 未执行块，并写 `coverage-summary.json`。
详细数据见 `CHANGELOG.txt`。

---

## 已知限制

- 公告按分钟触发，错过整点则当天不补发
- 超过 800 字的消息直接忽略
- 记忆召回是字符级，同义替换依赖 `memory.aliases`
- **尚未在真实 NapCat + 真实群聊中做长期运行验证**

---

## 安全

见 [SECURITY.md](./SECURITY.md)。要点：key 走环境变量；`config.json` / `persona.md` / `memory/` / `state.json` 不入库；
人格文件是代码等价物，只加载信任的文件；贴日志前先脱敏。

---

## 合规与风险

1. **非官方客户端**：通过协议端登录 QQ 违反平台用户协议，存在限流/封号风险，**请使用小号**。
2. **协议端**：NapCat / LLOneBot / Lagrange 为第三方项目，行为与安全不由本项目负责。
3. **模型服务**：费用自担，内容受服务商条款约束。
4. **内容安全过滤**：`politics` 是可配置项，默认只带少量示例词，不构成内容审查承诺。
5. **免责**：按 GPL-3.0 协议"按现状"提供，不附带任何担保。

---

## 许可与贡献

GPL-3.0，见 [LICENSE](./LICENSE)；贡献前看 [CONTRIBUTING.md](./CONTRIBUTING.md)；更新记录见 [CHANGELOG.txt](./CHANGELOG.txt)。

---

## 插件（plugins）

主包支持外部插件，放在 `plugins/<名字>/index.js`：

```json
"plugins": { "enabled": ["search-learn"] }
```

- 插件只能通过 `ctx.emit.use` 改文本、`ctx.prompt.use` 补人格；
  **拿不到发消息的能力**，所有输出仍走 `_emit` 的消毒/政治/节制
- 目录有变化会**自动热加载**，不用重启
- 插件加载前要过：`plugin-lock.json` + `plugin-guard.js` 握手、
  人格文件存在、人格文件含 `webSearch` 字段
- 目录：`memory/<实例>/<群号>/` 下按群隔离

现成插件：`plugin-search-learn.zip`（按群搜索学习 + 人格补全）。
