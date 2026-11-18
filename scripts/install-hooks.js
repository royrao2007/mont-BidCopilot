#!/usr/bin/env node
/**
 * 安装 git 钩子到当前仓库的 .git/hooks。
 *
 * 用法：npm run install-hooks
 *
 * 安装后：每次 git commit 会自动跑脱敏扫描，通过后推送到 gitee 与 origin。
 * 关闭自动推送：git config --local autopush.enabled false
 * 只推某个远端：git config --local autopush.remotes gitee
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'post-commit');
const DEST = join(ROOT, '.git', 'hooks', 'post-commit');

if (!existsSync(SRC)) {
  console.error(`找不到钩子源文件：${SRC}`);
  process.exit(1);
}

mkdirSync(dirname(DEST), { recursive: true });
copyFileSync(SRC, DEST);

if (process.platform !== 'win32') {
  try { chmodSync(DEST, 0o755); } catch { /* ignore */ }
}

console.log(`已安装 post-commit 钩子 → ${DEST}`);
console.log('此后每次 commit 会：脱敏扫描 → 推送到 gitee 与 origin');
console.log('关闭：git config --local autopush.enabled false');
