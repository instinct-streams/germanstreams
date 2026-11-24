// Moflix-Stream (moflix-stream.xyz) - movies and series. The site is a Laravel/React
// app that server-renders its page data into window.bootstrapData:
//   /search/<title>                      -> results with imdb_id and primary_video
//   /titles/<id>/<slug>/season/<n>       -> episodes with primary_video ids
//   /watch/<videoId>                     -> the video plus alternative_videos (hoster mirrors)
// Only German mirrors are returned. Matching is by IMDb id, never by title alone.
import { fetchText } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const BASE = 'https://moflix-stream.xyz';
const cache = new TtlCache();

const bootstrap = async (path) => {
  const { text } = await fetchText(`${BASE}${path}`, { headers: { Accept: '*/*' }, timeoutMs: 7_000 });
  const raw = text.match(/window\.bootstrapData\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/)?.[1];
  if (!raw) throw new Error('Moflix: no bootstrap data');
  return JSON.parse(raw).loaders ?? {};
};

const slugify = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const findTitle = async (info) => {
  const queries = [...new Set([info.title, info.originalTitle].filter(Boolean))];
  for (const q of queries) {
    const { searchPage } = await bootstrap(`/search/${encodeURIComponent(q)}`);
    const hit = (searchPage?.results ?? []).find(
      (r) => r.model_type === 'title' && r.imdb_id === info.imdbId,
    );
    if (hit) return hit;
  }
  return undefined;
};

const primaryVideoId = async (info, title) => {
  if (info.kind === 'movie') return title.primary_video?.id;
  if (info.season === undefined || info.episode === undefined) return undefined;
  const { seasonPage } = await bootstrap(`/titles/${title.id}/${slugify(title.name) || 'title'}/season/${info.season}`);
  const episode = (seasonPage?.episodes?.data ?? []).find(
    (e) => e.episode_number === info.episode,
  );
  return episode?.primary_video?.id;
};

export const moflix = {
  id: 'moflix',
  label: 'Moflix',
  kinds: ['movie', 'series'],

  async getEmbeds(info) {
    if (!info.imdbId) return [];
    const key = `mf:${info.imdbId}:${info.season ?? ''}:${info.episode ?? ''}`;
    return cache.wrap(key, 30 * 60_000, async () => {
      const title = await findTitle(info);
      if (!title) return [];
      const videoId = await primaryVideoId(info, title);
      if (!videoId) return [];
      const { watchPage } = await bootstrap(`/watch/${videoId}`);
      const pageUrl = `${BASE}/watch/${videoId}`;
      const seen = new Set();
      const embeds = [];
      for (const v of watchPage?.alternative_videos ?? []) {
        if (v.type !== 'embed' || !v.src || v.language !== 'de' || seen.has(v.src)) continue;
        seen.add(v.src);
        embeds.push({ url: v.src, referer: pageUrl });
      }
      return embeds;
    });
  },
};
