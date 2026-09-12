import type { MediaTrack } from '../../shared/tracks';

export interface InputInventory {
  tracks: MediaTrack[];
  video?: { codec: string; profile?: string };
  format?: string;
  duration?: number;
}
const TEXT_CODECS = new Set(['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text']);
const IMAGE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

/** Input headers only: output mapping and encoder descriptions must never become tracks. */
export function parseInputInventory(header: string): InputInventory {
  const input = header.slice(header.indexOf('Input #0,')).split(/(?:Output #|Stream mapping:|At least one output)/)[0];
  const inventory: InputInventory = { tracks: [], format: /^Input #0,\s*([^,]+)/m.exec(input)?.[1] };
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(input);
  if (duration) inventory.duration = +duration[1] * 3600 + +duration[2] * 60 + +duration[3];
  const blocks = input.split(/(?=^\s*Stream #0:)/m);
  for (const block of blocks) {
    const match = /^\s*Stream #0:(\d+)(?:\[[^\]]+\])?(?:\(([^)]+)\))?(?:\[[^\]]+\])?:\s*(Video|Audio|Subtitle):\s*([\w]+)(?:\s*\(([^)]*)\))?/m.exec(block);
    if (!match) continue;
    const [, index, language, kind, codec, profile] = match;
    if (kind === 'Video') { inventory.video ??= { codec, profile }; continue; }
    const title = /^\s+(?:title|handler_name)\s*:\s*(.+)$/mi.exec(block)?.[1]?.trim();
    const roles: string[] = [];
    if (/hearing impaired|\bSDH\b/i.test(block)) roles.push('SDH');
    if (/visual impaired|descriptions|audio description/i.test(block)) roles.push('Audio description');
    if (/commentary|comment\)/i.test(block)) roles.push('Commentary');
    const image = IMAGE_CODECS.has(codec);
    const supported = kind === 'Audio' || TEXT_CODECS.has(codec) || image;
    inventory.tracks.push({
      id: `stream:${index}`, index: +index, kind: kind === 'Audio' ? 'audio' : 'subtitle',
      language: language === 'und' ? undefined : language,
      label: title || (language && language !== 'und' ? language.toUpperCase() : `${kind === 'Audio' ? 'Audio' : 'Subtitles'} ${+index + 1}`),
      codec, profile, default: /\(default\)/.test(block), forced: /\(forced\)/.test(block), roles,
      supported, image, reason: supported ? undefined : `Unsupported subtitle format: ${codec}`,
    });
  }
  return inventory;
}

export function subtitleOutputArgs(track?: MediaTrack): string[] {
  return track?.kind === 'subtitle' && !track.image
    ? ['-map', `0:${track.index}`, '-c:s', 'webvtt', '-f', 'webvtt', '-flush_packets', '1', 'pipe:3'] : [];
}

/** Software frames can be uploaded by an encoder, but GPU-decode surfaces cannot enter overlay. */
export function imageSubtitleFilter(track: MediaTrack, delay: number): string {
  const offset = Math.max(-10, Math.min(10, Number.isFinite(delay) ? delay : 0));
  return `[0:${track.index}]setpts=PTS+${offset}/TB[sub];[0:v:0][sub]overlay=eof_action=pass:repeatlast=0[v]`;
}
