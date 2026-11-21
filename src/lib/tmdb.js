// TMDB lookups: map between IMDb and TMDB ids and fetch (German) titles.
import { TtlCache } from './cache.js';
import { USER_AGENT } from './http.js';

const API = 'https://api.themoviedb.org/3';
const cache = new TtlCache({ maxEntries: 5000 });
const DAY = 24 * 3600 * 1000;

const token = () => {
  const t = process.env.TMDB_ACCESS_TOKEN;
  if (!t) throw new Error('TMDB_ACCESS_TOKEN is not set');
  return t;
};

const tmdbGet = async (path) => {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token()}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`TMDB ${path} -> HTTP ${response.status}`);
  return response.json();
};

// Normalized title info for a Stremio id.
//   movie:  { kind, tmdbId, imdbId, title (de), originalTitle, year }
//   series: same + season, episode
export const resolveId = async (type, stremioId) => {
  // Stremio ids: tt1234567, tt1234567:1:2, tmdb:123, tmdb:123:1:2
  let rest = stremioId;
  let prefix = '';
  if (rest.startsWith('tmdb:')) { prefix = 'tmdb:'; rest = rest.slice(5); }
  const [base, seasonStr, episodeStr] = rest.split(':');
  const rawId = prefix + base;
  const season = seasonStr !== undefined ? parseInt(seasonStr, 10) : undefined;
  const episode = episodeStr !== undefined ? parseInt(episodeStr, 10) : undefined;

  return cache.wrap(`id:${type}:${rawId}:${season}:${episode}`, DAY, async () => {
    let tmdbId;
    let imdbId;

    if (rawId.startsWith('tt')) {
      imdbId = rawId;
      const found = await tmdbGet(`/find/${rawId}?external_source=imdb_id`);
      const hit = type === 'series' ? found.tv_results?.[0] : found.movie_results?.[0];
      if (!hit) throw new Error(`TMDB: no ${type} for ${rawId}`);
      tmdbId = hit.id;
    } else {
      tmdbId = parseInt(rawId.replace(/^tmdb:/, ''), 10);
      if (Number.isNaN(tmdbId)) throw new Error(`Unsupported id: ${rawId}`);
      const external = await tmdbGet(`/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids`);
      imdbId = external.imdb_id ?? undefined;
    }

    const kindPath = type === 'series' ? 'tv' : 'movie';
    const [de, en] = await Promise.all([
      tmdbGet(`/${kindPath}/${tmdbId}?language=de-DE`),
      tmdbGet(`/${kindPath}/${tmdbId}?language=en-US`).catch(() => undefined),
    ]);

    const title = (de.title ?? de.name) || (en?.title ?? en?.name) || '';
    const originalTitle = (de.original_title ?? de.original_name) || title;
    const dateStr = de.release_date ?? de.first_air_date ?? '';
    const year = parseInt(dateStr.slice(0, 4), 10);

    return { kind: type, tmdbId, imdbId, title, originalTitle, year, season, episode };
  }).then((info) => ({ ...info, season, episode }));
};
