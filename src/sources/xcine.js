// xCine (xcine.hair) - movies and series. The site is a DataLife Engine catalog:
// GET /?do=search&subaction=search&story=<title> returns .movie-item blocks; each
// series/film post embeds the DeVideoSRC player (devideosrc.co) keyed by IMDb id.
// The player page carries a signed token in inline JS; POSTing it to
// /api/embed-links returns the hoster embed list (same API as MeineCloud).
import { fetchText, postJson } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const BASE = 'https://xcine.hair';
const PLAYER = 'https://devideosrc.co';
const cache = new TtlCache();
const POSITIVE_TTL = 30 * 60 * 1000;
const NEGATIVE_TTL = 5 * 60 * 1000;

const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');

// xCine season posts title the entry "<Series> - Staffel N"; the series name is the base.
const baseTitle = (alt) => alt.replace(/\s*[-–]\s*(staffel|season)\s*\d+\s*$/i, '').trim();

// Find the xCine post URL whose title and kind match. Returns the page URL and the
// IMDb id embedded in the page, checking up to `maxCandidates` search hits.
const findPost = async (info) => {
  const targets = new Set([info.title, info.originalTitle].filter(Boolean).map(norm));
  const titles = [...new Set([info.title, info.originalTitle].filter(Boolean))];
  for (const title of titles) {
    const { text: html } = await fetchText(
      `${BASE}/?do=search&subaction=search&story=${encodeURIComponent(title)}`,
      { timeoutMs: 8_000 },
    );
    const items = [
      ...html.matchAll(
        /<a class="movie-item__link" href="(https:\/\/xcine\.hair\/[^"]+)"([\s\S]*?)movie-item__meta ws-nowrap">\s*<span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g,
      ),
    ];
    for (const m of items.slice(0, 8)) {
      const [, href, inner, , cat] = m;
      const alt = inner.match(/alt="([^"]*)"/)?.[1] ?? '';
      if (!targets.has(norm(baseTitle(alt)))) continue;
      const isSeries = /^serien\b/i.test(cat.trim());
      if ((info.kind === 'series') !== isSeries) continue;
      const { text: page } = await fetchText(href, { timeoutMs: 8_000 });
      const raw =
        page.match(/var rawId = \('((?:tt)?\d+)'/)?.[1] ??
        page.match(/devideosrc\.co\/(?:movie|serial)\/(tt\d+)/)?.[1];
      if (!raw) continue;
      const imdbId = raw.startsWith('tt') ? raw : `tt${raw}`;
      // Cross-check against TMDB so a wrong-title hit cannot inject an unrelated stream.
      if (info.imdbId && imdbId !== info.imdbId) continue;
      return { postUrl: href, imdbId };
    }
  }
  return null;
};

export const xcine = {
  id: 'xcine',
  label: 'xCine',
  kinds: ['movie', 'series'],

  async getEmbeds(info) {
    const cacheKey = `xc:${info.kind}:${info.tmdbId}:${info.season ?? ''}:${info.episode ?? ''}`;
    return cache.wrap(cacheKey, POSITIVE_TTL, async () => {
      const post = await findPost(info);
      if (!post) {
        cache.set(cacheKey, [], NEGATIVE_TTL);
        return [];
      }

      const playerPath = info.kind === 'series' ? 'serial' : 'movie';
      const pageUrl = `${PLAYER}/${playerPath}/${post.imdbId}`;
      const { text } = await fetchText(pageUrl, { headers: { Referer: post.postUrl }, timeoutMs: 8_000 });
      const token = text.match(/token:\s*"([^"]+)"/)?.[1];
      if (!token) return [];

      const { json } = await postJson(
        `${PLAYER}/api/embed-links`,
        { type: info.kind === 'series' ? 'tv' : 'movie', id: post.imdbId, token },
        { headers: { Referer: pageUrl }, timeoutMs: 8_000 },
      );
      if (!json?.ok) return [];

      let sources = [];
      if (info.kind === 'series') {
        if (info.season === undefined || info.episode === undefined) return [];
        const season = (json.tv?.seasons ?? []).find((s) => s.season_number === info.season);
        const episode = (season?.episodes ?? []).find((e) => e.episode_number === info.episode);
        sources = episode?.sources ?? [];
      } else {
        sources = json.sources ?? [];
      }

      return sources
        .filter((s) => typeof s.url === 'string' && s.url.startsWith('http'))
        .map((s) => ({ url: s.url, referer: pageUrl, hostLabel: s.name, rank: s.rank ?? 99 }));
    });
  },
};
