/**
 * Credential scrubbing for text a person can see.
 *
 * Provider credentials ride in URLs two different ways, and both reach error messages:
 *   - query strings,  `…/xmltv.php?username=U&password=P`
 *   - path segments,  `…/live/U/P/12345.ts`, the Xtream stream URL form
 *
 * The username is deliberately left alone: it is not the secret, and providers of this kind bake
 * it into the hostname anyway (`A7KP2QX9.cdn.example.com`).
 */

const MASK = '***';

const SECRET_PARAMS = ['password', 'pass', 'token'];

/**
 * Path prefixes Xtream follows with `<username>/<password>`. `timeshift` inserts two extra
 * segments before the stream id, but the credential pair sits in the same place regardless.
 */
const CREDENTIAL_PATH_PREFIXES = new Set(['live', 'movie', 'series', 'timeshift', 'hls']);

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

const SECRET_PARAM_RE = new RegExp(`([?&](?:${SECRET_PARAMS.join('|')})=)[^&#\\s]*`, 'gi');

export function redactUrl(url: URL | string): string {
  const raw = typeof url === 'string' ? url : url.href;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.replace(SECRET_PARAM_RE, `$1${MASK}`);
  }

  // Snapshot the keys: set() mutates the collection being iterated.
  for (const key of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAMS.includes(key.toLowerCase())) parsed.searchParams.set(key, MASK);
  }
  if (parsed.password !== '') parsed.password = MASK;

  // Only assign when something changed; the setter re-encodes the path either way.
  const pathname = maskCredentialPath(parsed.pathname);
  if (pathname !== parsed.pathname) parsed.pathname = pathname;

  return restoreHostCase(parsed.toString(), raw);
}

export function redactText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const url = trailing.length > 0 ? match.slice(0, -trailing.length) : match;
    return redactUrl(url) + trailing;
  });
}

/**
 * `new URL()` lower-cases the host, and these hostnames embed the account name
 * (`A7KP2QX9.cdn.example.com`), so put the spelling the user typed back.
 */
const AUTHORITY_RE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#:]+)/i;

function restoreHostCase(masked: string, raw: string): string {
  const original = AUTHORITY_RE.exec(raw)?.[1];
  if (original === undefined || original === original.toLowerCase()) return masked;
  const at = masked.toLowerCase().indexOf(original.toLowerCase());
  if (at === -1) return masked;
  return masked.slice(0, at) + original + masked.slice(at + original.length);
}

function maskCredentialPath(pathname: string): string {
  // pathname always starts with '/', so segments[0] is the empty string before it.
  const segments = pathname.split('/');

  // `/live/<user>/<pass>/<id>.<ext>` and the other kind-prefixed forms.
  const prefix = segments[1]?.toLowerCase();
  if (prefix !== undefined && CREDENTIAL_PATH_PREFIXES.has(prefix) && segments.length >= 5) {
    segments[3] = MASK;
    return segments.join('/');
  }

  // The bare legacy form `/<user>/<pass>/<streamId>[.ext]`, still served by older panels. The
  // numeric stream id is required so an ordinary three-deep path is not mistaken for it.
  if (segments.length === 4 && /^\d+(?:\.[A-Za-z0-9]{1,5})?$/.test(segments[3])) {
    segments[2] = MASK;
    return segments.join('/');
  }

  return pathname;
}
