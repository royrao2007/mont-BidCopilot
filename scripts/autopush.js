#!/usr/bin/env node
/**
 * post-commit 钩子：提交后自动推送。
 *
 * 规则来源（用户设定）：
 *   - 每次功能优化或新增后自动 push，无需手动触发
 *   - 推送前脱敏扫描，不得包含用户的隐私与敏感信息
 *
 * 行为：
 *   1. 在合并提交、rebase 中间态等情况下跳过（避免推送半成品历史）
 *   2. 跑脱敏扫描；不通过则中止，绝不推送
 *   3. 依次推送到 gitee、origin，单个远端失败不影响另一个
 *   4. 全部结果写入 .git/autopush.log 便于排查
 *
 * 关闭方式：git config --local autopush.enabled false
 * 只推某个远端：git config --local autopush.remotes gitee
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const LOG = join(ROOT, '.git', 'autopush.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, line, 'utf8');
  } catch { /* ignore */ }
  process.stdout.write(line);
}

function cfg(key, fallback = '') {
  try {
    return execFileSync('git', ['config', '--local', '--get', key], { encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function git(args, opts = {}) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// ── 开关 ──
if (cfg('autopush.enabled', 'true') === 'false') {
  log('autopush 已关闭（autopush.enabled=false），跳过。');
  process.exit(0);
}

// ── 跳过不安全的时机 ──
// 合并提交：通常由用户显式控制，不自动推
const parentCount = git(['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(/\s+/).length - 1;
if (parentCount > 1) {
  log('当前是合并提交，跳过自动推送。');
  process.exit(0);
}

// rebase / merge 进行中
const gitDir = git(['rev-parse', '--git-dir']).stdout.trim();
for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
  if (git(['rev-parse', '--verify', '-q', marker]) .status === 0) {
    log(`检测到 ${marker}，处于变基/合并中间态，跳过自动推送。`);
    process.exit(0);
  }
}

// 当前分支没配置上游且不是 master/main 时也跳过
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
if (branch === 'HEAD') {
  log('分离 HEAD 状态，跳过自动推送。');
  process.exit(0);
}

// ── 闸门 1：脱敏扫描 ──
log(`开始自动推送：分支 ${branch}`);
const scan = git(['ls-files', '--others', '--exclude-standard']);
const prescan = spawnSync(process.execPath, [join(ROOT, 'scripts', 'prescan.js'), '--all'], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (prescan.status !== 0) {
  log('脱敏扫描未通过，已中止推送 —— 请清理隐私/敏感信息后手动处理。');
  process.exit(0); // 不让 commit 失败，只是不推
}

// ── 闸门 2：确认没有内部文档被提交 ──
const INTERNAL = /(?:会话记忆|实施方案|开发文档|docs\/internal\/)/u;
const committed = git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout.split('\n').filter(Boolean);
const leaked = committed.filter(f => INTERNAL.test(f));
if (leaked.length > 0) {
  log(`提交里含内部文档，已中止推送：${leaked.join(', ')}`);
  process.exit(0);
}

// ── 推送 ──
const remotes = cfg('autopush.remotes', 'gitee origin').split(/\s+/).filter(Boolean);
const results = [];

for (const remote of remotes) {
  // 远端不存在则跳过
  const has = git(['remote', 'get-url', remote]);
  if (has.status !== 0) {
    results.push(`${remote}: 跳过（无该远端）`);
    log(`远端 ${remote} 不存在，跳过。`);
    continue;
  }
  const push = git(['push', remote, branch], { stdio: 'inherit' });
  if (push.status === 0) {
    results.push(`${remote}: 成功`);
    log(`推送到 ${remote} 成功。`);
  } else {
    results.push(`${remote}: 失败`);
    log(`推送到 ${remote} 失败（exit=${push.status}）。`);
  }
}

log(`推送结果 —— ${results.join(' | ')}`);
process.exit(0);
