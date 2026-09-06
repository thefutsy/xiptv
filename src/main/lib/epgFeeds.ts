/**
 * Public XMLTV feeds that fill in channels the provider's own guide leaves empty. All of them
 * come from epgshare01.online, which republishes broadcaster listings per country as gzip XML
 * refreshed daily. Country ids are ISO 3166 codes so a provider prefix like `AU:` or `US |`
 * selects the matching feed automatically.
 */

import type { EpgFeed } from '@shared/types';

const BASE = 'https://epgshare01.online/epgshare01/';

function feed(id: string, label: string, file: string, countries: readonly string[] = [id]): EpgFeed {
  return { id, label, url: `${BASE}epg_ripper_${file}.xml.gz`, countries: [...countries] };
}

export const EPG_FEEDS: readonly EpgFeed[] = [
  feed('ae', 'United Arab Emirates', 'AE1'),
  feed('al', 'Albania', 'AL1'),
  feed('ar', 'Argentina', 'AR1'),
  feed('at', 'Austria', 'AT1'),
  feed('au', 'Australia', 'AU1'),
  feed('ba', 'Bosnia and Herzegovina', 'BA1'),
  feed('bb', 'Barbados', 'BB1'),
  feed('be', 'Belgium', 'BE2'),
  feed('bg', 'Bulgaria', 'BG1'),
  feed('br', 'Brazil', 'BR1'),
  feed('ca', 'Canada', 'CA2'),
  feed('ch', 'Switzerland', 'CH1'),
  feed('cl', 'Chile', 'CL1'),
  feed('co', 'Colombia', 'CO1'),
  feed('cr', 'Costa Rica', 'CR1'),
  feed('cy', 'Cyprus', 'CY1'),
  feed('cz', 'Czechia', 'CZ1'),
  feed('de', 'Germany', 'DE1'),
  feed('dk', 'Denmark', 'DK1'),
  feed('do', 'Dominican Republic', 'DO1'),
  feed('ec', 'Ecuador', 'EC1'),
  feed('eg', 'Egypt', 'EG1'),
  feed('es', 'Spain', 'ES1'),
  feed('fi', 'Finland', 'FI1'),
  feed('fr', 'France', 'FR1'),
  feed('gr', 'Greece', 'GR1'),
  feed('hk', 'Hong Kong', 'HK1'),
  feed('hr', 'Croatia', 'HR1'),
  feed('hu', 'Hungary', 'HU1'),
  feed('id', 'Indonesia', 'ID1'),
  feed('ie', 'Ireland', 'IE1'),
  feed('il', 'Israel', 'IL1'),
  feed('in', 'India', 'IN1'),
  feed('it', 'Italy', 'IT1'),
  feed('jm', 'Jamaica', 'JM1'),
  feed('jp', 'Japan', 'JP1'),
  feed('ke', 'Kenya', 'KE1'),
  feed('kr', 'South Korea', 'KR1'),
  feed('lt', 'Lithuania', 'LT1'),
  feed('lu', 'Luxembourg', 'LU1'),
  feed('lv', 'Latvia', 'LV1'),
  feed('mt', 'Malta', 'MT1'),
  feed('mx', 'Mexico', 'MX1'),
  feed('my', 'Malaysia', 'MY1'),
  feed('ng', 'Nigeria', 'NG1'),
  feed('nl', 'Netherlands', 'NL1'),
  feed('no', 'Norway', 'NO1'),
  feed('nz', 'New Zealand', 'NZ1'),
  feed('pa', 'Panama', 'PA1'),
  feed('pe', 'Peru', 'PE1'),
  feed('ph', 'Philippines', 'PH2'),
  feed('pl', 'Poland', 'PL1'),
  feed('pt', 'Portugal', 'PT1'),
  feed('ro', 'Romania', 'RO1'),
  feed('rs', 'Serbia', 'RS1'),
  feed('sa', 'Saudi Arabia', 'SA2'),
  feed('se', 'Sweden', 'SE1'),
  feed('sg', 'Singapore', 'SG1'),
  feed('sk', 'Slovakia', 'SK1'),
  feed('sv', 'El Salvador', 'SV1'),
  feed('th', 'Thailand', 'TH1'),
  feed('tr', 'Turkey', 'TR3'),
  feed('uk', 'United Kingdom', 'UK1', ['uk', 'gb']),
  feed('us', 'United States', 'US2'),
  feed('us-sports', 'United States sports', 'US_SPORTS1', ['us']),
  feed('uy', 'Uruguay', 'UY1'),
  feed('vn', 'Vietnam', 'VN1'),
  feed('za', 'South Africa', 'ZA1'),
  feed('bein', 'beIN Sports', 'BEIN1', []),
  feed('plex', 'Plex', 'PLEX1', []),
  feed('rakuten', 'Rakuten TV', 'RAKUTEN1', []),
  feed('distrotv', 'DistroTV', 'DISTROTV1', []),
];

const BY_ID = new Map(EPG_FEEDS.map((f) => [f.id, f]));

/** Feeds a sports-heavy lineup nearly always wants, whatever the country. */
const ALWAYS: readonly string[] = ['bein'];

/** A 2-letter tag followed by a separator, `AU:`, `US |`, `UK ★`, `FR -`. */
const TAG_RE = /^\s*([a-z]{2})\s*(?:[^\p{L}\p{N}\s]|\|)/iu;

export function countryTag(name: string): string | undefined {
  const m = TAG_RE.exec(name);
  return m !== null ? m[1].toLowerCase() : undefined;
}

/**
 * Picks feeds for the countries a lineup is tagged with. A tag needs a handful of channels
 * behind it so a stray `TV:` or `4K:` prefix does not pull in a country's whole feed.
 */
export function autoFeeds(names: Iterable<string>, minChannels = 5): EpgFeed[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const tag = countryTag(name);
    if (tag !== undefined) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const picked: EpgFeed[] = [];
  for (const f of EPG_FEEDS) {
    if (ALWAYS.includes(f.id) || f.countries.some((c) => (counts.get(c) ?? 0) >= minChannels)) picked.push(f);
  }
  return picked;
}

/** Resolves a catalogue id or a raw XMLTV url the user typed. */
export function resolveFeed(ref: string): EpgFeed | undefined {
  const known = BY_ID.get(ref);
  if (known !== undefined) return known;
  try {
    const url = new URL(ref);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return { id: ref, label: url.hostname, url: ref, countries: [] };
  } catch {
    return undefined;
  }
}
