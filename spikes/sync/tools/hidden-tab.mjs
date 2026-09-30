// Синхронизация, когда вкладка участника скрыта.
// Два отдельных процесса Chrome (как два человека), окна рядом — иначе окно B
// перекроет A, и Chrome не станет грузить видео в «скрытой» A.
// Запуск: EXE=/путь/к/chrome MUTE=volume0 HIDE=20000 xvfb-run -a -s "-screen 0 1600x900x24" node tools/hidden-tab.mjs
// MUTE: пусто (со звуком) | volume0 | muted. Сервер спайка должен быть запущен (npm start).
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
// A и B — два отдельных процесса Chrome (как два человека). B скрывается
// второй вкладкой в своём единственном окне — этот способ проверен в hidden2.mjs.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let slot = 0;
async function browser() {
  const pos = slot++ === 0 ? '0,0' : '800,0';
  const port = 9333 + Math.floor(Math.random() * 3000);
  const proc = spawn(process.env.EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${join(tmpdir(), `sync-spike-prof-${port}`)}`,
    `--window-position=${pos}`, '--window-size=790,880', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox', ...(process.env.EXTRA ? process.env.EXTRA.split(' ') : []), 'about:blank'], { stdio: 'ignore' });
  let v; for (let i = 0; i < 60; i++) { try { v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise(r => ws.once('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const targetId = (await send('Target.getTargets')).result.targetInfos.find(t => t.type === 'page').targetId;
  const sid = (await send('Target.attachToTarget', { targetId, flatten: true })).result.sessionId;
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }, sid)).result?.result?.value;
  return { send, sid, targetId, ev, close: () => { ws.close(); proc.kill(); } };
}
const A = await browser(), B = await browser();
const st = async (P) => JSON.parse(await P.ev('JSON.stringify({paused: window.__sync.video.paused, st: window.__sync.status && window.__sync.status.playback && window.__sync.status.playback.status})'));
const room = 'hid' + Date.now() % 100000;
const mute = process.env.MUTE ? `&mute=${process.env.MUTE}` : '';
await A.send('Page.navigate', { url: `${BASE}/?room=${room}` }, A.sid);
await B.send('Page.navigate', { url: `${BASE}/?room=${room}${mute}` }, B.sid);
await sleep(2500);
await A.ev(`document.getElementById('name').value='A'; document.getElementById('join').click()`);
await B.ev(`document.getElementById('name').value='B'; document.getElementById('join').click()`);
await sleep(3000);
const media = (P) => P.ev('JSON.stringify({rs: window.__sync.video.readyState, net: window.__sync.video.networkState, buf: Array.from({length: window.__sync.video.buffered.length}, (_, i) => [window.__sync.video.buffered.start(i).toFixed(2), window.__sync.video.buffered.end(i).toFixed(2)]), ct: window.__sync.video.currentTime, seeking: window.__sync.video.seeking})');

await A.ev(`document.getElementById('play').click()`);
await sleep(6000);
const abs = (P) => P.ev('performance.timeOrigin + performance.now()');
const st2 = async (P) => JSON.parse(await P.ev('JSON.stringify({paused: window.__sync.video.paused, ct: Math.round(window.__sync.video.currentTime*1000), st: window.__sync.status && window.__sync.status.playback && window.__sync.status.playback.status, blocked: !document.getElementById("blocked").hidden})'));
console.log('перед скрытием A:', JSON.stringify(await st(A)), ' B:', JSON.stringify(await st(B)));
const tHide = await abs(A);
const cover = (await B.send('Target.createTarget', { url: 'about:blank', newWindow: false })).result.targetId;
await B.send('Target.activateTarget', { targetId: cover });
await sleep(500);
const visB = await B.ev('document.visibilityState');
const midStatus = [];
const hideMs = Number(process.env.HIDE || 20000);
for (let i = 0; i < hideMs / 2000; i++) { await sleep(2000); const s = JSON.parse(await B.ev('JSON.stringify(window.__sync.status)')); midStatus.push(`${s.measurement}/${s.mode}/${s.errorMs === null ? '—' : Math.round(s.errorMs)}`); }
await B.send('Target.activateTarget', { targetId: B.targetId });
const tShow = await abs(A);
await sleep(8000);
const RA = JSON.parse(await A.ev('JSON.stringify(window.__sync.rec)')), RB = JSON.parse(await B.ev('JSON.stringify(window.__sync.rec)'));
const sb = JSON.parse(await B.ev('JSON.stringify(window.__sync.status)'));
const evB = await B.ev('JSON.stringify(window.__ev || [])');
function posAt(r, t) { for (let i = 1; i < r.length; i++) if (r[i][0] >= t) { const [t0,p0,,z0]=r[i-1],[t1,p1,,z1]=r[i]; if (z0||z1) return 'paused'; if (t1-t0>1500) return null; return p0 + (p1-p0)*(t-t0)/(t1-t0); } return null; }
const line = [];
for (let t = tHide - 2000; t < tShow + 8000; t += 1000) {
  const pa = posAt(RA, t), pb = posAt(RB, t);
  const d = typeof pa === 'number' && typeof pb === 'number' ? Math.round(pa - pb) : (pb === 'paused' ? 'пауза' : '—');
  line.push(`${t < tHide ? 'в' : t < tShow ? 'С' : 'в'}${Math.round((t - tHide) / 1000)}:${d}`);
}
console.log(`mute=${process.env.MUTE || 'нет'}; B во время скрытия: ${visB}`);
console.log('самооценка B каждые 2 с (измерения/режим/ошибка):', midStatus.join('  '));
console.log('после возврата B:', JSON.stringify({ mode: sb.mode, errorMs: sb.errorMs && Math.round(sb.errorMs), seeks: sb.seeks, rateChanges: sb.rateChanges }));
console.log('A−B по секундам (в=видна, С=скрыта):', line.join(' '));
A.close(); B.close();
