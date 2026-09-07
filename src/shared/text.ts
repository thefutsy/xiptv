export function fold(input: string): string {
  return input.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Country, language and marker codes that providers bolt onto the front of channel, film and
 * category names (`UK - BBC 1`, `|UK| GENERAL`, `EN - Slow Horses`). Only a token on this list is
 * treated as a prefix, so a real title like `MI-5` or `NCIS - Los Angeles` is left alone.
 */
export const PREFIX_CODES = new Set([
  'AD','AE','AF','AL','AM','AR','AT','AU','AZ','BA','BE','BG','BR','BY','CA','CH','CL','CN','CO',
  'CZ','DE','DK','DZ','EC','EE','EG','ES','FI','FR','GB','GR','HR','HU','ID','IE','IL','IN','IQ',
  'IR','IS','IT','JP','KR','KW','LB','LT','LU','LV','MA','MD','ME','MK','MT','MX','MY','NG','NL',
  'NO','NZ','PE','PH','PK','PL','PT','QA','RO','RS','RU','SA','SE','SI','SK','SY','TH','TN','TR',
  'TW','UA','UK','US','UY','VE','VN','ZA',
  'EN','EU','VIP','4K','UHD','FHD','HD','SD','PPV','EX-YU','LATINO','MULTI','MULTISUB','XXX',
  'ALL','ARAB','AFR',
]);

/** Section markers a provider repeats on every category in a section (`VOD - ACTION [EN]`). */
export const KIND_MARKERS = new Set(['VOD', 'SRS', 'SERIES', 'SERIE', 'MOVIES', 'MOVIE', 'LIVE', 'TV']);
