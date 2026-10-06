/**
 * Прогноз сверяется с тем, что команда услышала на самом деле: 13 роликов × 3 браузера.
 * Ответы canPlayType подставлены те, что браузеры дали в check.html (results/).
 * Если правило в verdict.ts сломается, эти тесты покажут, на каком файле.
 *
 * Запуск: npm test   (Node 22.18+ сам снимает типы)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversionPlan, detectBrowser, verdict, type AudioTrackInfo, type CanPlay, type FileInfo } from '../src/verdict.ts';

// ─── Ответы canPlayType из отчётов check.html ───────────────────────
type Family = 'h264' | 'hevc' | 'vp9' | 'av1' | 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'ac3' | 'eac3' | 'dts' | 'truehd';
const ALL: Family[] = ['h264', 'hevc', 'vp9', 'av1', 'aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3', 'dts', 'truehd'];
const except = (...no: Family[]): Set<Family> => new Set(ALL.filter((f) => !no.includes(f)));

const SAYS: Record<'chrome' | 'firefox' | 'safari', { mkv: Set<Family>; mp4: Set<Family> }> = {
  // Chrome 154, Windows
  chrome: { mkv: except('ac3', 'eac3', 'dts', 'truehd'), mp4: except('vorbis', 'ac3', 'eac3', 'dts', 'truehd') },
  // Firefox 157, Windows
  firefox: { mkv: except('mp3', 'flac', 'ac3', 'eac3', 'dts', 'truehd'), mp4: except('mp3', 'vorbis', 'ac3', 'eac3', 'dts', 'truehd') },
  // Safari 18.6, Intel Mac: MKV — «нет» на всё
  safari: { mkv: new Set(), mp4: new Set<Family>(['h264', 'hevc', 'vp9', 'aac', 'flac', 'ac3', 'eac3']) },
};

function family(codec: string): Family {
  if (codec.startsWith('avc1')) return 'h264';
  if (codec.startsWith('hev1') || codec.startsWith('hvc1')) return 'hevc';
  if (codec.startsWith('vp09')) return 'vp9';
  if (codec.startsWith('av01')) return 'av1';
  if (codec === 'mp4a.40.2') return 'aac';
  if (codec === 'ac-3') return 'ac3';
  if (codec === 'ec-3') return 'eac3';
  if (codec === 'dtsc') return 'dts';
  if (codec === 'mlpa') return 'truehd';
  return codec as Family;
}

function fakeCanPlay(b: 'chrome' | 'firefox' | 'safari'): CanPlay {
  return (type: string) => {
    const [mime, rest] = type.split(';');
    const box = mime.trim() === 'video/x-matroska' ? 'mkv' : mime.trim() === 'video/mp4' ? 'mp4' : null;
    if (!box) return false;
    if (!rest) return box === 'mp4' || b !== 'safari'; // «может быть» на голый контейнер
    const codecs = rest.replace(/.*codecs="([^"]*)".*/, '$1').split(',').map((c) => c.trim());
    return codecs.every((c) => SAYS[b][box].has(family(c)));
  };
}

// ─── Файлы, как их описывает Mediabunny ─────────────────────────────
const t = (number: number, codec: string, codecString: string, isDefault: boolean, language = 'und'): AudioTrackInfo => ({
  number, codec, codecString, language, channels: codec === 'aac' || codec === 'flac' || codec === 'opus' ? 2 : 6, isDefault, name: null,
});
const mkv = (video: string, ...audio: AudioTrackInfo[]): FileInfo => ({ container: 'mkv', mime: 'video/x-matroska', videoCodecString: video, audio });
const mp4 = (...audio: AudioTrackInfo[]): FileInfo => ({ container: 'mp4', mime: 'video/mp4', videoCodecString: 'avc1.64001e', audio });
const H264 = 'avc1.64001e';

const FILES: Record<string, FileInfo> = {
  '01 MKV AAC': mkv(H264, t(1, 'aac', 'mp4a.40.2', false)),
  '02 MKV AC-3': mkv(H264, t(1, 'ac3', 'ac-3', false)),
  '03 MKV E-AC-3': mkv(H264, t(1, 'eac3', 'ec-3', false)),
  '04 MKV DTS': mkv(H264, t(1, 'dts', 'dtsc', false)),
  '05 MKV AC-3+AAC': mkv(H264, t(1, 'ac3', 'ac-3', true, 'rus'), t(2, 'aac', 'mp4a.40.2', false, 'eng')),
  '06 MKV FLAC': mkv(H264, t(1, 'flac', 'flac', false)),
  '07 MKV HEVC AAC': mkv('hev1.1.6.L63.90', t(1, 'aac', 'mp4a.40.2', false)),
  '08 MP4 AAC': mp4(t(1, 'aac', 'mp4a.40.2', true)),
  '09 MP4 AC-3': mp4(t(1, 'ac3', 'ac-3', true)),
  '10 MP4 E-AC-3': mp4(t(1, 'eac3', 'ec-3', true)),
  '11 MP4 FLAC': mp4(t(1, 'flac', 'flac', true)),
  '12 MP4 Opus': mp4(t(1, 'opus', 'opus', true)),
  '13 MP4 AC-3+AAC': mp4(t(1, 'ac3', 'ac-3', true, 'rus'), t(2, 'aac', 'mp4a.40.2', false, 'eng')),
};

