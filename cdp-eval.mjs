#!/usr/bin/env node
/**
 * CDP 执行器：连上自己的客户端，在页面里跑一段 JS 并打印结果。
 *
 * 用法：
 *   node cdp-eval.mjs "location.href"
 *   node cdp-eval.mjs --file expr.js
 */

import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const HOST = '127.0.0.1';

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node cdp-eval.mjs "<js 表达式>"  或  --file <路径>');
  process.exit(1);
}
const expr = arg === '--file' ? readFileSync(process.argv[3], 'utf-8') : arg;

const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('douyin.com')) || list.find((t) => t.type === 'page');
if (!page) {
  console.error('没有找到 page 目标');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const id = 1;
  const timer = setTimeout(() => reject(new Error('超时')), 20000);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== id) return;
    clearTimeout(timer);
    resolve(msg);
    ws.close();
  });
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression: expr, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true },
  }));
});

if (result.error) {
  console.error('CDP error:', JSON.stringify(result.error));
  process.exit(1);
}
const r = result.result;
if (r.exceptionDetails) {
  console.error('页面异常:', r.exceptionDetails.text, r.exceptionDetails.exception?.description || '');
  process.exit(1);
}
const v = r.result?.value;
console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : v);
