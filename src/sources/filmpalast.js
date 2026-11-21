// Filmpalast (filmpalast.to) - movies and series. Search by (German) title; series
// episode pages are /stream/<slug>-sXXeYY. Stream pages list hoster links in
// ul.currentStreamLinks blocks.
import { fetchText } from '../lib/http.js';
import { TtlCache } from '../lib/cache.js';

const BASE = 'https://filmpalast.to';
const cache = new TtlCache();

// filmpalast slugs transliterate umlauts inconsistently (oe vs o) - accept both.
const slugifyBase = (s, expandUmlauts) =>
  s.toLowerCase()
    .replace(/[äÄ]/g, expandUmlauts ? 'ae' : 'a')
    .replace(/[öÖ]/g, expandUmlauts ? 'oe' : 'o')
    .replace(/[üÜ]/g, expandUmlauts ? 'ue' : 'u')
    .replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const slugCandidates = (title, year) => {
  const out = new Set();
  for (const expand of [true, false]) {
    const base = slugifyBase(title, expand);
    if (!base) continue;
    out.add(base);
    if (year) out.add(`${base}-${year}`);
  }
  return out;
};

// Exact slug match so a search for "Dark" never yields "Dark Matter".
const matchesTitle = (slug, info) => {
  const baseSlug = slug.replace(/-s\d{2}e\d{2}$/i, '');
  for (const title of [info.title, info.originalTitle].filter(Boolean)) {
    if (slugCandidates(title, info.kind === 'movie' ? info.year : undefined).has(baseSlug)) return true;
  }
  return false;
};

const HOSTER_RE = /voe|dood|streamtape|veev|vinovo|vidhide|mixdrop|supervideo|superplayer|uqload|filelion|lulustream|fastream|firestream|frstream|dropload|dr0pstream|savefiles|streamembed|vidara|vidsonic|vixeo|gxplayer|mxdrop/i;

export const filmpalast = {
  id: 'filmpalast',
  label: 'Filmpalast',
  kinds: ['movie', 'series'],

  async getEmbeds(info) {
    const cacheKey = `fp:${info.kind}:${info.tmdbId}:${info.season ?? ''}:${info.episode ?? ''}`;
    return cache.wrap(cacheKey, 30 * 60_000, async () => {
      const query = encodeURIComponent(info.title || info.originalTitle);
      const { text: searchHtml } = await fetchText(`${BASE}/search/title/${query}`, { timeoutMs: 8_000 });

      const links = [...searchHtml.matchAll(/href="\/\/filmpalast\.to\/(stream\/[^"]+)"/g)].map((m) => m[1]);
      const unique = [...new Set(links)];
      if (unique.length === 0) return [];

      const matching = unique.filter((l) => matchesTitle(l.replace(/^stream\//, ''), info));
      let chosen;
      if (info.kind === 'series') {
        if (info.season === undefined || info.episode === undefined) return [];
        const tag = `-s${String(info.season).padStart(2, '0')}e${String(info.episode).padStart(2, '0')}`;
        chosen = matching.find((l) => l.toLowerCase().endsWith(tag));
      } else {
        chosen = matching.find((l) => !/-s\d{2}e\d{2}$/i.test(l));
      }
      if (!chosen) return [];

      const pageUrl = `${BASE}/${chosen}`;
      const { text: pageHtml } = await fetchText(pageUrl, { timeoutMs: 8_000 });

      const embeds = [];
      const seen = new Set();
      const push = (url, hostName) => {
        if (!url || !url.startsWith('http') || seen.has(url)) return;
        if (!HOSTER_RE.test(url)) return;
        seen.add(url);
        embeds.push({ url, referer: pageUrl, hostLabel: hostName });
      };

      for (const block of pageHtml.matchAll(/<ul class="currentStreamLinks">([\s\S]*?)<\/ul>/g)) {
        const inner = block[1];
        const hostName = inner.match(/hostName"[^>]*>([^<]*)</)?.[1]?.trim();
        for (const pm of inner.matchAll(/data-player-url="(https?:[^"]+)"/g)) push(pm[1], hostName);
        for (const hm of inner.matchAll(/href="((?:https?:)?\/\/[^"]+)"/g)) {
          const url = hm[1].startsWith('//') ? `https:${hm[1]}` : hm[1];
          if (!/filmpalast\./.test(url)) push(url, hostName);
        }
      }
      return embeds;
    });
  },
};
