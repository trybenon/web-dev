/**
 * Воркер синхронизации.
 *
 * Владеет WebSocket, часами (сервер и главный поток) и контуром дрейфа.
 * В фоновой вкладке таймеры выделенного воркера не дросселируются ни в Chrome
 * (флаг BlinkSchedulerWorkerThrottling выключен по умолчанию), ни в Firefox
 * (dom.workers.throttling.enabled включён только в Nightly), ни в Safari
 * («We don't throttle timers in worker threads» в WebKit DOMTimer.cpp).
 *
 * Но измерения приходят из главного потока через requestVideoFrameCallback,
 * а он в скрытой вкладке Chrome и Firefox не вызывается. Поэтому, когда
 * кадры перестают приходить, воркер переходит на опрос currentTime.
 */
import { ClockEstimator, nextPingDelay } from '../core/clock.ts';
import { DriftController, isWebKitOnly, type ControllerConfig } from '../core/controller.ts';
import { errorAt, planStart, roomTargetAt, type Clocks } from '../core/timeline.ts';
import type { ClientMessage, PeerInfo, PlaybackState, ServerMessage } from '../shared/protocol.ts';

// ─── Сообщения с главным потоком ────────────────────────────────────

export type ToWorker =
  | { type: 'init'; wsUrl: string; roomId: string; name: string; userAgent: string; config?: Partial<ControllerConfig> }
  | { type: 'intent'; action: 'play' | 'pause' | 'seek'; positionMs: number }
  | { type: 'frame'; mediaTimeMs: number; atMain: number }
  | { type: 'sample'; positionMs: number; atMain: number }
  | { type: 'media'; readyState: number; bufferedAheadMs: number; hasSource: boolean; seeking: boolean; waiting: boolean }
  | { type: 'prepared'; rev: number }
  | { type: 'tb:pong'; id: number; t0: number; t1: number }
  | { type: 'visibility'; hidden: boolean };

export interface WorkerStatus {
  connected: boolean;
  peerId: string | null;
  serverOffset: number | null;
  rttMs: number | null;
  mainOffset: number | null;
  rawOriginGapMs: number;
  playback: PlaybackState | null;
  mode: string;
  errorMs: number | null;
  rate: number;
  seeks: number;
  rateChanges: number;
  seekLeadMs: number;
  startLeadMs: number;
  measurement: 'frames' | 'poll' | 'none';
  peers: PeerInfo[];
  waitingFor: string[];
}

export type FromWorker =
  | { type: 'tb:ping'; id: number; t0: number; workerOrigin: number }
  | { type: 'prepare'; rev: number; positionMs: number }
  /** Вызвать play() в момент atMain − leadMs, чтобы головка тронулась ровно в atMain. */
  | { type: 'playAt'; rev: number; positionMs: number; atMain: number; leadMs: number }
  | { type: 'pause'; positionMs: number }
  | { type: 'setRate'; rate: number }
  | { type: 'seek'; positionMs: number }
  | { type: 'sampleReq' }
  | { type: 'status'; status: WorkerStatus }
  | { type: 'log'; text: string };

// ─── Состояние ──────────────────────────────────────────────────────

const post = (m: FromWorker): void => (self as unknown as Worker).postMessage(m);
const log = (text: string): void => post({ type: 'log', text });
const now = (): number => performance.now();

const serverClock = new ClockEstimator({ window: 8 });
const mainClock = new ClockEstimator({ window: 8 });
let controller = new DriftController();

let ws: WebSocket | null = null;
let init: Extract<ToWorker, { type: 'init' }> | null = null;
let peerId: string | null = null;
let reconnectAttempt = 0;
let pingId = 0;
const pendingPings = new Map<number, number>();
let serverPings = 0;
let mainPings = 0;
let rawOriginGapMs = 0;

let playback: PlaybackState | null = null;
/** Ревизия, которую получили и начали применять. */
let seenRev = -1;
/** Ревизия, к которой плеер подготовлен (уходит в presence). */
let appliedRev = -1;
/** Состояние, отложенное до калибровки часов. */
let pendingState: PlaybackState | null = null;
let startAtWorker = Infinity;

let media = { readyState: 0, bufferedAheadMs: 0, hasSource: false, seeking: false, waiting: false };
let lastFrameAt = -Infinity;
let hidden = false;
let peers: PeerInfo[] = [];
let waitingFor: string[] = [];

function clocks(): Clocks | null {
  const s = serverClock.offset();
  const m = mainClock.offset();
  return s === null || m === null ? null : { serverOffset: s, mainOffset: m };
}

function calibrated(): boolean {
  return serverClock.size >= 4 && mainClock.size >= 3;
}

// ─── Сеть ───────────────────────────────────────────────────────────

