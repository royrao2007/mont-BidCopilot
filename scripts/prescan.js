#!/usr/bin/env node
/**
 * 推送前脱敏扫描闸门。
 *
 * 用法：
 *   node scripts/prescan.js            # 扫描即将推送的内容（HEAD 相对 origin 的提交）
 *   node scripts/prescan.js --staged   # 只扫暂存区
 *   node scripts/prescan.js --all      # 扫整个仓库已跟踪文件
 *
 * 退出码：0 = 通过；1 = 命中敏感内容，应中止推送。
 *
 * 设计要点：只报告「规则名 + 文件 + 行号」，绝不回显命中内容本身，
 * 避免把密钥再次打印到终端或日志里。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const MODE = args.has('--all') ? 'all' : args.has('--staged') ? 'staged' : 'push';

/** 敏感模式。name 用于报告，regex 用于匹配。 */
const PATTERNS = [
  { name: '私钥文件头', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub PAT (fine-grained)', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'Gitee Token', regex: /\b(?:gitee|gt)[_-]?[A-Za-z0-9]{32,}\b/i },
  { name: 'npm Token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: '通用 api key 赋值', regex: /\b(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  { name: 'Bearer Token 硬编码', regex: /Authorization\s*[:=]\s*['"]Bearer\s+[A-Za-z0-9._-]{20,}['"]/i },
  { name: '阿里云/腾讯云 KeyId', regex: /\bLTAI[A-Za-z0-9]{12,}\b/ },
  { name: '内网 IP 地址', regex: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/ },
  { name: '本机用户路径', regex: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\/\s'"]+/i },
  { name: '私密邮箱批量', regex: null, skip: true },
];

/** 允许清单：示例值、占位符、明显假值。 */
const ALLOW = /(?:your[_-]?|<[^>]*>|xxx+|\*\*\*|example|placeholder|redacted|\.\.\.|TODO|CHANGEME)/i;

/** 收集待扫描内容，返回 [{ label, text }]。 */
function collectBlobs() {
  const blobs = [];
  let files = [];

  if (MODE === 'all') {
    // 已跟踪文件 + 未跟踪但未被忽略的文件（新增文件尚未 add 时也必须扫到）
    const tracked = git(['ls-files']).split('\n').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    files = [...new Set([...tracked, ...untracked])];
  } else if (MODE === 'staged') {
    files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
  } else {
    // push 模式：找上游分支，扫差异文件；无上游则扫 HEAD 提交
    let range = null;
    try {
      const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
      range = [`${upstream}..HEAD`];
    } catch {
      range = null;
    }
    if (range) {
      files = git(['diff', '--name-only', '--diff-filter=ACMR', range[0]]).split('\n').filter(Boolean);
    } else {
      files = git(['show', '--pretty=format:', '--name-only', 'HEAD']).split('\n').filter(Boolean);
    }
  }

  // 二进制/资源文件跳过
  const SKIP_EXT = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot|zip|gz|tgz|pdf|mp4|webm)$/i;

  for (const file of files) {
    if (SKIP_EXT.test(file)) continue;
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    blobs.push({ label: file, text });
  }
  return blobs;
}

function git(argv) {
  return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function main() {
  const blobs = collectBlobs();
  if (blobs.length === 0) {
    console.log('[prescan] 没有待扫描的文本文件，通过。');
    return 0;
  }

  const hits = [];
  for (const { label, text } of blobs) {
    for (const pattern of PATTERNS) {
      if (!pattern.regex) continue;
      const re = new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : `${pattern.regex.flags}g`);
      let m;
      while ((m = re.exec(text)) !== null) {
        const matched = m[0];
        if (ALLOW.test(matched)) continue;
        hits.push({ pattern: pattern.name, label, line: lineOf(text, m.index) });
        if (hits.length > 200) break;
      }
    }
  }

  if (hits.length === 0) {
    console.log(`[prescan] 已扫描 ${blobs.length} 个文件（模式：${MODE}），未发现敏感内容，允许推送。`);
    return 0;
  }

  console.error(`\n[prescan] 发现 ${hits.length} 处疑似敏感内容，已中止推送：\n`);
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.label)) byFile.set(h.label, []);
    byFile.get(h.label).push(h);
  }
  for (const [file, list] of byFile) {
    console.error(`  ${file}`);
    for (const h of list) {
      console.error(`    第 ${h.line} 行 —— ${h.pattern}`);
    }
  }
  console.error('\n（出于安全考虑，不显示命中内容本身）');
  console.error('处理方式：删掉这些值 / 改用环境变量 / 加入 .gitignore，然后重新扫描。\n');
  return 1;
}

process.exit(main());
