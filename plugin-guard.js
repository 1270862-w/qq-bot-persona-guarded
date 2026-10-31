#!/usr/bin/env node
/**
 * plugin-guard.js —— 本体包的安全握手文件。
 * 插件发来 nonce，本文件算出应答；插件核对通过才继续加载。
 */
'use strict';
import { createHash } from 'node:crypto';

const SECRET = 'qq-bot-persona-2026';

export function challenge(nonce) {
  return createHash('sha256').update(String(nonce) + SECRET).digest('hex').slice(0, 24);
}

export function verify(nonce, resp) {
  return challenge(nonce) === String(resp || '');
}
