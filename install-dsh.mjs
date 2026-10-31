#!/usr/bin/env node
/**
 * install-dsh.mjs —— 一键把本插件接进 DeepSeek Harness（电脑上跑一次就行）
 *
 *   node install-dsh.mjs                    # 装进 web profile
 *   node install-dsh.mjs --profile headless # 装进指定 profile
 *   node install-dsh.mjs --print            # 只看会做什么，不落盘
 *
 * 做的事：
 *   1) 把当前目录 link 进 profile 的依赖（dsh plugin --profile X add link:<dir>）
 *   2) 把包名加进 profile package.json 的 dsh.profile.bundles（改前先备份）
 *   3) 把本插件的 cordis.patch.yml 里的配置路径改成当前绝对路径
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PROFILE = arg('profile', 'web');
const PRINT_ONLY = argv.includes('--print');

const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const PKG_NAME = PKG.name;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
const PROFILE_MANIFEST = path.join(PROFILE_DIR, 'package.json');

function say(...a) { console.log(...a); }
function die(msg) { console.error('\n❌ ' + msg); process.exit(1); }

say('=== qq-bot 接入 DeepSeekHarness ===');
say('插件目录 :', HERE);
say('DSH home :', DSH_HOME);
say('目标 profile:', PROFILE);
say('');

if (!fs.existsSync(DSH_HOME)) die('找不到 DSH home：' + DSH_HOME + '\n   请确认已安装 dsh，或设置环境变量 DSH_HOME');

/* ---------- 1) 改插件的 patch 文件：写死当前绝对路径 ---------- */
const patchPath = path.join(HERE, 'cordis.patch.yml');
const cfgPath = path.join(HERE, 'config.json').replace(/\\/g, '/');
const patch = `# 由 install-dsh.mjs 生成：把本插件 insert 进 dsh 的插件树
- insert:
    - id: qq-bot
      name: ${PKG_NAME}
      config:
        configFile: "${cfgPath}"
        autoStart: true
`;
say('[1/3] 写入 cordis.patch.yml');
say('      configFile →', cfgPath);
if (!PRINT_ONLY) fs.writeFileSync(patchPath, patch);

/* ---------- 2) link 进 profile ---------- */
say('[2/3] 安装依赖：dsh plugin --profile ' + PROFILE + ' add link:' + HERE);
if (!PRINT_ONLY) {
  const r = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'add', 'link:' + HERE], {
    stdio: 'inherit', shell: process.platform === 'win32'
  });
  if (r.status !== 0) die('安装依赖失败。可以手动执行：\n   dsh plugin --profile ' + PROFILE + ' add link:' + HERE);
}

/* ---------- 3) 加进 bundles ---------- */
say('[3/3] 注册到 profile 的 bundles 列表');
if (!fs.existsSync(PROFILE_MANIFEST)) {
  die('找不到 profile 配置：' + PROFILE_MANIFEST + '\n   先手动跑一次 dsh（会自动初始化 profile）再重试');
}
const manifest = JSON.parse(fs.readFileSync(PROFILE_MANIFEST, 'utf8'));
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
const bundles = manifest.dsh.profile.bundles || (manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base']);

if (bundles.includes(PKG_NAME)) {
  say('      已经在列表里，跳过');
} else {
  const backup = PROFILE_MANIFEST + '.bak-' + Date.now();
  if (!PRINT_ONLY) {
    fs.copyFileSync(PROFILE_MANIFEST, backup);
    bundles.push(PKG_NAME);
    fs.writeFileSync(PROFILE_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    say('      已加入；原文件备份到', path.basename(backup));
  } else {
    say('      (预览) 会加入', PKG_NAME);
  }
}

say('');
say('✅ 完成。接下来：');
say('   1) 装 NapCatQQ（或 Lagrange / LLOneBot），小号扫码登录');
say('      · HTTP 服务端 3000，WebSocket 服务端 3001');
say('   2) 编辑 ' + path.join(HERE, 'config.json'));
say('      · onebot.wsUrl / httpUrl / accessToken 对上 NapCat 的配置');
say('      · llm.apiKeyEnv 默认 DEEPSEEK_API_KEY，启动前 export 你的 key');
say('   3) 重启 dsh —— 插件会自己连上 OneBot 并开始听群消息');
say('   4) 把机器人拉进任意群，有人 @ 它 就会回（autoAcceptNewGroups 已开）');
