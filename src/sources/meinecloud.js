// MeineCloud (meinecloud.click) - movies. The movie page embeds a signed token in
// inline JS; POSTing it to /api/embed-links returns the hoster embed list.
import { fetchText, postJson } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const BASE = 'https://meinecloud.click';
const cache = new TtlCache();
const POSITIVE_TTL = 30 * 60 * 1000;
const NEGATIVE_TTL = 5 * 60 * 1000;

export const meinecloud = {
  id: 'meinecloud',
  label: 'MeineCloud',
  kinds: ['movie'],

  async getEmbeds(info) {
    if (!info.imdbId) return [];
    return cache.wrap(`mc:${info.imdbId}`, POSITIVE_TTL, async () => {
      const pageUrl = `${BASE}/movie/${info.imdbId}`;
      const { text: html } = await fetchText(pageUrl, { timeoutMs: 8_000 });

      const tokenMatch = html.match(/api\/embed-links[\s\S]{0,400}?token:\s*"([^"]+)"/);
      if (!tokenMatch) {
        cache.set(`mc:${info.imdbId}`, [], NEGATIVE_TTL);
        return [];
      }

      const { json } = await postJson(
        `${BASE}/api/embed-links`,
        { type: 'movie', id: info.imdbId, token: tokenMatch[1] },
        { headers: { Referer: pageUrl }, timeoutMs: 8_000 },
      );
      if (!json?.ok || !Array.isArray(json.sources)) return [];

      return json.sources
        .filter((s) => typeof s.url === 'string' && s.url.startsWith('http'))
        .map((s) => ({ url: s.url, referer: pageUrl, hostLabel: s.name, rank: s.rank ?? 99 }));
    });
  },
};
