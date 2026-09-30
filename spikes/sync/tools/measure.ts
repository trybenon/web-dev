/**
 * Автоматический замер синхронизации в headless Chromium.
 *
 * Каждый участник — отдельный контекст браузера (как разные люди).
 * Истинное расхождение считается НЕ по оценке самих клиентов, а по записям
 * позиции с абсолютными метками времени: вкладки одной машины живут на одних
 * часах, поэтому posA(t) − posB(t) — честная ошибка синхронизации.
 *
 * Запуск:  npm run measure             (все сценарии)
 *          npm run measure -- start    (один сценарий)
 * Нужен Chromium: npx playwright install chromium
 * или путь к любому Chrome/Chromium в CHROMIUM_PATH.
 *
 * Ограничение: в headless нет звуковой карты, звук идёт в «пустой» вывод.
 * Реальные числа на ноутбуке с колонками и Bluetooth-наушниками будут иными —
 * их нужно снять вручную (см. README).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

type Rec = Array<[number, number, number, number]>; // [абс. время, позиция мс, rate, paused]

const ROOT = resolve(import.meta.dirname, '..');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Сервер ─────────────────────────────────────────────────────────

async function startServer(): Promise<{ proc: ChildProcess; base: string }> {
  const proc = spawn(process.execPath, ['server/main.ts'], { cwd: ROOT, env: { ...process.env, PORT: '0' } });
  const port = await new Promise<number>((res, rej) => {
    const t = setTimeout(() => rej(new Error('сервер не стартовал')), 10_000);
    proc.stdout!.on('data', (d: Buffer) => {
      const m = d.toString().match(/LISTENING (\d+)/);
      if (m) {
        clearTimeout(t);
        res(Number(m[1]));
      }
    });
    proc.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

// ─── Участник ───────────────────────────────────────────────────────

interface Peer {
  name: string;
  page: Page;
}

async function addPeer(browser: Browser, base: string, room: string, name: string, query = ''): Promise<Peer> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] ${e.message}`));
  await page.goto(`${base}/?room=${room}${query}`);
  await page.fill('#name', name);
  await page.click('#join'); // настоящий клик — это жест пользователя
  await page.waitForFunction(() => {
    const s = (window as any).__sync?.status;
    return s && s.connected && s.serverOffset !== null && s.mainOffset !== null && s.playback;
  }, undefined, { timeout: 15_000 });
  // Самооценка клиента: отфильтрованная ошибка относительно комнаты.
  await page.evaluate(() => {
    const w = window as any;
    w.__st = [];
    setInterval(() => {
      const s = w.__sync.status;
      if (s) w.__st.push([performance.timeOrigin + performance.now(), s.errorMs, s.rate, s.mode]);
    }, 250);
  });
  return { name, page };
}

/** Самооценка ошибки относительно комнаты: [абс. время, ошибка мс|null, rate, режим]. */
async function selfErr(p: Peer): Promise<Array<[number, number | null, number, string]>> {
  return p.page.evaluate(() => (window as any).__st.slice());
}

/** Абсолютная ошибка (отставание от комнаты) по самооценке: значения через 1, 2, 4, 8 с и хвост. */
function absProfile(series: Array<[number, number | null, number, string]>, fromAbs: number, toAbs: number): Record<string, number> {
  const pick = (dt: number): number => {
    const r = series.find((x) => x[0] >= fromAbs + dt && x[1] !== null);
    return r ? round(r[1] as number) : NaN;
  };
  const tail = series.filter((x) => x[0] >= toAbs - 3000 && x[0] <= toAbs && x[1] !== null).map((x) => Math.abs(x[1] as number));
  return { at1s: pick(1000), at2s: pick(2000), at4s: pick(4000), at8s: pick(8000), tailMeanAbs: round(tail.reduce((a, b) => a + b, 0) / (tail.length || 1)) };
}

async function status(p: Peer): Promise<any> {
  return p.page.evaluate(() => (window as any).__sync.status);
}

async function rec(p: Peer): Promise<Rec> {
  return p.page.evaluate(() => (window as any).__sync.rec.slice());
}

// ─── Анализ ─────────────────────────────────────────────────────────

