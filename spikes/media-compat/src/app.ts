/**
 * Прототип «Исправить звук»: проверка файла до входа в комнату и конвертация
 * звука прямо в браузере. Видео копируется без перекодирования, выбранная
 * звуковая дорожка — копируется или перекодируется в AAC, результат — MP4
 * в приватном хранилище браузера (OPFS). Файл не покидает компьютер.
 *
 * Библиотеки: Mediabunny (чтение MKV/MP4, конвертация) и его расширения
 * @mediabunny/ac3, @mediabunny/dts (wasm-декодеры), @mediabunny/aac-encoder
 * (wasm-кодировщик AAC для браузеров, где его нет в WebCodecs).
 */
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  canEncodeAudio,
  type InputAudioTrack,
  type InputTrack,
  type StreamTargetChunk,
} from 'mediabunny';
import { registerAc3Decoder } from '@mediabunny/ac3';
import { registerDtsDecoder } from '@mediabunny/dts';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import {
  audioPlayable,
  codecName,
  containerName,
  conversionPlan,
  detectBrowser,
  verdict,
  type AudioTrackInfo,
  type CanPlay,
  type Container,
  type FileInfo,
  type Verdict,
} from './verdict.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const browser = detectBrowser(navigator.userAgent);
const probe = document.createElement('video');
const canPlay: CanPlay = (type) => probe.canPlayType(type) !== '';
const MB = 1024 * 1024;

// ─── Окружение ──────────────────────────────────────────────────────

registerAc3Decoder();
registerDtsDecoder();
const env = {
  browser,
  userAgent: navigator.userAgent,
  webCodecsAudio: typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder !== 'undefined',
  nativeAacEncoder: false,
  opfs: typeof navigator.storage?.getDirectory === 'function',
  savePicker: typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function',
  quotaFreeMb: null as number | null,
};
const ready = (async () => {
  env.nativeAacEncoder = await canEncodeAudio('aac').catch(() => false);
  if (!env.nativeAacEncoder) registerAacEncoder();
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (est?.quota !== undefined) env.quotaFreeMb = Math.round((est.quota - (est.usage ?? 0)) / MB);
  renderEnv();
})();

function renderEnv(): void {
  const rows: Array<[string, string]> = [
    ['Браузер', `${browser} — ${navigator.userAgent}`],
    ['WebCodecs для звука', env.webCodecsAudio ? 'есть' : 'нет (декодеры и кодировщик будут wasm)'],
    ['Кодировщик AAC', env.nativeAacEncoder ? 'встроенный в браузер' : 'wasm (@mediabunny/aac-encoder)'],
    ['Хранилище OPFS', env.opfs ? `есть, свободно ≈ ${env.quotaFreeMb ?? '?'} МБ` : 'нет — конвертация невозможна'],
    ['Сохранение на диск', env.savePicker ? 'выбор файла (showSaveFilePicker)' : 'через скачивание'],
  ];
  $('env').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
}

// ─── Анализ файла ───────────────────────────────────────────────────

interface Analysis {
  file: File;
  info: FileInfo;
  formatName: string;
  fullMime: string;
  durationSec: number;
  videoCodec: string | null;
  firstVideoTs: number | null;
  tracks: InputAudioTrack[];
  /** Номера дорожек, которые можно исправить: есть декодер (в браузере или wasm) или копируется как есть. */
  fixable: Set<number>;
  verdict: Verdict;
}

function containerOf(formatName: string, mime: string): Container {
  if (mime.includes('matroska')) return 'mkv';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('quicktime') || /mp4|quicktime|mov/i.test(formatName)) return 'mp4';
  return 'other';
}

