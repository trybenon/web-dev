// Проверка поведения фоновой вкладки (спайк #4).
// Всё измеряется в абсолютной шкале performance.timeOrigin + performance.now(),
// одинаковой для окна и воркера.

const $ = (id) => document.getElementById(id);
const video = $('video');
const abs = () => performance.timeOrigin + performance.now();
const worker = new Worker('/background/probe.worker.js');

const state = {
  started: false,
  mainTicks: [],
  frames: [], // [abs, mediaTimeMs]
  samples: [], // [abs, currentTimeMs(развёрнутое), paused]
  beats: [], // [receivedAbs, delayMs]
  events: [], // [abs, name, currentTimeMs]
  hiddenAt: null,
  periods: [],
  wrapOffset: 0,
  lastCt: 0,
  statsWaiters: new Map(),
  originGap: null,
};

function log(text) {
  $('log').textContent = `${new Date().toLocaleTimeString()} ${text}\n` + $('log').textContent;
}

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'hello') {
    state.originGap = m.timeOrigin - performance.timeOrigin;
    log(`time origin воркера позже окна на ${state.originGap.toFixed(1)} мс; performance.now(): окно ${performance.now().toFixed(1)}, воркер ${m.now.toFixed(1)}`);
  }
  if (m.type === 'beat') state.beats.push([abs(), abs() - m.sentAt]);
  if (m.type === 'stats') {
    state.statsWaiters.get(m.id)?.(m);
    state.statsWaiters.delete(m.id);
  }
};
worker.postMessage({ type: 'hello' });

function workerStats(from, to) {
  const id = Math.random();
  return new Promise((resolve) => {
    state.statsWaiters.set(id, resolve);
    worker.postMessage({ type: 'stats', id, from, to });
  });
}

$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) {
    video.src = URL.createObjectURL(f);
    log(`файл: ${f.name}, ${(f.size / 1e9).toFixed(2)} ГБ`);
  }
});

$('start').addEventListener('click', async () => {
  const mode = $('mode').value;
  video.muted = mode === 'muted';
  video.volume = mode === 'volume0' ? 0 : mode === 'lowvolume' ? 0.01 : 1;
  try {
    await video.play();
  } catch (e) {
    log(`play() отклонён: ${e.name}`);
    return;
  }
  if (state.started) return;
  state.started = true;
  $('copy').disabled = false;
  log(`старт, режим «${mode}», ${navigator.userAgent}`);

  setInterval(() => {
    const t = abs();
    state.mainTicks.push(t);
    let ct = video.currentTime * 1000;
    if (ct + 1000 < state.lastCt) state.wrapOffset += (video.duration || 0) * 1000; // loop
    state.lastCt = ct;
    state.samples.push([t, ct + state.wrapOffset, video.paused ? 1 : 0]);
  }, 100);

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const onFrame = (_n, md) => {
      state.frames.push([abs(), md.mediaTime * 1000]);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  } else {
    log('requestVideoFrameCallback не поддерживается');
  }
});

for (const name of ['pause', 'play', 'waiting', 'playing', 'seeking', 'seeked', 'stalled', 'suspend', 'ended']) {
  video.addEventListener(name, () => {
    state.events.push([abs(), name, video.currentTime * 1000]);
    if (state.started) log(`событие video: ${name} @ ${video.currentTime.toFixed(2)} с${document.hidden ? ' (вкладка скрыта)' : ''}`);
  });
}
document.addEventListener('freeze', () => state.events.push([abs(), 'page-freeze', 0]));
document.addEventListener('resume', () => {
  state.events.push([abs(), 'page-resume', 0]);
  log('страница была заморожена браузером (freeze → resume)');
});

document.addEventListener('visibilitychange', async () => {
  if (!state.started) return;
  if (document.hidden) {
    state.hiddenAt = abs();
    return;
  }
  const from = state.hiddenAt;
  const to = abs();
  state.hiddenAt = null;
  if (from === null) return;
  // Даём 3 с после возврата, чтобы увидеть восстановление.
  log('вкладка снова видна, собираю данные 3 с…');
  await new Promise((r) => setTimeout(r, 3000));
  const period = await analyze(from, to);
  state.periods.push(period);
  render();
});

function maxGap(times) {
  let g = 0;
  for (let i = 1; i < times.length; i++) g = Math.max(g, times[i] - times[i - 1]);
  return g;
}

function sampleAt(t) {
  // Последняя выборка до t.
  let best = null;
  for (const s of state.samples) {
    if (s[0] <= t) best = s;
    else break;
  }
  return best;
}

