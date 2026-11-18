#!/usr/bin/env node
/**
 * 安全的推送入口：先脱敏扫描，通过后才执行 git push。
 *
 * 用法：
 *   node scripts/push.js gitee master
 *   node scripts/push.js origin master --force-with-lease
 *
 * 任何参数都会原样透传给 git push，唯一的区别是前面多了一道扫描闸门。
 * 扫描不通过则直接退出，绝不推送。
 */

import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error('用法: node scripts/push.js <remote> <ref> [...git push 参数]');
  process.exit(2);
}

// 闸门 1：脱敏扫描
console.log('[push] 第 1 步：脱敏扫描…');
const scan = spawnSync(process.execPath, ['scripts/prescan.js', '--all'], {
  stdio: 'inherit',
  encoding: 'utf8',
});
if (scan.status !== 0) {
  console.error('\n[push] 已中止：脱敏扫描未通过，未执行任何推送。');
  process.exit(1);
}

// 闸门 2：确认不会把内部文档推出去（防止误 add）
const SKIP = /^(?:docs\/会话记忆|docs\/.*-会话|docs\/.*开发文档|docs\/.*实施方案|mont-BidCopilot实施方案\.md)/u;
try {
  const stale = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(file => SKIP.test(file));
  if (stale.length > 0) {
    console.error('\n[push] 已中止：暂存区里有内部文档，请先 git restore --staged 移出：');
    stale.forEach(f => console.error(`  ${f}`));
    process.exit(1);
  }
} catch {
  // 暂存区为空时 git 可能返回非零，忽略
}

// 闸门 3：检查是否有未提交改动（提醒，不阻断）
try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) {
    console.log('[push] 提示：工作区有未提交改动，它们不会被推送。');
  }
} catch { /* ignore */ }

// 闸门全部通过，执行推送
console.log('[push] 第 2 步：执行 git push…\n');
const out = spawnSync('git', ['push', ...argv], { stdio: 'inherit' });
process.exit(out.status ?? 1);
