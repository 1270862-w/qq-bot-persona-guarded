# 贡献指南

## 开发环境

- Node.js >= 22（用到内置 WebSocket 与 `node --experimental-*` 之外的标准能力）
- 无外部依赖，不需要 `npm install`

## 跑测试

```bash
npm test          # 全部离线套件（不联网、不花钱）
npm test:api      # 额外跑真接口套件（需要 DEEPSEEK_API_KEY）
node coverage.mjs # 覆盖率报告（先跑 NODE_V8_COVERAGE=... node test-all.js）
```

**提 PR 前必须 `npm test` 全绿。** 测试失败就别提。

## 代码风格

- 零外部依赖：不要引入 npm 包
- 纯逻辑放 `lib/rules.js`（不依赖引擎状态，方便单测）
- 所有对外发言必须走 `_emit()`，不要直接调 `client.sendGroup`
- 新增行为要配断言；改 bug 要配回归断言

## PR 检查清单

- [ ] `npm test` 全绿
- [ ] 没有新增外部依赖
- [ ] 没有提交 `config.json` / `persona.md` / `memory/` / `state.json`
- [ ] 没有提交 API key
- [ ] 新行为有测试覆盖
- [ ] 涉及行为变更时更新了 CHANGELOG

## Issue

提 issue 请说明：版本、Node 版本、协议端与版本、复现步骤、期望与实际。
贴日志前先脱敏（群号、QQ 号、昵称、key）。
