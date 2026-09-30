/**
 * Главный поток спайка: интерфейс, элемент video, rVFC, применение команд.
 * Решений о синхронизации здесь нет — только измерения и исполнение.
 *
 * Главное правило против «эха»: события video (play, pause, seeked,
 * ratechange) НИКОГДА не превращаются в намерения комнаты. Намерение
 * рождается только из наших собственных кнопок. Иначе программная пауза,
 * пришедшая от сервера, вернулась бы на сервер как пауза пользователя,
 * и комнату начало бы «трясти» — так ломались Syncplay (#73)
 * и Microsoft Live Share (#735).
 */
import type { FromWorker, ToWorker, WorkerStatus } from './sync.worker.ts';
import { bufferedAheadMs } from '../core/timeline.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('video');
const params = new URLSearchParams(location.search);

const worker = new Worker(new URL('./sync.worker.ts', import.meta.url), { type: 'module' });
const toWorker = (m: ToWorker): void => worker.postMessage(m);
worker.postMessage({ type: 'origin', mainOrigin: performance.timeOrigin });

let status: WorkerStatus | null = null;
let hasSource = false;
let isWaiting = false;
let playTimer: ReturnType<typeof setTimeout> | undefined;
let preparingRev = -1;

// ─── Источник видео ─────────────────────────────────────────────────

function setSource(url: string): void {
  video.src = url;
  hasSource = true;
  reportMedia();
}
if (params.get('src') !== 'none') setSource(params.get('src') ?? '/client/media/test.webm');

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) setSource(URL.createObjectURL(f));
});

// ─── Вход: жест пользователя разблокирует звук ──────────────────────

