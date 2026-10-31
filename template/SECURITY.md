# 安全说明

## 报告漏洞

请**不要**开公开 issue。发邮件到维护者邮箱，或在仓库使用 Security Advisory（GitHub 私有报告）。
请附：复现步骤、影响范围、建议修复方式。48 小时内会回复。

## 密钥怎么管

- **永远不要把 API key 写进 `config.json`**
- 用环境变量：`export DEEPSEEK_API_KEY=sk-xxx`
- `config.json` 已加入 `.gitignore`，仓库里只有 `config.example.json`
- 如果 key 泄漏：立刻到模型服务商后台吊销并重新生成

## 日志与数据

- `memory/` 存的是群昵称、群内约定等**个人数据**，已在 `.gitignore` 中
- `state.json` 存计数与公告记录，同样不提交
- 发 issue 贴日志前，先把群号、QQ 号、昵称、key 全部替换掉

## 已知的设计取舍

- 人格文件是**代码等价物**：加载别人给的人格文件等同于执行对方的指令。只加载你自己写的或你信任的文件
- 政治词表默认只放示例。完整词表属于运营配置，不建议开源（容易引战、也容易被针对性绕过）
- 协议端（NapCat / LLOneBot / Lagrange）不是官方客户端，登录行为本身有风控风险
