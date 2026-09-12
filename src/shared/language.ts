import type { MediaItem } from './types';
import { fold, KIND_MARKERS, PREFIX_CODES, SERVICE_CODES } from './text';

const LANGUAGES: Record<string, string> = {};
for (const [label, aliases] of [
  ['English', 'en eng english'], ['French', 'fr fra fre french français'],
  ['German', 'de deu ger german deutsch'], ['Spanish', 'es spa spanish español'],
  ['Italian', 'it ita italian italiano'], ['Portuguese', 'pt por portuguese português'],
  ['Arabic', 'ar ara arab arabic'], ['Dutch', 'nl nld dut dutch'],
  ['Polish', 'pl pol polish'], ['Turkish', 'tr tur turkish'], ['Russian', 'ru rus russian'],
  ['Greek', 'el ell gre greek'], ['Hindi', 'hi hin hindi'], ['Tamil', 'ta tam tamil'],
  ['Telugu', 'te tel telugu'], ['Malayalam', 'ml mal malayalam'], ['Bengali', 'bn ben bengali'],
  ['Urdu', 'ur urd urdu'], ['Punjabi', 'pa pan punjabi'], ['Chinese', 'zh zho chi chinese'],
  ['Japanese', 'ja jpn japanese'], ['Korean', 'ko kor korean'], ['Thai', 'th tha thai'],
  ['Vietnamese', 'vi vie vietnamese'], ['Indonesian', 'id ind indonesian'],
  ['Swedish', 'sv swe swedish'], ['Norwegian', 'no nor norwegian'], ['Danish', 'da dan danish'],
  ['Finnish', 'fi fin finnish'], ['Czech', 'cs ces cze czech'], ['Slovak', 'sk slk slo slovak'],
  ['Romanian', 'ro ron rum romanian'], ['Hungarian', 'hu hun hungarian'],
  ['Bulgarian', 'bg bul bulgarian'], ['Croatian', 'hr hrv croatian'], ['Serbian', 'sr srp serbian'],
  ['Ukrainian', 'ukr ukrainian'], ['Hebrew', 'he heb hebrew'], ['Persian', 'fa fas per persian'],
  ['Spanish (Latino)', 'latino'],
]) {
  for (const alias of aliases.split(' ')) LANGUAGES[fold(alias)] = label;
}

export interface LanguageHint {
  label: string;
  description: string;
}

function languageLabel(value: string): string | undefined {
  const key = fold(value.trim());
  if (/^(multi(?:[ -]*(?:audio|lang(?:uage)?s?))?)$/.test(key)) return 'Multi-audio';
  if (/^dual[ -]*audio$/.test(key)) return 'Dual audio';
  return LANGUAGES[key];
}

const DECOR = /^[\s★☆❖✪◉▣●✺✦✧◆◇■□▪▫•►▶➤※»«|:—–-]+/u;
const PREFIX = /^(?:\[([^\]]{2,24})\]|\(([^)]{2,24})\)|([\p{L}\d]+(?:-[\p{L}\d]+)?)\s*(?:[★☆❖✪◉▣●✺✦✧◆◇■□▪▫•►▶➤※»«|:]|[-—–]\s))\s*/u;

function taggedLabel(raw: string, category: boolean): { label: string; region?: boolean } | undefined {
  let rest = raw.trim().replace(DECOR, '');
  // Only fenced prefixes count in titles: "French Connection" and "It" are movie names.
  // Categories also commonly use "EN MOVIES" without decoration.
  for (let i = 0; i < 5; i++) {
    const match = PREFIX.exec(rest) ?? (category ? /^([\p{L}\d-]+)(?:\s+|$)/u.exec(rest) : null);
    if (!match) break;
    const token = (match[1] ?? match[2] ?? match[3]).trim();
    const code = token.toUpperCase();
    // HU is also a streaming-service prefix. Do not guess Hungarian from a title's HU tag.
    const label = code === 'HU' && !category ? undefined : languageLabel(token);
    if (label) return { label };
    if (!(code === 'HU' && !category) && PREFIX_CODES.has(code) && !['VIP', '4K', 'UHD', 'FHD', 'HD', 'SD', 'PPV', 'EU', 'ALL', 'XXX', 'MULTISUB', 'AFR'].includes(code)) {
      return { label: code, region: true };
    }
    if (!PREFIX_CODES.has(code) && !SERVICE_CODES.has(code) && !KIND_MARKERS.has(code)) break;
    rest = rest.slice(match[0].length).trim().replace(DECOR, '');
  }
  // A country suffix can identify a remake (The Office (US)), so only language labels qualify.
  const groups = [...raw.matchAll(/[[(]([^()[\]]{2,24})[)\]]/g)];
  for (const group of groups.reverse()) {
    const label = languageLabel(group[1]);
    if (label) return { label };
  }
  return undefined;
}

/** Provider hints describe this catalogue entry, not the original language of the film. */
export function mediaLanguage(item: MediaItem): LanguageHint | undefined {
  if (item.kind === 'live') return undefined;
  if (item.language) {
    const labels = item.language.split(/[,;/+]/).map((value) => {
      const trimmed = value.trim();
      return languageLabel(trimmed) ?? (/^[a-z]{2,3}-[a-z]{2}$/i.test(trimmed)
        ? languageLabel(trimmed.split('-')[0]) : undefined);
    }).filter((value): value is string => !!value);
    if (labels.length) return { label: [...new Set(labels)].join(' / '), description: `Provider language: ${item.language}` };
  }
  // Old M3U caches retain the raw group in categoryId even though their category name was cleaned.
  const category = item.categoryId.startsWith(`${item.kind}:`)
    ? item.categoryId.slice(item.kind.length + 1) : item.categoryName;
  for (const [raw, isCategory] of [[item.name, false], [category, true]] as const) {
    if (!raw) continue;
    const hint = taggedLabel(raw, isCategory);
    if (hint) return {
      label: hint.label,
      description: `Provider ${hint.region ? 'region' : 'language'} tag from ${isCategory ? 'category' : 'title'}: ${raw}`,
    };
  }
  return undefined;
}

export const LANGUAGE_OPTIONS = [...new Set(Object.values(LANGUAGES))].sort((a, b) => a.localeCompare(b));

/** Region-only and unspecified multi-audio tags cannot establish that English is available. */
export function matchesLanguage(item: MediaItem, language: string): boolean {
  if (!language) return true;
  const hint = mediaLanguage(item);
  const labels = hint && !hint.description.startsWith('Provider region') ? hint.label.split(' / ') : [];
  return language === 'unknown' ? item.kind !== 'live' && labels.length === 0 : labels.includes(language);
}
