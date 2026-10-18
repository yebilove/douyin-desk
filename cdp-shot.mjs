#!/usr/bin/env node
/** 用 CDP 截图，绕开窗口被其它程序遮挡的问题。 */
const HOST = '127.0.0.1';
const PORT = 9333;
const out = process.argv[2] || 'shot.png';

const list = await (await fetch(`http://${HOST}:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('douyin'));
if (!page) { console.error('找不到抖音页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
const send = (id, method, params) => new Promise((res, rej) => {
  const timer = setTimeout(() => rej(new Error(method + ' 超时')), 15000);
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === id) { clearTimeout(timer); ws.removeEventListener('message', onMsg); res(m); }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id, method, params }));
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const metrics = await send(1, 'Page.getLayoutMetrics', {});
const r0 = metrics.result;
const vp = r0.cssVisualViewport || r0.visualViewport || r0.layoutViewport;
// 注意：CDP 的 viewport 用 clientWidth/clientHeight，不是 width/height
const width = Math.round(vp.clientWidth || vp.width || 0);
const height = Math.round(vp.clientHeight || vp.height || 0);
if (!width || !height) {
  console.error('拿不到视口尺寸:', JSON.stringify(r0).slice(0, 300));
  process.exit(1);
}

const shot = await send(2, 'Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: false,
  clip: { x: 0, y: 0, width, height, scale: 1 },
});

if (!shot.result || !shot.result.data) {
  console.error('截图失败:', JSON.stringify(shot).slice(0, 300));
  process.exit(1);
}

const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(`已保存 ${out} (${width}x${height})`);
ws.close();