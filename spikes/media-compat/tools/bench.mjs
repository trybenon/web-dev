// Автоматическая проверка прототипа в Chromium (Playwright).
//
//   npm run build && npm run bench                 — VP9-ролики: конвертация и проверка звука
//   BIG=samples/big-120min-ac3.mkv npm run bench   — плюс замер скорости на длинном файле
//
// Chromium из Playwright не умеет H.264/AAC (нет закрытых кодеков), поэтому
// воспроизведение проверяется на VP9-роликах, а H.264 — только конвертация
// (копирование видео декодер не требует). Путь к другому Chrome — CHROMIUM_PATH.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, totalmem, platform } from 'node:os';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
// Путь к Chromium/Chrome. Без него берётся Chromium, установленный командой
// `npx playwright-core install chromium`.
const EXE = process.env.CHROMIUM_PATH || undefined;

function startServer() {
  return new Promise((ok, fail) => {
    const proc = spawn(process.execPath, ['tools/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '0' } });
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/LISTENING (\d+)/);
      if (m) ok({ proc, port: Number(m[1]) });
    });
    proc.on('exit', (c) => fail(new Error('server exited ' + c)));
  });
}

const { proc, port } = await startServer();
// Постоянный профиль: у временного (инкогнито) квота хранилища — сотни мегабайт, фильм не влезет.
const PROFILE = resolve(ROOT, 'results/.chromium-profile');
const browser = await chromium.launchPersistentContext(PROFILE, { executablePath: EXE, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
await page.goto(`http://localhost:${port}/`);
const env = await page.evaluate(async () => {
  await window.__spike.ready;
  return window.__spike.env;
});

// Chromium из Playwright не декодирует AAC — для проверки звука результата здесь берём Opus.
const CODEC = process.env.CODEC || 'opus';

async function run(file, trackNumber) {
  console.error('→', file);
  await page.setInputFiles('#file', resolve(ROOT, file));
  await page.waitForFunction(() => document.getElementById('verdict').dataset.done === '1', null, { timeout: 180_000 });
  const verdictText = await page.locator('#verdict').innerText();
  const ticker = setInterval(async () => {
    const t = await page.locator('#ptext').innerText().catch(() => '');
    if (t) console.error('   ', t);
  }, 30_000);
  const stats = await page.evaluate(
    ([n, codec]) => window.__spike.convert({ trackNumber: n, channels: 'stereo', copyDolbyForSafari: false, fragmented: false, audioCodec: codec }),
    [trackNumber, CODEC],
  );
  clearInterval(ticker);
  await page.click('#remove');
  return { file, codec: CODEC, sizeMb: Math.round(statSync(resolve(ROOT, file)).size / 1048576), trackNumber, verdict: verdictText.split('\n')[0], checkLine: verdictText.split('\n').at(-1), ...stats };
}

const results = [];
for (const [file, n] of [
  ['samples/vp9-ac3-5.1.mkv', 1],
  ['samples/vp9-eac3-5.1.mkv', 1],
  ['samples/vp9-dts-5.1.mkv', 1],
  ['samples/vp9-ac3+aac.mkv', 1],
  ['samples/02-h264-ac3-5.1.mkv', 1],
]) {
  results.push(await run(file, n));
}
if (process.env.BIG) {
  for (const big of process.env.BIG.split(',')) {
    if (existsSync(resolve(ROOT, big))) results.push(await run(big, 1));
  }
}

await browser.close();
proc.kill();

const version = await (async () => {
  const b = await chromium.launch({ executablePath: EXE });
  const v = b.version();
  await b.close();
  return v;
})();
rmSync(PROFILE, { recursive: true, force: true });
const machine = { platform: platform(), cpu: cpus()[0]?.model ?? '?', cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30) };
const out = { date: new Date().toISOString(), chromium: version, machine, env, results, pageErrors: errors };
mkdirSync(resolve(ROOT, 'results'), { recursive: true });
const name = `results/bench-${out.date.slice(0, 10)}-${CODEC}.json`;
writeFileSync(resolve(ROOT, name), JSON.stringify(out, null, 2));

console.log(`Chromium ${version}; AAC: ${env.nativeAacEncoder ? 'встроенный' : 'wasm'}; WebCodecs audio: ${env.webCodecsAudio}`);
console.log('файл | кодек | МБ | длит., с | время, с | × реальн. | МБ/с | звук после | первый кадр src→out | проверка до');
for (const r of results) {
  console.log(
    [r.file, r.codec, r.sizeMb, Math.round(r.durationSec), (r.ms / 1000).toFixed(1), r.speedX, r.mbPerSec, r.sound, `${r.firstVideoTs.source}→${r.firstVideoTs.output}`, r.verdict + ' / ' + r.checkLine].join(' | '),
  );
}
if (errors.length) console.log('Ошибки страницы:', errors);
console.log('Сохранено в', name);
