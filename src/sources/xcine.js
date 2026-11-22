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

// Some catalog pages are denied to datacenter IPs even when the sitemap is
// accessible. Reader's HTML mode preserves the embedded identity for checking.
// This fallback carries catalog HTML only, never media or private account data.
let directCatalogBlockedUntil = 0;
const fetchCatalogPage = async (url, timeoutMs = 1_000) => {
  if (Date.now() >= directCatalogBlockedUntil) {
    try { return await fetchText(url, { timeoutMs }); }
    catch (error) {
      if (error.status !== 403) throw error;
      directCatalogBlockedUntil = Date.now() + 15 * 60_000;
    }
  }
  return fetchText(`https://r.jina.ai/${url}`, {
    headers: { 'X-Respond-With': 'html', 'X-Respond-Timing': 'html' },
    timeoutMs: 2_000,
  });
};

// Find the xCine post URL whose title and kind match. Returns the page URL and the
// IMDb id embedded in the page, checking up to `maxCandidates` search hits.
const nativeSearchPost = async (info) => {
  const targets = new Set([info.title, info.originalTitle].filter(Boolean).map(norm));
  const titles = [...new Set([info.originalTitle, info.title].filter(Boolean))];
  for (const title of titles) {
    let html;
    try {
      ({ text: html } = await fetchCatalogPage(
        `${BASE}/?do=search&subaction=search&story=${encodeURIComponent(title)}`,
        1_000,
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
      const { text: page } = await fetchCatalogPage(href);
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

// Discover posts through xCine's own complete sitemap, not a third-party proxy.
// Keep one shared index for all titles; a failed refresh must not erase good data.
const INDEX_TTL = 6 * 60 * 60_000;
let sitemap = [];
let sitemapAt = 0;
let sitemapRetryAt = 0;
let sitemapPending;
let nativeBlockedUntil = 0;

export const catalogTitle = (url) => {
  const slug = new URL(url).pathname.replace(/^\/\d+-/, '').replace(/\.html$/, '');
  return slug
    .replace(/-(?:staffel|season)-\d+.*$/, '')
    .replace(/-(?:stream(?:en)?|kostenlos|serien-stream|hd-kostenlos|online|kinox|deutsch)(?:-.*)?$/, '')
    .replace(/-\d{4}$/, '');
};

export const parseSitemap = (xml) => [...new Set(
  [...xml.matchAll(/<loc>\s*(https:\/\/xcine\.hair\/\d+-[^<]+\.html)\s*<\/loc>/g)]
    .map((m) => m[1]),
)].map((url) => ({ url, title: norm(catalogTitle(url)) }));

const refreshSitemap = () => {
  if (sitemapPending) return sitemapPending;
  if (Date.now() < sitemapRetryAt) return Promise.resolve(sitemap);
  sitemapPending = (async () => {
    try {
      const { text } = await fetchText(`${BASE}/news_pages.xml`, { timeoutMs: 3_500 });
      if (text.length > 12_000_000) throw new Error('oversized sitemap');
      const entries = parseSitemap(text);
      if (entries.length < 100) throw new Error('invalid or incomplete sitemap');
      sitemap = entries;
      sitemapAt = Date.now();
      sitemapRetryAt = 0;
      console.log(`[xCine] catalog loaded: ${entries.length} posts`);
    } catch (error) {
      sitemapRetryAt = Date.now() + 60_000;
      console.warn(`[xCine] catalog refresh: ${error.message}`);
    }
    return sitemap;
  })().finally(() => { sitemapPending = undefined; });
  return sitemapPending;
};

export const catalogCandidates = (entries, info) => {
  const titles = [info.title, info.originalTitle].filter(Boolean);
  const targets = [...new Set(titles.flatMap((t) => [norm(t), norm(t.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue'))]))];
  return entries.map((entry) => ({ ...entry, score: Math.min(...targets.map((t) =>
    entry.title === t ? 0 : t.length >= 4 && entry.title.startsWith(t) ? 1 : 9,
  )) })).filter((e) => e.score < 9).sort((a, b) => a.score - b.score).slice(0, 8);
};

export const postIdentity = (page) => {
  const raw = page.match(/var rawId = \('((?:tt)?\d+)'/)?.[1]
    ?? page.match(/devideosrc\.co\/(?:movie|serial)\/(tt\d+)/)?.[1];
  return raw ? (raw.startsWith('tt') ? raw : `tt${raw}`) : null;
};

const sitemapSearchPost = async (info) => {
  // The IMDb id is mandatory on this path. A slug is only a discovery hint,
  // never enough to identify a film or distinguish a remake from a series.
  if (!info.imdbId) return null;
  if (!sitemap.length) await refreshSitemap();
  else if (Date.now() - sitemapAt > INDEX_TTL) void refreshSitemap();
  const candidates = catalogCandidates(sitemap, info);
  for (let i = 0; i < candidates.length; i += 4) {
    const results = await Promise.all(candidates.slice(i, i + 4).map(async ({ url }) => {
      try {
        const { text } = await fetchCatalogPage(url);
        const imdbId = postIdentity(text);
        if (imdbId === info.imdbId) {
          console.log(`[xCine] catalog verified ${info.imdbId}`);
          return { postUrl: url, imdbId };
        }
        return null;
      } catch (error) {
        console.warn(`[xCine] post verification: ${error.message}`);
        return null;
      }
    }));
    const match = results.find(Boolean);
    if (match) return match;
  }
  return null;
};

const searchPost = async (info) => {
  const post = await sitemapSearchPost(info);
  if (post) return post;
  // Preserve native search for newly added posts and unusual slugs. Cool down
  // host-wide denials instead of making every title repeat a blocked request.
  if (Date.now() < nativeBlockedUntil) return null;
  try { return await nativeSearchPost(info); }
  catch (error) {
    if (error.status === 403 || error.status === 429) nativeBlockedUntil = Date.now() + 15 * 60_000;
    return null;
  }
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
