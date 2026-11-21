// MegaKino (domain rotates, currently megakino2.biz -> megakino29.com) - movies.
// Flow: HEAD /?yg=token issues the yg_token cookie; with it, POST a DLE search for
// the IMDb id; the film page carries hoster iframes.
import { fetchResponse, fetchText, postForm } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const SEED_URL = 'https://megakino1.to/';
const cache = new TtlCache();

const getBaseUrl = () =>
  cache.wrap('mk:base', 3600_000, async () => {
    const response = await fetchResponse(SEED_URL, { timeoutMs: 8_000 });
    return new URL(response.url).origin;
  });

const getCookie = (baseUrl) =>
  cache.wrap('mk:cookie', 300_000, async () => {
    const response = await fetchResponse(`${baseUrl}/?yg=token`, { method: 'HEAD', timeoutMs: 8_000 });
    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/yg_token=[^;]+/);
    if (!match) throw new Error('MegaKino: no yg_token cookie');
    return match[0];
  });

export const megakino = {
  id: 'megakino',
  label: 'MegaKino',
  kinds: ['movie'],

  async getEmbeds(info) {
    if (!info.imdbId) return [];
    return cache.wrap(`mk:${info.imdbId}`, 30 * 60_000, async () => {
      const baseUrl = await getBaseUrl();
      const cookie = await getCookie(baseUrl);
      const headers = { Cookie: cookie, Referer: baseUrl };

      const { text: searchHtml } = await postForm(
        `${baseUrl}/`,
        { do: 'search', subaction: 'search', story: info.imdbId },
        { headers, timeoutMs: 8_000 },
      );
      const filmPath = searchHtml.match(/href="(\/films\/\d+-[^"]+\.html)"/)?.[1];
      if (!filmPath) return [];

      const pageUrl = `${baseUrl}${filmPath}`;
      const { text: filmHtml } = await fetchText(pageUrl, { headers, timeoutMs: 8_000 });

      const embeds = [];
      const seen = new Set();
      const iframeRe = /<iframe\b[^>]*?(?:data-src|src)="(https?:\/\/[^"]+)"/g;
      let m;
      while ((m = iframeRe.exec(filmHtml)) !== null) {
        const url = m[1];
        if (seen.has(url) || /youtube|youtu\.be|trailer/i.test(url)) continue;
        seen.add(url);
        embeds.push({ url, referer: pageUrl });
      }
      return embeds;
    });
  },
};
