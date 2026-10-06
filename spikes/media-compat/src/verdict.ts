/**
 * Прогноз: откроется ли файл в этом браузере и будет ли звук.
 *
 * Чистый модуль: не знает про DOM и Mediabunny. На вход — описание файла
 * (контейнер, дорожки) и функция «спросить браузер» (обёртка над canPlayType),
 * на выход — вердикт с объяснением. Поэтому всё здесь проверяется
 * unit-тестами без браузера.
 *
 * Правила взяты из замеров команды (Chrome 154 и Firefox 157 на Windows,
 * Safari 18.6 на Intel Mac, 13 тестовых роликов) и из исходников Chromium;
 * подробности — docs/spikes/media-compat.md.
 */

export type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';
export type Container = 'mkv' | 'mp4' | 'webm' | 'other';

export interface AudioTrackInfo {
  /** Номер среди звуковых дорожек файла, с 1 (так их нумерует Mediabunny: track.number). */
  number: number;
  /** Кодек по классификации Mediabunny: 'aac', 'ac3', 'eac3', 'dts', 'flac', 'opus'… или null, если не распознан (например, TrueHD). */
  codec: string | null;
  /** Строка кодека для canPlayType: 'mp4a.40.2', 'ac-3', 'ec-3', 'flac', 'opus'… */
  codecString: string | null;
  language: string;
  channels: number;
  /** В MP4 — флаг «включена» дорожки; в MKV — флаг «по умолчанию». */
  isDefault: boolean;
  name: string | null;
}

export interface FileInfo {
  container: Container;
  /** MIME контейнера: 'video/x-matroska', 'video/mp4', 'video/webm'. */
  mime: string;
  videoCodecString: string | null;
  audio: AudioTrackInfo[];
}

/** Ответ браузера на вопрос «смогу ли сыграть такой тип». true — «maybe» или «probably». */
export type CanPlay = (type: string) => boolean;

export type Level = 'ok' | 'warn' | 'bad';

export interface Verdict {
  level: Level;
  /** Откроется ли контейнер с этим видео. */
  opens: boolean;
  /** Дорожка, которую браузер будет играть со звуком, или null. */
  playing: AudioTrackInfo | null;
  /** Пояснения для пользователя, по-русски. */
  notes: string[];
  /** Нужна ли конвертация, чтобы был звук (или чтобы файл вообще открылся). */
  needsFix: boolean;
}

export function detectBrowser(userAgent: string): Browser {
  const ua = userAgent.toLowerCase();
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('firefox/')) return 'firefox';
  if (ua.includes('chrome/') || ua.includes('chromium/') || ua.includes('crios/')) return 'chrome';
  if (ua.includes('safari/')) return 'safari';
  return 'other';
}

export const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  ac3: 'AC-3 (Dolby Digital)',
  eac3: 'E-AC-3 (Dolby Digital Plus)',
  dts: 'DTS',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
};

export function codecName(codec: string | null): string {
  if (codec === null) return 'не распознан (например, TrueHD)';
  if (codec.startsWith('pcm')) return 'PCM';
  return CODEC_NAMES[codec] ?? codec;
}

export function containerName(c: Container): string {
  return c === 'mkv' ? 'MKV' : c === 'mp4' ? 'MP4' : c === 'webm' ? 'WebM' : 'неизвестный контейнер';
}

const BROWSER_NAMES: Record<Browser, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  safari: 'Safari',
  other: 'этот браузер',
};

/**
 * Поправки к ответам браузера там, где замер показал, что canPlayType ошибается.
 * Safari 18.6: про FLAC в MP4 отвечает «да», а звука нет; про Opus в MP4 — «нет», а звук есть.
 */
const OVERRIDES: ReadonlyArray<{ browser: Browser; container: Container; codec: string; sound: boolean }> = [
  { browser: 'safari', container: 'mp4', codec: 'flac', sound: false },
  { browser: 'safari', container: 'mp4', codec: 'opus', sound: true },
];

/** Сыграет ли браузер звук этой дорожки внутри этого контейнера. */
export function audioPlayable(browser: Browser, info: FileInfo, track: AudioTrackInfo, canPlay: CanPlay): boolean {
  const o = OVERRIDES.find((x) => x.browser === browser && x.container === info.container && x.codec === track.codec);
  if (o) return o.sound;
  if (track.codec === null || track.codecString === null) return false;
  return canPlay(`${info.mime}; codecs="${track.codecString}"`);
}

/** Откроет ли браузер контейнер с этим видео. Окончательно это проверяется загрузкой метаданных. */
export function containerOpens(browser: Browser, info: FileInfo, canPlay: CanPlay): boolean {
  // Safari не открывает MKV ни с какими кодеками, хотя прямого заявления Apple нет.
  if (browser === 'safari' && info.container === 'mkv') return false;
  if (info.videoCodecString) return canPlay(`${info.mime}; codecs="${info.videoCodecString}"`);
  return canPlay(info.mime);
}

/**
 * Какую дорожку браузер выберет сам.
 *
 * - MP4 в Chrome/Edge/Safari: только «включённая» дорожка (флаг enabled в tkhd).
 *   ffmpeg включает лишь первую звуковую дорожку, поэтому MP4 «AC-3 + AAC»
 *   в Chrome молчит: AC-3 он не умеет, а AAC выключена.
 * - MKV в Chrome/Firefox и MP4 в Firefox: первая дорожка, которую браузер умеет.
 */