async function analyze(file: File): Promise<Analysis> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const format = await input.getFormat();
  const fullMime = await input.getMimeType();
  const mime = format.mimeType;
  const video = await input.getPrimaryVideoTrack();
  const tracks = await input.getAudioTracks();
  const audio: AudioTrackInfo[] = [];
  const fixable = new Set<number>();
  for (const t of tracks) {
    // AAC и Opus копируются без декодирования; остальное — если есть декодер (TrueHD — нет).
    if (t.codec === 'aac' || t.codec === 'opus' || (await t.canDecode().catch(() => false))) fixable.add(t.number);
    audio.push({
      number: t.number,
      codec: t.codec,
      codecString: t.codec ? await t.getCodecParameterString() : null,
      language: t.languageCode,
      channels: t.numberOfChannels,
      isDefault: t.disposition.default,
      name: t.name,
    });
  }
  const info: FileInfo = {
    container: containerOf(format.name, mime),
    mime,
    videoCodecString: video ? await video.getCodecParameterString() : null,
    audio,
  };
  return {
    file,
    info,
    formatName: format.name,
    fullMime,
    durationSec: await input.computeDuration(),
    videoCodec: video?.codec ?? null,
    firstVideoTs: video ? await video.getFirstTimestamp() : null,
    tracks,
    fixable,
    verdict: verdict(browser, info, canPlay),
  };
}

/** Окончательная проверка «откроется ли»: попросить браузер прочитать метаданные. */
function realOpenCheck(file: File, timeoutMs = 10_000): Promise<'opens' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    const url = URL.createObjectURL(file);
    const done = (r: 'opens' | 'error' | 'timeout'): void => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    v.onloadedmetadata = () => done('opens');
    v.onerror = () => done('error');
    v.src = url;
  });
}

/**
 * Проверка звука коротким проигрыванием.
 * Chrome сообщает число декодированных байт звука. Firefox — флаг mozHasAudio:
 * это «в файле есть звук, который браузер принял», а не счётчик, но на 13 роликах
 * команды он совпал с тем, что было слышно. Safari не сообщает ни того, ни другого:
 * там остаётся прогноз и проверка на слух.
 * muted = true — чтобы проигрывание не заблокировала политика автозапуска;
 * в Chromium звук при этом всё равно декодируется (проверено: счётчик растёт).
 * Если проигрывание не началось или не продвинулось (вкладка в фоне, запрет
 * автозапуска), ответ — «не удалось проверить»: ноль байт тогда ничего не значит.
 */
type SoundFact = 'есть' | 'нет' | 'не удалось проверить' | 'не сообщает браузер';

async function soundCheck(v: HTMLVideoElement, ms = 2500): Promise<SoundFact> {
  const wasMuted = v.muted;
  v.muted = true;
  const started = await v.play().then(
    () => true,
    () => false,
  );
  await new Promise((r) => setTimeout(r, ms));
  const advanced = v.currentTime > 0.5;
  v.pause();
  v.muted = wasMuted;
  if (!started || !advanced) return 'не удалось проверить';
  const x = v as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; mozHasAudio?: boolean };
  if (x.webkitAudioDecodedByteCount !== undefined) return x.webkitAudioDecodedByteCount > 0 ? 'есть' : 'нет';
  if (x.mozHasAudio !== undefined) return x.mozHasAudio ? 'есть' : 'нет';
  return 'не сообщает браузер';
}

async function soundCheckFile(file: File): Promise<SoundFact> {
  const v = document.createElement('video');
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    return await soundCheck(v);
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// ─── Запись в OPFS через воркер ─────────────────────────────────────

class OpfsWriter {
  private worker = new Worker(new URL('./writer.worker.js', import.meta.url));
  private waiters = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  constructor() {
    this.worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type: string; id?: number; size?: number; name?: string; message?: string };
      const key = m.type === 'written' ? (m.id as number) : m.type === 'error' ? (m.id ?? 'ctl') : 'ctl';
      const w = this.waiters.get(key);
      this.waiters.delete(key);
      if (!w) return;
      if (m.type === 'error') w.reject(Object.assign(new Error(m.message), { name: m.name ?? 'Error' }));
      else w.resolve(m.size);
    };
    // Упавший воркер не должен оставить конвертацию ждать ответа вечно.
    this.worker.onerror = (e) => this.failAll(new Error('Воркер записи упал: ' + (e.message || 'без описания')));
  }

  private failAll(err: Error): void {
    for (const w of this.waiters.values()) w.reject(err);
    this.waiters.clear();
  }

  private request(msg: object, key: string | number, transfer: Transferable[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.waiters.set(key, { resolve, reject });
      this.worker.postMessage(msg, transfer);
    });
  }

  open(name: string): Promise<unknown> {
    return this.request({ type: 'open', name }, 'ctl');
  }

  close(): Promise<number> {
    return this.request({ type: 'close' }, 'ctl') as Promise<number>;
  }

  writable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({
      write: (chunk) => {
        const id = this.nextId++;
        const data = chunk.data.slice(); // копия: исходный буфер Mediabunny может переиспользовать
        return this.request({ type: 'write', id, data, position: chunk.position }, id, [data.buffer]) as Promise<void>;
      },
    });
  }

  /** Закрыть файл, не дожидаясь дольше timeoutMs и не бросая ошибок: для пути отмены и сбоя. */
  async closeQuietly(timeoutMs = 2000): Promise<void> {
    await Promise.race([this.close(), new Promise((r) => setTimeout(r, timeoutMs))]).catch(() => {});
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new Error('воркер записи остановлен'));
  }
}