function wsSend(m: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect(): void {
  if (!init) return;
  ws = new WebSocket(init.wsUrl);
  ws.onopen = () => {
    reconnectAttempt = 0;
    pendingPings.clear();
    serverClock.reset();
    serverPings = 0;
    seenRev = -1;
    appliedRev = -1;
    wsSend({ type: 'room:join', roomId: init!.roomId, name: init!.name });
    schedulePing();
  };
  ws.onmessage = (ev) => onServer(JSON.parse(ev.data as string) as ServerMessage);
  ws.onclose = () => {
    ws = null;
    // Экспоненциальная задержка с «дрожанием», потолок 10 с.
    const delay = Math.min(10_000, 500 * 2 ** reconnectAttempt) * (0.5 + Math.random() / 2);
    reconnectAttempt += 1;
    log(`соединение потеряно, повтор через ${Math.round(delay)} мс`);
    setTimeout(connect, delay);
  };
}

const DEAD_AFTER_MS = 15_000;
let pingTimer: ReturnType<typeof setTimeout> | undefined;
function schedulePing(): void {
  clearTimeout(pingTimer);
  pingTimer = setTimeout(() => {
    const t0 = now();
    // Пинг заодно служит пульсом. Браузер не видит ping/pong протокола WebSocket,
    // а «полуоткрытое» соединение (ноутбук уснул, сменилась сеть) может не
    // закрываться минутами. Нет ответа 15 с (три обычных интервала) — рвём сами,
    // onclose переподключит.
    for (const sentAt of pendingPings.values()) {
      if (t0 - sentAt > DEAD_AFTER_MS) {
        pendingPings.clear();
        log('сервер не отвечает на пинги — переподключаюсь');
        ws?.close();
        return; // пинги возобновит onopen
      }
    }
    const id = ++pingId;
    pendingPings.set(id, t0);
    wsSend({ type: 'sync:ping', id, t0 });
    serverPings += 1;
    schedulePing();
  }, nextPingDelay(serverPings));
}

let tbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMainPing(): void {
  clearTimeout(tbTimer);
  tbTimer = setTimeout(() => {
    post({ type: 'tb:ping', id: ++mainPings, t0: now(), workerOrigin: performance.timeOrigin });
    scheduleMainPing();
  }, nextPingDelay(mainPings, 6, 100, 10_000));
}

function onServer(msg: ServerMessage): void {
  switch (msg.type) {
    case 'sync:pong': {
      const t3 = now();
      pendingPings.delete(msg.id);
      serverClock.add(msg.t0, msg.t1, msg.t2, t3);
      if (pendingState && calibrated()) {
        const s = pendingState;
        pendingState = null;
        applyState(s, true);
      }
      return;
    }
    case 'room:state':
      peerId = msg.you;
      peers = msg.peers;
      // Снапшот применяется всегда, даже если rev не вырос (переподключение).
      seenRev = -1;
      applyState(msg.playback, true);
      return;
    case 'playback:state':
      applyState(msg.playback, false);
      return;
    case 'playback:hold':
      waitingFor = msg.waitingFor;
      return;
    case 'presence:sync':
      peers = msg.peers;
      return;
    case 'room:peer_joined':
      peers = [...peers.filter((p) => p.peerId !== msg.peer.peerId), msg.peer];
      return;
    case 'room:peer_left':
      peers = peers.filter((p) => p.peerId !== msg.peerId);
      return;
    case 'error':
      log(`ошибка сервера: ${msg.code}`);
      return;
  }
}

// ─── Применение состояния комнаты ───────────────────────────────────

/** Выполнить решение контроллера. Возвращаемое значение suspend() тоже решение: его нельзя терять. */
function apply(d: ReturnType<DriftController['decide']>): void {
  if (d.kind === 'rate') post({ type: 'setRate', rate: d.rate });
}

function applyState(state: PlaybackState, force: boolean): void {
  if (!force && state.rev <= seenRev) return; // устаревшее или дубль
  if (!calibrated() || !media.hasSource) {
    // Без часов якорь не перевести в локальное время: откладываем.
    pendingState = state;
    playback = state;
    return;
  }
  seenRev = state.rev;
  playback = state;
  if (state.status !== 'waiting') waitingFor = [];
  const c = clocks()!;
  const t = now();

  switch (state.status) {
    case 'paused':
      startAtWorker = Infinity;
      post({ type: 'setRate', rate: 1 });
      post({ type: 'pause', positionMs: state.positionMs });
      controller.suspend(t, 0);
      appliedRev = state.rev;
      sendPresence();
      return;
    case 'waiting':
      startAtWorker = Infinity;
      post({ type: 'setRate', rate: 1 });
      post({ type: 'prepare', rev: state.rev, positionMs: state.positionMs });
      controller.suspend(t, 0);
      return; // appliedRev выставится, когда главный поток доложит «prepared»
    case 'playing': {
      const plan = planStart(state, t, c);
      startAtWorker = plan.atMain - c.mainOffset;
      post({ type: 'setRate', rate: 1 });
      // Даём плееру стартовать, потом включаем контур.
      controller.suspend(t, startAtWorker - t + 300);
      controller.noteStart();
      post({ type: 'playAt', rev: state.rev, positionMs: plan.positionMs, atMain: plan.atMain, leadMs: controller.startLeadMs });
      appliedRev = state.rev;
      sendPresence();
      return;
    }
  }
}

// ─── Контур ─────────────────────────────────────────────────────────

function addMeasurement(mediaTimeMs: number, atMain: number): void {
  const c = clocks();
  if (!c || !playback || playback.status !== 'playing') return;
  if (media.seeking || media.waiting) return;
  const { atWorker, errorMs } = errorAt(playback, mediaTimeMs, atMain, c);
  if (atWorker < startAtWorker + 100) return; // до старта ошибка бессмысленна
  controller.addSample(atWorker, errorMs);
}

setInterval(() => {
  const t = now();
  const c = clocks();
  if (!c || !playback || playback.status !== 'playing' || t < startAtWorker) return;

  // Кадры не приходят (фон, нет rVFC) — опрашиваем currentTime.
  if (t - lastFrameAt > 500) post({ type: 'sampleReq' });

  const d = controller.decide(t);
  if (d.kind === 'rate') post({ type: 'setRate', rate: d.rate });
  else if (d.kind === 'seek') {
    // Перемотка сбрасывает коррекцию скоростью: плеер тоже возвращаем к 1.0.
    post({ type: 'setRate', rate: 1 });
    const target = roomTargetAt(playback, t + c.serverOffset + d.leadMs);
    post({ type: 'seek', positionMs: target });
    log(`перемотка: опережение ${d.leadMs} мс`);
  }
}, 100);

function sendPresence(): void {
  const snap = controller.snapshot(now());
  wsSend({
    type: 'presence:update',
    presence: {
      readyState: media.readyState,
      bufferedAheadMs: media.bufferedAheadMs,
      hasSource: media.hasSource,
      deviationMs: Math.round(snap.filteredErrorMs ?? 0),
      appliedRev,
      rttMs: Math.round(serverClock.rtt() ?? 0),
    },
  });
}
setInterval(sendPresence, 1000);

setInterval(() => {
  const t = now();
  const snap = controller.snapshot(t);
  post({
    type: 'status',
    status: {
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      peerId,
      serverOffset: serverClock.offset(),
      rttMs: serverClock.rtt(),
      mainOffset: mainClock.offset(),
      rawOriginGapMs,
      playback,
      mode: snap.mode,
      errorMs: snap.filteredErrorMs,
      rate: snap.rate,
      seeks: snap.seeks,
      rateChanges: snap.rateChanges,
      seekLeadMs: snap.seekLeadMs,
      startLeadMs: snap.startLeadMs,
      measurement: t - lastFrameAt < 500 ? 'frames' : playback?.status === 'playing' ? 'poll' : 'none',
      peers,
      waitingFor,
    },
  });
}, 250);

// ─── Сообщения главного потока ──────────────────────────────────────

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      init = m;
      controller = new DriftController({ seekOnly: isWebKitOnly(m.userAgent), ...m.config });
      scheduleMainPing();
      connect();
      return;
    case 'intent':
      wsSend({ type: 'playback:intent', action: m.action, positionMs: m.positionMs });
      return;
    case 'frame':
      lastFrameAt = now();
      addMeasurement(m.mediaTimeMs, m.atMain);
      return;
    case 'sample':
      addMeasurement(m.positionMs, m.atMain);
      return;
    case 'media': {
      const hadSource = media.hasSource;
      const wasBusy = media.seeking || media.waiting;
      media = { readyState: m.readyState, bufferedAheadMs: m.bufferedAheadMs, hasSource: m.hasSource, seeking: m.seeking, waiting: m.waiting };
      if (!hadSource && m.hasSource && pendingState && calibrated()) {
        const s = pendingState;
        pendingState = null;
        applyState(s, true);
      }
      // Буферизация: не корректировать, пока плеер стоит.
      if (!wasBusy && (m.seeking || m.waiting)) controller.hold(now(), 500);
      return;
    }
    case 'prepared':
      if (playback && m.rev === playback.rev && playback.status === 'waiting') {
        appliedRev = m.rev;
        sendPresence();
      }
      return;
    case 'tb:pong': {
      const t3 = now();
      // main = worker + offset; t1 снят главным потоком один раз, t2 = t1.
      mainClock.add(m.t0, m.t1, m.t1, t3);
      if (pendingState && calibrated()) {
        const s = pendingState;
        pendingState = null;
        applyState(s, true);
      }
      return;
    }
    case 'visibility':
      hidden = m.hidden;
      if (!hidden) {
        // Возврат из фона: Chrome заново включает видеодорожку внутренней
        // перемоткой (до ~0.5 с), часы могли уплыть — пересинхронизируемся.
        controller.hold(now(), 1000);
        serverPings = 0;
        mainPings = 0;
        schedulePing();
        scheduleMainPing();
      }
      return;
  }
};

// Сырая разница time origin — для отчёта: показывает, почему нужен мост.
export function setRawOriginGap(mainOrigin: number): void {
  rawOriginGapMs = performance.timeOrigin - mainOrigin;
}
self.addEventListener('message', (ev: MessageEvent) => {
  if (ev.data?.type === 'origin') setRawOriginGap(ev.data.mainOrigin as number);
});