export function pickTrack(
  browser: Browser,
  info: FileInfo,
  playable: (t: AudioTrackInfo) => boolean,
): AudioTrackInfo | null {
  const tracks = info.audio;
  if (tracks.length === 0) return null;
  const enabledOnly = info.container === 'mp4' && (browser === 'chrome' || browser === 'edge' || browser === 'safari');
  if (enabledOnly) {
    const enabled = tracks.filter((t) => t.isDefault);
    const candidates = enabled.length > 0 ? enabled : [tracks[0]];
    return candidates.find(playable) ?? null;
  }
  return tracks.find(playable) ?? null;
}

function trackLabel(t: AudioTrackInfo): string {
  const lang = t.language && t.language !== 'und' ? t.language : 'язык не указан';
  return `№${t.number} (${lang}, ${codecName(t.codec)}${t.name ? `, «${t.name}»` : ''})`;
}

export function verdict(browser: Browser, info: FileInfo, canPlay: CanPlay): Verdict {
  const b = BROWSER_NAMES[browser];
  const notes: string[] = [];

  if (!containerOpens(browser, info, canPlay)) {
    notes.push(
      browser === 'safari' && info.container === 'mkv'
        ? 'Safari не открывает MKV. Нужна конвертация в MP4 (видео копируется без потерь) — или откройте файл в Chrome или Firefox.'
        : `${b} не умеет воспроизводить такое видео (${containerName(info.container)}, ${info.videoCodecString ?? 'кодек неизвестен'}).`,
    );
    return { level: 'bad', opens: false, playing: null, notes, needsFix: true };
  }

  if (info.audio.length === 0) {
    notes.push('В файле нет звуковых дорожек.');
    return { level: 'warn', opens: true, playing: null, notes, needsFix: false };
  }

  const playable = (t: AudioTrackInfo): boolean => audioPlayable(browser, info, t, canPlay);
  const playing = pickTrack(browser, info, playable);
  const unplayable = info.audio.filter((t) => !playable(t));

  if (playing === null) {
    const codecs = [...new Set(info.audio.map((t) => codecName(t.codec)))].join(', ');
    if (info.audio.some(playable)) {
      notes.push(
        `${b} в MP4 играет только включённую дорожку, а её звук (${codecName(info.audio.find((t) => t.isDefault)?.codec ?? null)}) он не декодирует. Будет картинка без звука, хотя в файле есть подходящая дорожка.`,
      );
    } else {
      notes.push(`Звук этого файла (${codecs}) ${b} не воспроизводит. Будет картинка без звука, и браузер не покажет ошибку.`);
    }
    notes.push('Кнопка «Исправить звук» перекодирует только звук в AAC; видео копируется без потерь.');
    return { level: 'bad', opens: true, playing: null, notes, needsFix: true };
  }

  notes.push(`Будет играть дорожка ${trackLabel(playing)}.`);
  let level: Level = 'ok';
  if (unplayable.length > 0) {
    level = 'warn';
    notes.push(
      `Эти дорожки ${b} не воспроизводит: ${unplayable.map(trackLabel).join(', ')}. Если нужна одна из них, используйте «Исправить звук» и выберите её.`,
    );
  } else if (info.audio.length > 1 && playing !== info.audio[0]) {
    level = 'warn';
  }
  if (info.audio.length > 1) {
    notes.push('Сменить дорожку во время просмотра браузер не даёт; выбрать другую можно только конвертацией.');
  }
  return { level, opens: true, playing, notes, needsFix: false };
}

export interface ConversionPlan {
  /** 'copy' — переложить без перекодирования; иначе — в какой кодек перекодировать. */
  audio: 'copy' | 'aac' | 'opus';
  numberOfChannels: number | undefined;
  explanation: string;
}

/**
 * Что делать со звуком при конвертации выбранной дорожки в MP4.
 * AAC в MP4 звучал во всех трёх браузерах, и браузеры прямо обещают его поддержку,
 * поэтому по умолчанию всё остальное перекодируется в AAC. Opus в MP4 тоже звучал
 * везде, но Safari на вопрос о нём отвечает «нет» — это запасной вариант.
 */
export function conversionPlan(
  browser: Browser,
  track: AudioTrackInfo,
  opts: { channels: 'stereo' | 'keep'; copyDolbyForSafari: boolean; audioCodec?: 'aac' | 'opus' },
): ConversionPlan {
  const target = opts.audioCodec ?? 'aac';
  const numberOfChannels = opts.channels === 'stereo' ? Math.min(2, track.channels || 2) : undefined;
  if (track.codec === target) {
    return { audio: 'copy', numberOfChannels: undefined, explanation: `Звук уже в ${codecName(target)} — дорожка копируется без перекодирования.` };
  }
  if (browser === 'safari' && opts.copyDolbyForSafari && (track.codec === 'ac3' || track.codec === 'eac3')) {
    return {
      audio: 'copy',
      numberOfChannels: undefined,
      explanation: 'Safari сам играет Dolby в MP4 — дорожка копируется без перекодирования. Такой файл будет без звука в Chrome и Firefox.',
    };
  }
  return {
    audio: target,
    numberOfChannels,
    explanation: `Звук ${codecName(track.codec)} перекодируется в ${codecName(target)}${numberOfChannels === 2 ? ' (стерео)' : ''}; видео копируется без изменений.`,
  };
}