$<HTMLButtonElement>('join').addEventListener('click', () => {
  // Safari снимает запрет на звук для конкретного элемента, у которого
  // play() вызван внутри жеста. Chrome и Firefox запоминают активацию
  // страницы. Поэтому play()+pause() прямо в обработчике клика.
  const p = video.play();
  video.pause();
  p?.catch(() => {});

  // «Выключить звук» фильма — только через громкость, НЕ через muted:
  // скрытую вкладку с muted-видео Chrome ставит на паузу (проверено в спайке #4),
  // а с volume = 0 видео продолжает играть. ?mute=muted оставлен для опыта.
  const mute = params.get('mute');
  if (mute === 'muted') video.muted = true;
  else if (mute === 'volume0') video.volume = 0;

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${params.get('lag') ? '?' + params.get('lag') : ''}`;
  const config: Record<string, unknown> = {};
  if (params.get('seekOnly') === '1') config.seekOnly = true;
  toWorker({
    type: 'init',
    wsUrl,
    roomId: params.get('room') ?? 'demo',
    name: $<HTMLInputElement>('name').value || 'гость',
    userAgent: navigator.userAgent,
    config,
  });
  $('join').setAttribute('disabled', '');
  document.body.classList.add('joined');
});

// ─── Кнопки управления → намерения ──────────────────────────────────

$('play').addEventListener('click', () => {
  const s = status?.playback?.status;
  toWorker({ type: 'intent', action: s === 'paused' ? 'play' : 'pause', positionMs: video.currentTime * 1000 });
});
// Перемотка отправляется по отпусканию ползунка, а не при каждом движении:
// иначе поток намерений держит комнату в ожидании.
$<HTMLInputElement>('seek').addEventListener('change', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  toWorker({ type: 'intent', action: 'seek', positionMs: (v / 1000) * (video.duration || 0) * 1000 });
});

// ─── Измерения ──────────────────────────────────────────────────────

const useFrames = params.get('frames') !== '0' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
if (useFrames) {
  const onFrame = (_now: number, md: VideoFrameCallbackMetadata): void => {
    if (!video.paused) toWorker({ type: 'frame', mediaTimeMs: md.mediaTime * 1000, atMain: md.expectedDisplayTime });
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
}

function ranges(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < video.buffered.length; i++) out.push([video.buffered.start(i), video.buffered.end(i)]);
  return out;
}

video.addEventListener('waiting', () => {
  isWaiting = true;
  reportMedia();
});
video.addEventListener('playing', () => {
  isWaiting = false;
  reportMedia();
});
video.addEventListener('seeked', reportMedia);
video.addEventListener('seeking', reportMedia);
video.addEventListener('canplay', () => {
  reportMedia();
  checkPrepared();
});

function reportMedia(): void {
  toWorker({
    type: 'media',
    readyState: video.readyState,
    bufferedAheadMs: bufferedAheadMs(ranges(), video.currentTime),
    hasSource,
    seeking: video.seeking,
    waiting: isWaiting,
  });
}
setInterval(reportMedia, 500);

function checkPrepared(): void {
  if (preparingRev >= 0 && !video.seeking && video.readyState >= 3) {
    toWorker({ type: 'prepared', rev: preparingRev });
    preparingRev = -1;
  }
}
setInterval(checkPrepared, 100);

document.addEventListener('visibilitychange', () => toWorker({ type: 'visibility', hidden: document.hidden }));

// ─── Команды воркера ────────────────────────────────────────────────

function seekIfFar(positionMs: number, toleranceMs: number): void {
  if (Math.abs(video.currentTime * 1000 - positionMs) > toleranceMs) video.currentTime = positionMs / 1000;
}

worker.onmessage = (ev: MessageEvent<FromWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'tb:ping':
      // Ответ сразу: главный поток обрабатывает postMessage без дросселирования
      // даже в скрытой вкладке.
      worker.postMessage({ type: 'tb:pong', id: m.id, t0: m.t0, t1: performance.now() } satisfies ToWorker);
      return;
    case 'prepare':
      clearTimeout(playTimer);
      video.pause();
      seekIfFar(m.positionMs, 20);
      preparingRev = m.rev;
      checkPrepared();
      return;
    case 'playAt': {
      clearTimeout(playTimer);
      seekIfFar(m.positionMs, 30);
      const start = (): void => {
        video.play().catch((err: Error) => {
          // Автовоспроизведение заблокировано: нужен ещё один жест.
          $('blocked').hidden = false;
          console.warn('play() rejected', err.name);
        });
      };
      const delay = m.atMain - m.leadMs - performance.now();
      if (delay > 0) playTimer = setTimeout(start, delay);
      else start();
      return;
    }
    case 'pause':
      clearTimeout(playTimer);
      video.pause();
      seekIfFar(m.positionMs, 20);
      return;
    case 'setRate':
      if (video.playbackRate !== m.rate) video.playbackRate = m.rate;
      return;
    case 'seek':
      video.currentTime = m.positionMs / 1000;
      return;
    case 'sampleReq':
      if (!video.paused) toWorker({ type: 'sample', positionMs: video.currentTime * 1000, atMain: performance.now() });
      return;
    case 'status':
      status = m.status;
      render(m.status);
      return;
    case 'log':
      log(m.text);
      return;
  }
};

$('blocked').addEventListener('click', () => {
  $('blocked').hidden = true;
  video.play().catch(() => {});
});

// ─── Отображение ────────────────────────────────────────────────────

function fmt(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits);
}

function render(s: WorkerStatus): void {
  const p = s.playback;
  $('st-conn').textContent = s.connected ? `да (${s.peerId})` : 'нет';
  $('st-offset').textContent = `${fmt(s.serverOffset)} мс, RTT ${fmt(s.rttMs)} мс`;
  $('st-bridge').textContent = `${fmt(s.mainOffset)} мс (разница time origin ${fmt(s.rawOriginGapMs)} мс)`;
  $('st-room').textContent = p ? `${p.status}, rev ${p.rev}, поз. ${(p.positionMs / 1000).toFixed(2)} с` : '—';
  $('st-err').textContent = `${fmt(s.errorMs)} мс`;
  $('st-rate').textContent = s.rate.toFixed(3);
  $('st-mode').textContent = `${s.mode}, измерения: ${s.measurement}`;
  $('st-seeks').textContent = `${s.seeks} (опережение ${Math.round(s.seekLeadMs)} мс), смен скорости: ${s.rateChanges}, опережение старта ${s.startLeadMs} мс`;
  $('play').textContent = p?.status === 'paused' ? '▶ Играть' : '⏸ Пауза';
  const names = new Map(s.peers.map((x) => [x.peerId, x.name]));
  $('st-wait').textContent = s.waitingFor.length ? 'ждём: ' + s.waitingFor.map((id) => names.get(id) ?? id).join(', ') : '';
  $('peers').innerHTML = s.peers
    .map((x) => {
      const dev = Math.abs(x.presence.deviationMs) >= 1000 ? ` (${(x.presence.deviationMs / 1000).toFixed(1)} с)` : '';
      return `<li>${escapeHtml(x.name)}${x.peerId === s.peerId ? ' — вы' : ''}${dev}</li>`;
    })
    .join('');
}

function escapeHtml(t: string): string {
  return t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function log(text: string): void {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  $('log').prepend(li);
}

// ─── Запись для автоматического замера (tools/measure.ts) ───────────
// Каждые 50 мс: абсолютное время (одинаковая шкала у всех вкладок одной
// машины), позиция, скорость. Сравнивая записи двух вкладок, получаем
// расхождение независимо от собственной оценки часов.

const rec: Array<[number, number, number, number]> = [];
setInterval(() => {
  rec.push([performance.timeOrigin + performance.now(), video.currentTime * 1000, video.playbackRate, video.paused ? 1 : 0]);
}, 50);

Object.assign(window, {
  __sync: {
    rec,
    get status() {
      return status;
    },
    video,
  },
});
