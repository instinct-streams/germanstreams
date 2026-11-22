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
const postCache = new TtlCache();
const pendingPosts = new Map();
const POSITIVE_TTL = 30 * 60 * 1000;
const NEGATIVE_TTL = 5 * 60 * 1000;

// Catalog entries checked against xCine's own embedded IMDb player on 2026-11-22.
// The catalog search denies some hosting-provider IPs. These verified records
// remain usable without that search; playback links still come fresh from the player.
const VERIFIED_POSTS = new Map([
  ['series:tt31510819', { postUrl: 'https://xcine.hair/25599-mobland-stream-deutsch-kostenlos.html', imdbId: 'tt31510819' }],
  ['series:tt2802850', { postUrl: 'https://xcine.hair/26332-fargo-stream-deutsch-kostenlos.html', imdbId: 'tt2802850' }],
]);

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
const searchPost = async (info) => {
  const targets = new Set([info.title, info.originalTitle].filter(Boolean).map(norm));
  const titles = [...new Set([info.originalTitle, info.title].filter(Boolean))];
  for (const title of titles) {
    let html;
    try {
      ({ text: html } = await fetchText(
        `${BASE}/?do=search&subaction=search&story=${encodeURIComponent(title)}`,
        { timeoutMs: 3_000 },
      ));
    } catch (error) {
      console.warn(`[xCine] search ${info.imdbId ?? info.tmdbId}: ${error.message}`);
      if (error.status === 429 || error.status === 403) throw error;
      continue;
    }
    const items = [
      ...html.matchAll(
        /<a class="movie-item__link" href="(https:\/\/xcine\.hair\/[^"]+)"([\s\S]*?)movie-item__meta ws-nowrap">\s*<span>([^<]*)<\/span>\s*<span>([^<]*)<\/span>/g,
      ),
    ];
    for (const m of items.slice(0, 8)) {
      const [, href, inner, , cat] = m;
      const alt = inner.match(/alt="([^"]*)"/)?.[1] ?? '';
      if (!targets.has(norm(baseTitle(alt)))) continue;
      const isSeries = /\bserien\b/i.test(cat.trim());
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

// A post identifies the whole series. Reuse it across episode requests and
// coalesce concurrent lookups instead of repeating catalog searches per episode.
const findPost = async (info) => {
  const key = `${info.kind}:${info.imdbId ?? info.tmdbId}`;
  if (VERIFIED_POSTS.has(key)) return VERIFIED_POSTS.get(key);
  const hit = postCache.get(key);
  if (hit !== undefined) return hit;
  if (pendingPosts.has(key)) return pendingPosts.get(key);
  const pending = searchPost(info).then((post) => {
    postCache.set(key, post, post ? 6 * 60 * 60_000 : NEGATIVE_TTL);
    return post;
  }).finally(() => pendingPosts.delete(key));
  pendingPosts.set(key, pending);
  return pending;
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
        // SuperVideo signs links to the resolver IP. Do not offer a broken direct
        // mirror or silently spend relay bandwidth when Dropload works directly.
        .filter((s) => typeof s.url === 'string' && s.url.startsWith('http') && !/supervideo|superplayer/i.test(s.name + s.url))
        .map((s) => ({ url: s.url, referer: pageUrl, hostLabel: s.name, rank: s.rank ?? 99 }));
    });
  },
};
