export interface MediaTrack {
  id: string;
  kind: 'audio' | 'subtitle';
  index?: number;
  language?: string;
  label: string;
  codec?: string;
  profile?: string;
  default: boolean;
  forced: boolean;
  roles: string[];
  supported: boolean;
  reason?: string;
  image?: boolean;
}

export interface CaptionAppearance { size: number; color: 'white' | 'yellow'; background: number }
export interface PlaybackPreferences {
  audioLanguage: string;
  captionLanguage: string;
  captionMode: 'off' | 'automatic' | 'on';
  appearance: CaptionAppearance;
}
export const DEFAULT_PLAYBACK: PlaybackPreferences = {
  audioLanguage: '', captionLanguage: '', captionMode: 'off',
  appearance: { size: 100, color: 'white', background: 0.6 },
};
export interface CaptionCue { start: number; end: number; text: string }
export interface TrackState {
  sessionId: string;
  generation: number;
  tracks: MediaTrack[];
  audioId?: string;
  subtitleId?: string;
  status: 'discovering' | 'ready' | 'error';
  error?: string;
  switching?: boolean;
}
export interface TrackRequest {
  sessionId: string;
  generation: number;
  audioId?: string;
  audioLanguage?: string;
  subtitleLanguage?: string;
  /** undefined applies preferences; null explicitly turns subtitles off. */
  subtitleId?: string | null;
  offset: number;
  captionDelay: number;
  retry?: boolean;
}
export interface CueEvent {
  sessionId: string;
  generation: number;
  reset?: boolean;
  cues: CaptionCue[];
}

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', por: 'pt',
  zho: 'zh', chi: 'zh', jpn: 'ja', kor: 'ko', ara: 'ar', hin: 'hi', rus: 'ru', nld: 'nl',
  dut: 'nl', pol: 'pl', tur: 'tr', ell: 'el', gre: 'el', swe: 'sv', dan: 'da', nor: 'no',
  fin: 'fi', ces: 'cs', cze: 'cs', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', ukr: 'uk',
};
export function languageCode(value = ''): string {
  const parts = value.trim().toLowerCase().replaceAll('_', '-').split('-');
  parts[0] = LANGUAGE_ALIASES[parts[0]] ?? parts[0];
  return parts[0] === 'und' ? '' : parts.join('-');
}
export function languageMatch(track: MediaTrack, language: string): number {
  const wanted = languageCode(language), actual = languageCode(track.language);
  return !wanted || !actual ? 0 : actual === wanted ? 2 : actual.split('-')[0] === wanted.split('-')[0] ? 1 : 0;
}
export function preferredTrack(tracks: MediaTrack[], language: string): MediaTrack | undefined {
  return tracks.filter(t => t.supported).sort((a, b) =>
    languageMatch(b, language) - languageMatch(a, language) || Number(b.default) - Number(a.default))[0];
}
export function chooseTracks(tracks: MediaTrack[], prefs: PlaybackPreferences): { audioId?: string; subtitleId?: string } {
  const audioId = preferredTrack(tracks.filter(t => t.kind === 'audio'), prefs.audioLanguage)?.id;
  const subs = tracks.filter(t => t.kind === 'subtitle' && t.supported);
  if (prefs.captionMode === 'off') return { audioId };
  if (prefs.captionMode === 'automatic') {
    const lang = prefs.captionLanguage || tracks.find(t => t.id === audioId)?.language || '';
    return { audioId, subtitleId: preferredTrack(subs.filter(t => t.forced && languageMatch(t, lang) > 0), lang)?.id };
  }
  const matched = subs.filter(t => !t.forced && languageMatch(t, prefs.captionLanguage) > 0);
  return { audioId, subtitleId: preferredTrack(matched.length ? matched : subs, prefs.captionLanguage)?.id };
}
export function parsePlaybackPreferences(raw: unknown, base = DEFAULT_PLAYBACK): PlaybackPreferences {
  const r = raw && typeof raw === 'object' ? raw as Partial<PlaybackPreferences> : {};
  const a = r.appearance && typeof r.appearance === 'object' ? r.appearance : base.appearance;
  const bounded = (n: unknown, lo: number, hi: number, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  return {
    audioLanguage: typeof r.audioLanguage === 'string' ? languageCode(r.audioLanguage).slice(0, 35) : base.audioLanguage,
    captionLanguage: typeof r.captionLanguage === 'string' ? languageCode(r.captionLanguage).slice(0, 35) : base.captionLanguage,
    captionMode: ['off', 'on', 'automatic'].includes(r.captionMode ?? '') ? r.captionMode! : base.captionMode,
    appearance: {
      size: bounded(a.size, 75, 200, base.appearance.size),
      color: a.color === 'yellow' || a.color === 'white' ? a.color : base.appearance.color,
      background: bounded(a.background, 0, 1, base.appearance.background),
    },
  };
}

function timestamp(s: string): number {
  const p = s.replace(',', '.').split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}
/** Parses complete SRT/WebVTT blocks, with no HTML execution or external resource loading. */
export function parseSubtitleText(text: string): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const block of text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(l => /-->/.test(l));
    if (at < 0 || /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const m = /((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/.exec(lines[at]);
    if (!m) continue;
    const start = timestamp(m[1]), end = timestamp(m[2]);
    // Keep plain caption text. Native cues understand character references and basic markup.
    const body = lines.slice(at + 1).join('\n').replace(/<\/?(?!b\b|i\b|u\b)[^>]*>/g, '').slice(0, 16_384);
    if (Number.isFinite(start) && end > start && body.trim()) cues.push({ start, end, text: body });
    if (cues.length >= 100_000) break;
  }
  return cues;
}

export class SubtitleStreamParser {
  private pending = '';
  push(chunk: string, final = false): CaptionCue[] {
    this.pending += chunk.replace(/\r/g, '');
    const end = final ? this.pending.length : this.pending.lastIndexOf('\n\n');
    if (end < 0) { if (this.pending.length > 65_536) this.pending = ''; return []; }
    const text = this.pending.slice(0, end);
    this.pending = final ? '' : this.pending.slice(end + 2);
    return parseSubtitleText(text);
  }
}
