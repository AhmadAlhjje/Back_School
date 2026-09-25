/**
 * Per-request playlist rewriting. Stored playlists contain bare relative names; clients receive
 * versions where every URI carries the caller's media token and the AES key URI points to the
 * authorizing key endpoint. Storage paths never appear in anything sent to clients.
 */

const withToken = (uri: string, token: string) =>
  `${uri}${uri.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

/** Master playlist: variant playlist URIs get the token. */
export function rewriteMasterPlaylist(content: string, token: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => (line && !line.startsWith('#') ? withToken(line.trim(), token) : line))
    .join('\n');
}

/**
 * Variant playlist: segment URIs get the token and the key URI is replaced.
 * `keyUri` is relative to the variant playlist URL (e.g. "../key").
 */
export function rewriteVariantPlaylist(content: string, token: string, keyUri: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith('#EXT-X-KEY:'))
        return line.replace(/URI="[^"]*"/, `URI="${withToken(keyUri, token)}"`);
      if (line && !line.startsWith('#')) return withToken(line.trim(), token);
      return line;
    })
    .join('\n');
}

export const VARIANT_PATTERN = /^v\d{1,2}$/;
export const SEGMENT_PATTERN = /^seg_\d{5,6}\.ts$/;