/** Удалить файл результата из OPFS, если он есть. Ошибки не важны: это уборка. */
async function removeOutput(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* файла нет или он ещё занят — не страшно */
  }
}

// ─── Конвертация ────────────────────────────────────────────────────

export interface ConvertOptions {
  trackNumber: number;
  channels: 'stereo' | 'keep';
  copyDolbyForSafari: boolean;
  fragmented: boolean;
  audioCodec: 'aac' | 'opus';
}

export interface ConvertStats {
  outputName: string;
  plan: string;
  ms: number;
  bytesIn: number;
  bytesOut: number;
  durationSec: number;
  speedX: number;
  mbPerSec: number;
  firstVideoTs: { source: number | null; output: number | null };
  outputDurationSec: number;
  sound: string;
}

let current: Analysis | null = null;
let running: Conversion | null = null;

async function convert(
  a: Analysis,
  opts: ConvertOptions,
  onProgress: (p: number, t: number) => void,
  onSlow?: () => void,
): Promise<ConvertStats> {
  await ready;
  const chosenInfo = a.info.audio.find((t) => t.number === opts.trackNumber);
  if (!chosenInfo) throw new Error('дорожка не выбрана');
  if (!a.videoCodec || !['avc', 'hevc', 'vp9', 'av1'].includes(a.videoCodec)) {
    throw new Error(`Видео ${a.videoCodec ?? 'неизвестного формата'} нельзя скопировать в MP4 без перекодирования — прототип такое не делает.`);
  }
  const plan = conversionPlan(browser, chosenInfo, opts);
  const outputName = a.file.name.replace(/\.[^.]+$/, '') + '.fixed.mp4';

  const writer = new OpfsWriter();
  let finished = false;
  try {
    await writer.open(outputName);
    const input = new Input({ source: new BlobSource(a.file), formats: ALL_FORMATS });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: opts.fragmented ? 'fragmented' : false }),
      target: new StreamTarget(writer.writable(), { chunked: true, chunkSize: 16 * MB }),
    });
    const primaryVideo = await input.getPrimaryVideoTrack();
    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      // Начало шкалы сохраняется: время кадров результата совпадает с исходником
      // (проверяется ниже по первому кадру).
      trim: { start: 0 },
      video: (track) => (track.id === primaryVideo?.id ? {} : { discard: true }),
      audio: (track) => {
        if (track.number !== opts.trackNumber) return { discard: true };
        if (plan.audio === 'copy') return {};
        return { codec: plan.audio, numberOfChannels: plan.numberOfChannels, quality: QUALITY_HIGH, forceTranscode: true };
      },
    });
    // Mediabunny считает конвертацию «допустимой», даже если выбранную дорожку
    // пришлось выбросить (например, TrueHD), — тогда получился бы немой файл.
    const used = conversion.utilizedTracks;
    const reason = (pick: (t: InputTrack) => boolean): string =>
      conversion.discardedTracks.find((d) => pick(d.track))?.reason ?? 'причина неизвестна';
    if (!used.some((t) => t.isVideoTrack())) {
      throw new Error(`Видео не попадёт в результат (${reason((t) => t.isVideoTrack())}).`);
    }
    const isChosen = (t: InputTrack): boolean => t.isAudioTrack() && t.number === opts.trackNumber;
    if (!used.some(isChosen)) {
      throw new Error(
        `Дорожку ${opts.trackNumber} не получится ни скопировать, ни перекодировать (${reason(isChosen)}). ` +
          'Выберите другую — в таблице отмечено, какие можно исправить.',
      );
    }
    if (!conversion.isValid) {
      throw new Error('Конвертация невозможна: ' + conversion.discardedTracks.map((d) => `дорожка ${d.track.number}: ${d.reason}`).join('; '));
    }
    const t0 = performance.now();
    let slowWarned = false;
    conversion.onProgress = (p, t) => {
      onProgress(p, t);
      // Видео должно копироваться, это быстро. Если скорость ниже 2× реального
      // времени, скорее всего видео перекодируется — фильм займёт часы. Говорим об этом.
      const sec = (performance.now() - t0) / 1000;
      if (!slowWarned && sec > 20 && t / sec < 2) {
        slowWarned = true;
        onSlow?.();
      }
    };
    running = conversion;
    await conversion.execute();
    const bytesOut = await writer.close();
    finished = true;
    const ms = performance.now() - t0;

    const root = await navigator.storage.getDirectory();
    const outFile = await (await root.getFileHandle(outputName)).getFile();
    const outInput = new Input({ source: new BlobSource(outFile), formats: ALL_FORMATS });
    const outVideo = await outInput.getPrimaryVideoTrack();

    return {
      outputName,
      plan: plan.explanation,
      ms: Math.round(ms),
      bytesIn: a.file.size,
      bytesOut,
      durationSec: a.durationSec,
      speedX: Math.round((a.durationSec / (ms / 1000)) * 10) / 10,
      mbPerSec: Math.round((a.file.size / MB / (ms / 1000)) * 10) / 10,
      firstVideoTs: { source: a.firstVideoTs, output: outVideo ? await outVideo.getFirstTimestamp() : null },
      outputDurationSec: await outInput.computeDuration(),
      sound: '',
    };
  } finally {
    // При отмене или сбое: закрыть файл (снять блокировку OPFS), остановить воркер
    // и удалить недописанный результат, чтобы повторная попытка начиналась с чистого листа.
    running = null;
    if (!finished) await writer.closeQuietly();
    writer.terminate();
    if (!finished) await removeOutput(outputName);
  }
}

