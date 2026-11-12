// draw-gate.mjs —— 作画闸门（2026-11-09 主人定：作画前读一遍守则，可以维持很长时间；过期要再看一遍）
//
// 用法：别的出图脚本开头 import 本文件并调用 requireDrawOpen()。
//   · 没开画 → 把 画\作画守则.txt 全文打出来，然后退出（不画画）。
//   · 开过期 → 同样打全文、要求重新开画。
// 开画：node 画\开画.py（它给码、你输回去、写 .draw-open.json，默认 24 小时有效）。
//
// 说明：这是一道「提醒闸」，不是防作弊的锁——文件我读得到。它拦的是手快。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = path.join(HERE, 'rules.txt');
const STATE = path.join(HERE, '.draw-open.json');

export function rulesToken() {
  const buf = fs.readFileSync(RULES);
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

export function requireDrawOpen() {
  const now = Date.now();
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    state = null;
  }
  const good =
    state &&
    state.token === rulesToken() &&
    typeof state.expiresAt === 'number' &&
    state.expiresAt > now;

  if (good) {
    const left = Math.round((state.expiresAt - now) / 3600000);
    console.log(`[闸门] 已开画，约 ${left} 小时后到期。`);
    return true;
  }

  let body = '';
  try {
    body = fs.readFileSync(RULES, 'utf8');
  } catch {
    body = '（守则文件丢了：画\\作画守则.txt 读不到）';
  }
  console.log('================ 作画守则（必须先读完） ================');
  console.log(body);
  console.log('=======================================================');
  if (state && state.token !== rulesToken()) {
    console.log('守则改过了，旧的通行码作废。');
  } else if (state) {
    console.log('通行码已过期。');
  } else {
    console.log('还没开画。');
  }
  console.log('现在开画：node 画\\开画.py ；把守则读到底，再把它给你的码输回去。');
  process.exit(9);
}
