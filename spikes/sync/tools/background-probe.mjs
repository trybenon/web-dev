// Автоматический прогон страницы background/ со скрытием вкладки.
// Запуск (Linux без экрана):  EXE=/путь/к/chrome MODE=muted HIDE=15000 xvfb-run -a node tools/background-probe.mjs
// На ноутбуке можно без xvfb-run: откроется настоящее окно.
// MODE: audible | muted | volume0 | lowvolume. Сервер спайка должен быть запущен (npm start).
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
// Скрытие вкладки по-настоящему: Chrome запускается вручную, вторая вкладка
// открывается в том же окне и выходит на передний план.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(process.env.EXE, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${join(tmpdir(), `sync-spike-prof-${port}`)}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox',
  ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : []),
  'about:blank'], { stdio: 'ignore' });
let version;
for (let i = 0; i < 50; i++) { try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(r => bws.once('open', r));
let id = 0; const pending = new Map();
bws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); bws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const targets = (await send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page');
const t1 = targets[0].targetId;
const s1 = (await send('Target.attachToTarget', { targetId: t1, flatten: true })).result.sessionId;
const evalIn = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, s1)).result?.result?.value;
await send('Page.enable', {}, s1);
await send('Page.navigate', { url: `${BASE}/background/index.html` }, s1);
await sleep(2500);
await evalIn(`document.getElementById('mode').value = '${process.env.MODE || 'audible'}'`);
await evalIn(`document.getElementById('start').click()`);
await sleep(2500);
console.log('до скрытия:', await evalIn('document.visibilityState'), 'paused:', await evalIn('window.__probe && document.getElementById("video").paused'));
const t2 = (await send('Target.createTarget', { url: 'about:blank', newWindow: false })).result.targetId;
await send('Target.activateTarget', { targetId: t2 });
await sleep(800);
console.log('после второй вкладки:', await evalIn('document.visibilityState'));
await sleep(Number(process.env.HIDE || 15000));
await send('Target.activateTarget', { targetId: t1 });
await sleep(5000);
console.log('после возврата:', await evalIn('document.visibilityState'));
const periods = await evalIn('JSON.stringify(window.__probe.periods)');
const origin = await evalIn('window.__probe.originGap');
console.log(JSON.stringify({ browser: version.Browser, mode: process.env.MODE || 'audible', hideMs: Number(process.env.HIDE || 15000), originGapMs: origin, periods: JSON.parse(periods || '[]') }, null, 1));
bws.close(); chrome.kill();