// ─── Что было на самом деле. 'none' — не открылся; число — номер звучащей дорожки; 0 — без звука ───
type Fact = 'none' | number;
const FACTS: Record<'chrome' | 'firefox' | 'safari', Record<string, Fact>> = {
  chrome: {
    '01 MKV AAC': 1, '02 MKV AC-3': 0, '03 MKV E-AC-3': 0, '04 MKV DTS': 0, '05 MKV AC-3+AAC': 2, '06 MKV FLAC': 1, '07 MKV HEVC AAC': 1,
    '08 MP4 AAC': 1, '09 MP4 AC-3': 0, '10 MP4 E-AC-3': 0, '11 MP4 FLAC': 1, '12 MP4 Opus': 1, '13 MP4 AC-3+AAC': 0,
  },
  firefox: {
    '01 MKV AAC': 1, '02 MKV AC-3': 0, '03 MKV E-AC-3': 0, '04 MKV DTS': 0, '05 MKV AC-3+AAC': 2, '06 MKV FLAC': 0, '07 MKV HEVC AAC': 1,
    '08 MP4 AAC': 1, '09 MP4 AC-3': 0, '10 MP4 E-AC-3': 0, '11 MP4 FLAC': 1, '12 MP4 Opus': 1, '13 MP4 AC-3+AAC': 2,
  },
  safari: {
    '01 MKV AAC': 'none', '02 MKV AC-3': 'none', '03 MKV E-AC-3': 'none', '04 MKV DTS': 'none', '05 MKV AC-3+AAC': 'none', '06 MKV FLAC': 'none', '07 MKV HEVC AAC': 'none',
    // 13: Safari со звуком; какая дорожка — не видно на слух (обе пищат одинаково). Включённая — AC-3, её Safari умеет.
    '08 MP4 AAC': 1, '09 MP4 AC-3': 1, '10 MP4 E-AC-3': 1, '11 MP4 FLAC': 0, '12 MP4 Opus': 1, '13 MP4 AC-3+AAC': 1,
  },
};

for (const b of ['chrome', 'firefox', 'safari'] as const) {
  for (const [name, info] of Object.entries(FILES)) {
    test(`${b}: ${name}`, () => {
      const v = verdict(b, info, fakeCanPlay(b));
      const fact = FACTS[b][name];
      if (fact === 'none') {
        assert.equal(v.opens, false, 'должен предсказать «не откроется»');
        return;
      }
      assert.equal(v.opens, true, 'должен предсказать «откроется»');
      assert.equal(v.playing?.number ?? 0, fact, 'звучащая дорожка');
      assert.equal(v.needsFix, fact === 0);
    });
  }
}

test('определение браузера по User-Agent', () => {
  assert.equal(detectBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'), 'chrome');
  assert.equal(detectBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0'), 'firefox');
  assert.equal(detectBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'), 'safari');
  assert.equal(detectBrowser('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'), 'edge');
});

test('план конвертации: AAC копируется, остальное — в AAC, Dolby в Safari можно копировать', () => {
  const ac3 = t(1, 'ac3', 'ac-3', true);
  assert.equal(conversionPlan('chrome', t(1, 'aac', 'mp4a.40.2', true), { channels: 'stereo', copyDolbyForSafari: true }).audio, 'copy');
  assert.equal(conversionPlan('chrome', ac3, { channels: 'stereo', copyDolbyForSafari: true }).audio, 'aac');
  assert.equal(conversionPlan('chrome', ac3, { channels: 'stereo', copyDolbyForSafari: true }).numberOfChannels, 2);
  assert.equal(conversionPlan('chrome', ac3, { channels: 'keep', copyDolbyForSafari: true }).numberOfChannels, undefined);
  assert.equal(conversionPlan('safari', ac3, { channels: 'stereo', copyDolbyForSafari: true }).audio, 'copy');
  assert.equal(conversionPlan('safari', ac3, { channels: 'stereo', copyDolbyForSafari: false }).audio, 'aac');
  assert.equal(conversionPlan('safari', t(1, 'dts', 'dtsc', true), { channels: 'stereo', copyDolbyForSafari: true }).audio, 'aac');
});