/** Позиция b в момент t (линейная интерполяция, только между соседними играющими выборками). */
function posAt(r: Rec, t: number): number | null {
  let lo = 0;
  let hi = r.length - 1;
  if (hi < 1 || t < r[0][0] || t > r[hi][0]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (r[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const [t0, p0, , z0] = r[lo];
  const [t1, p1, , z1] = r[hi];
  if (z0 || z1 || t1 - t0 > 200 || p1 < p0 || p1 - p0 > (t1 - t0) * 1.2 + 5) return null; // пауза, пропуск или перемотка
  return p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
}

interface Series {
  t: number[]; // мс от начала окна
  d: number[]; // posA − posB, мс
}

function diffSeries(a: Rec, b: Rec, fromAbs: number, toAbs: number): Series {
  const out: Series = { t: [], d: [] };
  for (const [t, pa, , paused] of a) {
    if (t < fromAbs || t > toAbs || paused) continue;
    const pb = posAt(b, t);
    if (pb === null) continue;
    out.t.push(t - fromAbs);
    out.d.push(pa - pb);
  }
  return out;
}

function pct(values: number[], q: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function summarize(s: Series, settleAfterMs: number): Record<string, number> {
  const abs = s.d.map(Math.abs);
  const settled = abs.filter((_, i) => s.t[i] >= settleAfterMs);
  const firstIdx = s.d.length ? 0 : -1;
  let convergeMs = NaN;
  // Первое время, после которого |Δ| держится < 30 мс минимум 2 с.
  for (let i = 0; i < abs.length; i++) {
    if (abs[i] >= 30) continue;
    let ok = true;
    for (let j = i; j < abs.length && s.t[j] - s.t[i] < 2000; j++) if (abs[j] >= 30) ok = false;
    if (ok) {
      convergeMs = s.t[i];
      break;
    }
  }
  return {
    samples: s.d.length,
    firstDeltaMs: firstIdx >= 0 ? round(s.d[0]) : NaN,
    maxAbsMs: round(Math.max(...abs)),
    settledP50Ms: round(pct(settled, 0.5)),
    settledP95Ms: round(pct(settled, 0.95)),
    settledMaxMs: round(settled.length ? Math.max(...settled) : NaN),
    convergeBelow30Ms: round(convergeMs),
  };
}

const round = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

async function waitPlaying(p: Peer): Promise<number> {
  await p.page.waitForFunction(() => !(window as any).__sync.video.paused, undefined, { timeout: 20_000 });
  return p.page.evaluate(() => performance.timeOrigin + performance.now());
}

// ─── Сценарии ───────────────────────────────────────────────────────

type Scenario = (browser: Browser, base: string) => Promise<Record<string, unknown>>;

const scenarios: Record<string, Scenario> = {
  /**
   * Два участника без задержек. Старт, пауза и повторный старт: второй старт
   * показывает, помогло ли обучаемое опережение play().
   */
  async start(browser, base) {
    const a = await addPeer(browser, base, 'start', 'A');
    const b = await addPeer(browser, base, 'start', 'B');
    await sleep(1500);
    await a.page.click('#play');
    const t0 = await waitPlaying(a);
    await sleep(12_000);
    const lead1 = (await status(a)).startLeadMs;
    await a.page.click('#play'); // пауза
    await sleep(2000);
    await b.page.click('#play'); // снова играть, теперь жмёт B
    const t1 = await waitPlaying(b);
    await sleep(10_000);
    const [ra, rb, sa, sb, ea] = await Promise.all([rec(a), rec(b), status(a), status(b), selfErr(a)]);
    return {
      firstStart: summarize(diffSeries(ra, rb, t0, t0 + 12_000), 5000),
      firstStartAbsErrA: absProfile(ea, t0, t0 + 12_000),
      learnedStartLeadMs: lead1,
      secondStart: summarize(diffSeries(ra, rb, t1, t1 + 10_000), 5000),
      secondStartAbsErrA: absProfile(ea, t1, t1 + 10_000),
      rawOriginGapMsA: round(sa.rawOriginGapMs),
      bridgeOffsetMsA: round(sa.mainOffset),
      rttA: round(sa.rttMs),
      seeksA: sa.seeks,
      rateChangesA: sa.rateChanges,
      seeksB: sb.seeks,
      rateChangesB: sb.rateChanges,
    };
  },

  /** У B круговая задержка 120 мс (60 + 60): часы должны её скомпенсировать. */
  async lag(browser, base) {
    const a = await addPeer(browser, base, 'lag', 'A');
    const b = await addPeer(browser, base, 'lag', 'B', '&lag=lagUp%3D60%26lagDown%3D60');
    await sleep(2500);
    await a.page.click('#play');
    const t0 = await waitPlaying(a);
    await sleep(15_000);
    const [ra, rb, sa, sb, ea, eb] = await Promise.all([rec(a), rec(b), status(a), status(b), selfErr(a), selfErr(b)]);
    return {
      ...summarize(diffSeries(ra, rb, t0, t0 + 15_000), 5000),
      rttB: round(sb.rttMs),
      selfErrA: absProfile(ea, t0, t0 + 15_000),
      selfErrB: absProfile(eb, t0, t0 + 15_000),
      rateChangesA: sa.rateChanges,
      rateChangesB: sb.rateChanges,
      startLeadB: sb.startLeadMs,
    };
  },

  /** Асимметрия: к серверу 100 мс, обратно 0. NTP это не видит — ожидаем смещение ~50 мс. */
  async asym(browser, base) {
    const a = await addPeer(browser, base, 'asym', 'A');
    const b = await addPeer(browser, base, 'asym', 'B', '&lag=lagUp%3D100%26lagDown%3D0');
    await sleep(2500);
    await a.page.click('#play');
    const t0 = await waitPlaying(a);
    await sleep(15_000);
    const [ra, rb, sb, ea, eb] = await Promise.all([rec(a), rec(b), status(b), selfErr(a), selfErr(b)]);
    return {
      ...summarize(diffSeries(ra, rb, t0, t0 + 15_000), 5000),
      rttB: round(sb.rttMs),
      selfErrA: absProfile(ea, t0, t0 + 15_000),
      selfErrB: absProfile(eb, t0, t0 + 15_000),
    };
  },

  /** Сбой посреди просмотра: B прыгает на 300 мс (коррекция скоростью), затем на 900 мс (перемотка). */
  async kick(browser, base) {
    const a = await addPeer(browser, base, 'kick', 'A');
    const b = await addPeer(browser, base, 'kick', 'B');
    await sleep(1500);
    await a.page.click('#play');
    await waitPlaying(a);
    await sleep(5000);
    const k1 = await b.page.evaluate(() => {
      const v = (window as any).__sync.video as HTMLVideoElement;
      v.currentTime += 0.3;
      return performance.timeOrigin + performance.now();
    });
    await sleep(15_000);
    const s1 = await status(b);
    const k2 = await b.page.evaluate(() => {
      const v = (window as any).__sync.video as HTMLVideoElement;
      v.currentTime += 0.9;
      return performance.timeOrigin + performance.now();
    });
    await sleep(8000);
    const [ra, rb, s2] = await Promise.all([rec(a), rec(b), status(b)]);
    return {
      kick300: summarize(diffSeries(ra, rb, k1, k1 + 15_000), 12_000),
      kick300_seeks: s1.seeks,
      kick300_rateChanges: s1.rateChanges,
      kick900: summarize(diffSeries(ra, rb, k2, k2 + 8000), 5000),
      kick900_seeks: s2.seeks - s1.seeks,
      seekLeadLearnedMs: round(s2.seekLeadMs),
    };
  },

  /** Вход посреди просмотра: комната не ждёт, B догоняет сам. */
  async latejoin(browser, base) {
    const a = await addPeer(browser, base, 'late', 'A');
    await a.page.click('#play');
    await waitPlaying(a);
    await sleep(8000);
    const tJoin = await a.page.evaluate(() => performance.timeOrigin + performance.now());
    const b = await addPeer(browser, base, 'late', 'B');
    const tPlay = await waitPlaying(b);
    await sleep(10_000);
    const [ra, rb, sa] = await Promise.all([rec(a), rec(b), status(a)]);
    return {
      joinToPlayingMs: round(tPlay - tJoin),
      ...summarize(diffSeries(ra, rb, tPlay, tPlay + 10_000), 5000),
      roomPausedDuringJoin: sa.playback.status !== 'playing',
    };
  },
};

// ─── Запуск ─────────────────────────────────────────────────────────

/** Все числовые листья объекта в плоском виде: "kick300.settledP95Ms" → 11.4 */
function flatten(o: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (typeof o === 'number') out[prefix] = o;
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function medianOf(v: number[]): number {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const names = only.length ? only : Object.keys(scenarios);
  const repeat = Math.max(1, Number(process.env.REPEAT ?? 1));
  const { proc, base } = await startServer();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
  });
  const runs: Record<string, unknown[]> = {};
  const results: Record<string, unknown> = { browser: browser.version(), date: new Date().toISOString(), repeat, runs };
  try {
    for (const name of names) {
      runs[name] = [];
      for (let i = 0; i < repeat; i++) {
        process.stdout.write(`▶ ${name} #${i + 1}… `);
        const t = Date.now();
        try {
          const r = await scenarios[name](browser, base);
          runs[name].push(r);
          console.log(`готово за ${((Date.now() - t) / 1000).toFixed(0)} с`);
          if (repeat === 1) console.log(JSON.stringify(r, null, 2));
        } catch (e) {
          runs[name].push({ error: String(e) });
          console.log(`ОШИБКА: ${e}`);
        }
        for (const ctx of browser.contexts()) await ctx.close();
      }
    }
  } finally {
    await browser.close();
    proc.kill();
  }

  // Сводка: медиана и разброс по повторам.
  const lines = ['| Сценарий | Метрика | Медиана | Мин | Макс |', '|---|---|---|---|---|'];
  for (const [name, list] of Object.entries(runs)) {
    const flat = list.map((r) => flatten(r));
    const keys = [...new Set(flat.flatMap((f) => Object.keys(f)))];
    for (const k of keys) {
      const vals = flat.map((f) => f[k]).filter((v) => v !== undefined && Number.isFinite(v));
      if (!vals.length) continue;
      lines.push(`| ${name} | ${k} | ${round(medianOf(vals))} | ${round(Math.min(...vals))} | ${round(Math.max(...vals))} |`);
    }
  }
  const table = lines.join('\n');
  results.summary = table;
  console.log('\n' + table);

  await mkdir(resolve(ROOT, 'results'), { recursive: true });
  const file = resolve(ROOT, 'results', `measure-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(results, null, 2));
  await writeFile(resolve(ROOT, 'results', 'latest-summary.md'), table + '\n');
  console.log(`\nРезультаты: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