async function analyze(from, to) {
  const dur = to - from;
  const mainIn = state.mainTicks.filter((t) => t >= from && t <= to);
  const w = await workerStats(from, to);
  const framesIn = state.frames.filter((f) => f[0] >= from && f[0] <= to).length;
  const beatsIn = state.beats.filter((b) => b[0] >= from && b[0] <= to);
  const eventsIn = state.events.filter((e) => e[0] >= from && e[0] <= to).map((e) => e[1]);
  const eventsAfter = state.events.filter((e) => e[0] > to && e[0] <= to + 3000).map((e) => e[1]);

  // Продвинулось ли видео так, как прошло время.
  const before = sampleAt(from);
  const after = state.samples.find((s) => s[0] >= to + 50);
  let drift = null;
  if (before && after) drift = after[1] - before[1] - (after[0] - before[0]) * (video.playbackRate || 1);

  // Восстановление: когда пришёл первый кадр и были ли замирания.
  const firstFrame = state.frames.find((f) => f[0] > to);
  const post = state.samples.filter((s) => s[0] > to && s[0] <= to + 3000);
  let stall = 0;
  for (let i = 1; i < post.length; i++) {
    const adv = post[i][1] - post[i - 1][1];
    const dt = post[i][0] - post[i - 1][0];
    if (!post[i][2]) stall = Math.max(stall, dt - adv);
  }

  return {
    mode: $('mode').value,
    hiddenSec: +(dur / 1000).toFixed(1),
    mainTimer: { ticks: mainIn.length, expected: Math.round(dur / 100), maxGapMs: Math.round(maxGap(mainIn)) },
    workerTimer: { ticks: w.count, expected: Math.round(dur / 100), maxGapMs: Math.round(w.maxGap) },
    workerToMainMessages: {
      received: beatsIn.length,
      expected: Math.round(dur / 500),
      maxDelayMs: Math.round(Math.max(0, ...beatsIn.map((b) => b[1]))),
    },
    rvfcWhileHidden: framesIn,
    pausedByBrowser: eventsIn.includes('pause'),
    driftMs: drift === null ? null : Math.round(drift),
    firstFrameAfterReturnMs: firstFrame ? Math.round(firstFrame[0] - to) : null,
    maxStallAfterReturnMs: Math.round(stall),
    frozen: eventsIn.includes('page-freeze'),
    eventsWhileHidden: eventsIn,
    eventsAfterReturn: eventsAfter,
  };
}

function cls(ok) {
  return ok ? 'ok' : 'bad';
}

function render() {
  const p = state.periods.at(-1);
  const rows = [
    ['Длительность скрытия', `${p.hiddenSec} с, режим «${p.mode}»`, ''],
    [
      'Таймер воркера, 100 мс',
      `<span class="${cls(p.workerTimer.maxGapMs < 300)}">${p.workerTimer.ticks} из ~${p.workerTimer.expected}, макс. пауза ${p.workerTimer.maxGapMs} мс</span>`,
      'Контур синхронизации живёт здесь. Паузы больше ~300 мс — контур в фоне не работает.',
    ],
    [
      'Таймер окна, 100 мс',
      `${p.mainTimer.ticks} из ~${p.mainTimer.expected}, макс. пауза ${p.mainTimer.maxGapMs} мс`,
      'Ожидаемо дросселируется (до 1 раза в секунду, в Chrome через 5 мин — до раза в минуту). Поэтому контур не в окне.',
    ],
    [
      'Сообщения воркер → окно',
      `<span class="${cls(p.workerToMainMessages.maxDelayMs < 300)}">${p.workerToMainMessages.received} из ~${p.workerToMainMessages.expected}, макс. задержка ${p.workerToMainMessages.maxDelayMs} мс</span>`,
      'Через них воркер в фоне опрашивает currentTime и отдаёт команды. Задержки больше ~300 мс — фоновая коррекция невозможна.',
    ],
    [
      'Кадры rVFC в скрытой вкладке',
      `${p.rvfcWhileHidden}`,
      'Ожидается 0 в Chrome и Firefox. Значит, в фоне нужен запасной путь измерений через currentTime.',
    ],
    [
      'Браузер поставил видео на паузу',
      `<span class="${cls(!p.pausedByBrowser)}">${p.pausedByBrowser ? 'да' : 'нет'}</span>`,
      'Chrome ставит на паузу скрытое видео без звука, Safari — любое беззвучное. Если «да» в режиме muted — «выключить звук» нельзя делать через muted.',
    ],
    [
      'Видео ушло относительно времени',
      p.driftMs === null ? '—' : `<span class="${cls(Math.abs(p.driftMs) < 150)}">${p.driftMs} мс</span>`,
      'Сколько контуру придётся догонять после возврата.',
    ],
    [
      'Первый кадр после возврата',
      p.firstFrameAfterReturnMs === null ? 'не пришёл за 3 с' : `через ${p.firstFrameAfterReturnMs} мс`,
      'Chrome через 10 с в фоне отключает видеодорожку и при возврате включает её внутренней перемоткой. Всё это время измерения по кадрам недостоверны — контур надо приостановить.',
    ],
    [
      'Замирание после возврата',
      `<span class="${cls(p.maxStallAfterReturnMs < 150)}">${p.maxStallAfterReturnMs} мс</span>`,
      'Если заметно — это та самая внутренняя перемотка.',
    ],
    ['Заморозка страницы (freeze)', p.frozen ? 'да' : 'нет', 'При заморозке встаёт и воркер, и сокет. После resume — полная ресинхронизация.'],
    ['События video в фоне', p.eventsWhileHidden.join(', ') || '—', ''],
    ['События video после возврата', p.eventsAfterReturn.join(', ') || '—', ''],
  ];
  $('result').innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');
}

$('copy').addEventListener('click', async () => {
  const report = {
    userAgent: navigator.userAgent,
    originGapMs: state.originGap,
    periods: state.periods,
  };
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    log('отчёт скопирован');
  } catch {
    log('буфер обмена недоступен, отчёт ниже');
    log(text);
  }
});

Object.assign(window, { __probe: state, __analyze: analyze });