async function openResult(name: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  return (await root.getFileHandle(name)).getFile();
}

// ─── Интерфейс ──────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function renderAnalysis(a: Analysis, real: 'opens' | 'error' | 'timeout', fact: SoundFact | null): void {
  const v = a.verdict;
  // Проверки на деле главнее прогноза: прогноз — только первый фильтр.
  let level = v.level;
  let headline = v.level === 'ok' ? 'Всё в порядке' : v.level === 'warn' ? 'Есть оговорки' : v.opens ? 'Звука не будет' : 'Файл не откроется';
  const extra: string[] = [];
  if (real !== 'opens') {
    level = 'bad';
    headline = 'Файл не откроется';
  } else {
    if (!v.opens) {
      level = 'warn';
      headline = 'Файл открывается';
      extra.push('Браузер не признаётся заранее, что умеет этот файл, но файл открылся. Прогноз по дорожкам здесь ненадёжен.');
    }
    if (fact === 'нет') {
      level = 'bad';
      headline = 'Звука не будет';
      if (v.playing) extra.push('Прогноз обещал звук, но проверка воспроизведением его не нашла — верим проверке.');
    } else if (fact === 'есть' && (!v.opens || !v.playing)) {
      level = 'warn';
      headline = 'Звук есть';
      extra.push('Проверка воспроизведением нашла звук, хотя прогноз его не обещал.');
    } else if (fact === 'не удалось проверить') {
      extra.push('Проверить звук проигрыванием не удалось (браузер не начал воспроизведение, например вкладка в фоне) — остаётся прогноз.');
    }
  }
  const cls = level === 'ok' ? 'ok' : level === 'warn' ? 'warn' : 'bad';
  const realText = real === 'opens' ? 'открывается' : real === 'error' ? 'не открывается' : 'не дождался ответа за 10 с';
  $('verdict').className = 'verdict ' + cls;
  $('verdict').innerHTML =
    `<b>${headline}</b>` +
    `<ul>${[...v.notes, ...extra].map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
    `<p class="muted">Прогноз — по ответам браузера и замерам команды. Проверка открытием: ${realText}. ` +
    `Проверка звука коротким проигрыванием: ${fact ?? 'не проводилась'}.</p>`;
  $('fileinfo').textContent =
    `${a.file.name} · ${(a.file.size / MB).toFixed(0)} МБ · ${containerName(a.info.container)} · ${fmtTime(a.durationSec)} · ${a.fullMime}`;
  const playing = v.playing?.number;
  // По умолчанию — дорожка, которую браузер и так сыграет, иначе первая, которую можно исправить.
  const preferred = playing ?? a.info.audio.find((t) => a.fixable.has(t.number))?.number ?? a.info.audio[0]?.number;
  $('tracks').innerHTML =
    '<tr><th></th><th>№</th><th>Кодек</th><th>Язык</th><th>Каналы</th><th>Название</th><th>Этот браузер сыграет</th><th>Можно исправить</th></tr>' +
    a.info.audio
      .map((t) => {
        const ok = audioPlayable(browser, a.info, t, canPlay);
        return `<tr><td><input type="radio" name="track" value="${t.number}" ${t.number === preferred ? 'checked' : ''}></td>
          <td>${t.number}${t.isDefault ? ' ★' : ''}${t.number === playing ? ' ▶' : ''}</td><td>${esc(codecName(t.codec))}</td>
          <td>${esc(t.language)}</td><td>${t.channels}</td><td>${esc(t.name ?? '')}</td>
          <td class="${ok ? 'ok' : 'bad'}">${ok ? 'да' : 'нет'}</td>
          <td class="${a.fixable.has(t.number) ? 'ok' : 'bad'}">${a.fixable.has(t.number) ? 'да' : 'нет'}</td></tr>`;
      })
      .join('');
  $('fix').hidden = false;
  $('copyDolbyRow').hidden = browser !== 'safari';
}

$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  $('verdict').className = 'verdict';
  $('verdict').dataset.done = '';
  $('verdict').textContent = 'Читаю заголовок файла…';
  $('fix').hidden = true;
  $('result').hidden = true;
  try {
    const a = await analyze(f);
    current = a;
    const real = await realOpenCheck(f);
    renderAnalysis(a, real, null);
    if (real === 'opens' && a.info.audio.length > 0) renderAnalysis(a, real, await soundCheckFile(f));
    $('verdict').dataset.done = '1';
  } catch (err) {
    $('verdict').className = 'verdict bad';
    $('verdict').textContent = 'Не удалось прочитать файл: ' + (err as Error).message;
    $('verdict').dataset.done = '1';
  }
});

function readOptions(): ConvertOptions {
  const sel = document.querySelector<HTMLInputElement>('input[name="track"]:checked');
  return {
    trackNumber: Number(sel?.value ?? 1),
    channels: ($<HTMLInputElement>('stereo').checked ? 'stereo' : 'keep'),
    copyDolbyForSafari: $<HTMLInputElement>('copyDolby').checked,
    fragmented: $<HTMLInputElement>('fragmented').checked,
    audioCodec: $<HTMLSelectElement>('codec').value === 'opus' ? 'opus' : 'aac',
  };
}

/** Последний результат: имя файла в OPFS и адрес, по которому его показывает плеер. */
let last: { name: string; url: string } | null = null;

/** Отпустить плеер результата и адрес файла (иначе каждый результат держит память и блокирует удаление). */
function releaseResultPlayer(): void {
  const v = $<HTMLVideoElement>('out');
  v.removeAttribute('src');
  v.load();
  if (last) URL.revokeObjectURL(last.url);
}

async function runConvert(opts: ConvertOptions): Promise<ConvertStats> {
  if (!current) throw new Error('сначала выберите файл');
  const a = current;
  $('run').setAttribute('disabled', '');
  $('cancel').hidden = false;
  $('progress').hidden = false;
  releaseResultPlayer();
  const t0 = performance.now();
  let slow = false;
  try {
    const stats = await convert(
      a,
      opts,
      (p, t) => {
        const sec = (performance.now() - t0) / 1000;
        const speed = t / Math.max(sec, 0.001);
        const eta = speed > 0 ? (a.durationSec - t) / speed : 0;
        ($('bar') as HTMLProgressElement).value = p;
        $('ptext').textContent =
          `${(p * 100).toFixed(1)} % · обработано ${fmtTime(t)} из ${fmtTime(a.durationSec)} · ${speed.toFixed(1)}× реального времени · осталось ≈ ${fmtTime(eta)}` +
          (slow ? ' · ВНИМАНИЕ: слишком медленно — похоже, видео перекодируется; такой фильм займёт часы, лучше отменить' : '');
      },
      () => {
        slow = true;
      },
    );
    const out = await openResult(stats.outputName);
    const v = $<HTMLVideoElement>('out');
    last = { name: stats.outputName, url: URL.createObjectURL(out) };
    v.src = last.url;
    const loaded = await new Promise<'ok' | 'error' | 'timeout'>((r) => {
      const timer = setTimeout(() => r('timeout'), 15_000);
      v.onloadedmetadata = () => (clearTimeout(timer), r('ok'));
      v.onerror = () => (clearTimeout(timer), r('error'));
    });
    stats.sound = loaded === 'ok' ? await soundCheck(v) : `результат не открылся в этом браузере (${loaded === 'error' ? v.error?.message || 'ошибка' : 'нет ответа'})`;
    renderStats(stats);
    return stats;
  } finally {
    $('run').removeAttribute('disabled');
    $('cancel').hidden = true;
  }
}

function renderStats(s: ConvertStats): void {
  $('result').hidden = false;
  const rows: Array<[string, string]> = [
    ['Что сделано', s.plan],
    ['Время', `${(s.ms / 1000).toFixed(1)} с — ${s.speedX}× реального времени, ${s.mbPerSec} МБ/с исходного файла`],
    ['Размер', `${(s.bytesIn / MB).toFixed(0)} МБ → ${(s.bytesOut / MB).toFixed(0)} МБ`],
    ['Длительность', `${fmtTime(s.durationSec)} → ${fmtTime(s.outputDurationSec)}`],
    ['Первый кадр (с)', `исходник ${s.firstVideoTs.source} → результат ${s.firstVideoTs.output} ${s.firstVideoTs.source === s.firstVideoTs.output ? '— совпадает' : '— РАСХОДИТСЯ'}`],
    ['Звук в результате', s.sound],
    ['Файл в хранилище браузера', s.outputName],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
}

$('run').addEventListener('click', () => {
  runConvert(readOptions()).catch((err: Error) => {
    if (err instanceof ConversionCanceledError) $('ptext').textContent = 'Отменено. Недописанный файл удалён.';
    else $('ptext').textContent = (err.name === 'QuotaExceededError' ? 'Не хватило места в хранилище браузера. ' : 'Ошибка: ') + err.message;
  });
});
$('cancel').addEventListener('click', () => void running?.cancel());

$('save').addEventListener('click', async () => {
  if (!last) return;
  const name = last.name;
  try {
    const file = await openResult(name);
    const w = window as unknown as { showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
    if (w.showSaveFilePicker) {
      const h = await w.showSaveFilePicker({ suggestedName: name });
      const writable = await (h as unknown as { createWritable(): Promise<WritableStream> }).createWritable();
      await file.stream().pipeTo(writable);
    } else {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = name;
      link.click();
      // Адрес нужен только на время начала скачивания.
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    }
  } catch (err) {
    // Пользователь закрыл окно выбора файла — это не ошибка.
    if ((err as Error).name !== 'AbortError') $('ptext').textContent = 'Не удалось сохранить: ' + (err as Error).message;
  }
});

$('remove').addEventListener('click', async () => {
  if (!last) return;
  // Удаляем только наш результат: в продукте в том же хранилище будут и другие файлы.
  const name = last.name;
  releaseResultPlayer();
  last = null;
  await removeOutput(name);
  $('result').hidden = true;
  await ready;
  const est = await navigator.storage.estimate();
  env.quotaFreeMb = Math.round(((est.quota ?? 0) - (est.usage ?? 0)) / MB);
  renderEnv();
});

// Для автоматического замера (tools/bench.mjs).
Object.assign(window, {
  __spike: {
    ready,
    env,
    async analyzeFile(f: File) {
      current = await analyze(f);
      return { info: current.info, verdict: current.verdict, durationSec: current.durationSec };
    },
    convert: (o: ConvertOptions) => runConvert(o),
  },
});
