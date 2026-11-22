// Playback compatibility and Filmo source. No paid services or third-party runtimes.
import { createHmac, timingSafeEqual, createDecipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fetchResponse, fetchText, fetchJson, postJson, USER_AGENT } from './lib/http.js';
import { TtlCache } from './lib/cache.js';
import { resolveEmbed as originalResolve } from './resolvers/index.js';

const cache = new TtlCache();
const FILMO = 'https://filmo.to';
const unescapeHtml = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([a-f0-9]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const norm = (s) => unescapeHtml(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '');
const attr = (s, name) => s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const plain = (s) => unescapeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export const filmo = {
  id: 'filmo', label: 'Filmo', kinds: ['movie'],
  async getEmbeds(info) {
    return cache.wrap(`filmo:${info.imdbId ?? info.tmdbId}`, 20 * 60_000, async () => {
      const titles = [info.title, info.originalTitle].filter(Boolean);
      const targets = new Set(titles.map(norm));
      let candidates = [];
      for (const title of [...new Set(titles)]) {
        const { text: search } = await fetchText(`${FILMO}/search?q=${encodeURIComponent(title)}`, { timeoutMs: 5000 });
        for (const match of search.matchAll(/<a\b([^>]*href="[^"]*\/movies\/[^"?#]+"[^>]*)>([\s\S]*?)<\/a>/g)) {
          const titleText = match[2].match(/class="[^"]*__title[^"]*"[^>]*>([\s\S]*?)<\//)?.[1];
          if (!titleText || !targets.has(norm(plain(titleText)))) continue;
          const href = attr(match[1], 'href');
          if (href) candidates.push(new URL(unescapeHtml(href), FILMO).href);
        }
        if (candidates.length) break;
      }
      for (const pageUrl of [...new Set(candidates)].slice(0, 3)) {
        if (new URL(pageUrl).origin !== FILMO) continue;
        const response = await fetchResponse(pageUrl, { timeoutMs: 5000 });
        if (!response.ok) continue;
        const html = await response.text();
        const title = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '');
        if (!targets.has(norm(title))) continue;
        const releaseYear = html.match(/Erscheinungsdatum[\s\S]{0,500}?(\d{4})-/)?.[1];
        if (info.year && Number(releaseYear) !== info.year) continue;
        const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        const xsrf = cookie.match(/(?:^|; )XSRF-TOKEN=([^;]+)/)?.[1];
        if (!xsrf) continue;
        const headers = { Cookie: cookie, 'X-XSRF-TOKEN': decodeURIComponent(xsrf), Referer: pageUrl };
        const chips = [...html.matchAll(/<[^>]+class="[^"]*provider-chip[^>]*>/g)].map((m) => m[0]);
        const found = await Promise.all(chips.filter((chip) => /Byse/i.test(attr(chip, 'aria-label') ?? '')).map(async (chip) => {
          try {
            const p = attr(chip, 'data-p');
            if (!p) return null;
            const { json } = await postJson(`${FILMO}/n`, { p: unescapeHtml(p) }, { headers, timeoutMs: 5000 });
            if (!/^[a-zA-Z0-9_-]+$/.test(json.x ?? '')) return null;
            const { text, finalUrl } = await fetchText(`${FILMO}/n/${json.x}`, { headers, timeoutMs: 5000 });
            const embedUrl = new URL(finalUrl).origin === FILMO
              ? unescapeHtml(text.match(/<a\b[^>]*class="open"[^>]*href="([^"]+)"/)?.[1] ?? '')
              : finalUrl;
            if (!/^https:\/\/[^/]*byse[^/]*\/(?:d|e)\/[a-z0-9]+/i.test(embedUrl)) return null;
            return { url: embedUrl, referer: pageUrl, hostLabel: 'Byse' };
          } catch { return null; }
        }));
        return found.filter(Boolean);
      }
      return [];
    });
  },
};

export const supportsExtra = (url) => /https:\/\/[^/]*byse[^/]*\/(?:d|e)\//i.test(url);
const byse = async ({ url }) => cache.wrap(`byse:${url}`, 5 * 60_000, async () => {
  const u = new URL(url);
  const code = u.pathname.split('/').filter(Boolean)[1];
  if (!/^[a-z0-9]+$/i.test(code ?? '')) return [];
  const { json } = await fetchJson(`${u.origin}/api/videos/${code}`, { headers: { Referer: url }, timeoutMs: 6000 });
  const p = json.playback;
  if (!p || !Array.isArray(p.key_parts)) return [];
  // The ordinary player receives both the encrypted response and its key parts.
  const version = Number(p.version);
  const indexes = version >= 1 && version <= 20 ? [version - 1, 30 - version] : [];
  const parts = indexes.length && indexes.every((i) => i < p.key_parts.length)
    ? indexes.map((i) => p.key_parts[i]) : p.key_parts;
  const key = Buffer.concat(parts.map((part) => Buffer.from(part, 'base64url')));
  if (key.length !== 32) return [];
  const payload = Buffer.from(p.payload, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'base64url'));
  decipher.setAuthTag(payload.subarray(-16));
  const data = JSON.parse(Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]));
  return (data.sources ?? []).filter((s) => typeof s.url === 'string' && s.url.startsWith('https://')).map((s) => ({
    url: s.url, format: /mpegurl|m3u8/.test(s.mime_type + s.url) ? 'hls' : 'mp4', height: s.height,
    headers: { Referer: `${u.origin}/`, 'User-Agent': USER_AGENT }, resolverLabel: 'Byse', relay: true,
  }));
});

export const resolveUpgraded = async (embed) => {
  try {
    if (supportsExtra(embed.url)) return await byse(embed);
    let streams = await originalResolve(embed);
    if (/mixdrop|mxdrop|dr0pstream|dropload/i.test(embed.url)) streams = streams.map((s) => ({ ...s, relay: true }));
    if (/gxplayer/i.test(embed.url)) return streams.map((s) => ({ ...s, relay: true }));
    if (/dr0pstream|dropload|superplayer|supervideo/i.test(embed.url)) {
      return await Promise.all(streams.map(async (s) => cache.wrap(`rendition:${s.url}`, 15 * 60_000, async () => {
        try {
          const { text, finalUrl } = await fetchText(s.url, { headers: s.headers, timeoutMs: 2500 });
          const variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]+)\r?\n([^#\s][^\r\n]*)/g)];
          // A single rendition is common here. Skip the extra master request in the player.
          if (variants.length !== 1) return s;
          const height = Number(variants[0][1].match(/RESOLUTION=\d+x(\d+)/)?.[1]) || s.height;
          return { ...s, url: new URL(variants[0][2].trim(), finalUrl).href, height };
        } catch { return s; }
      })));
    }
    return streams;
  } catch { return []; }
};

// Some hosts bind their URLs to the server network and require a relay.
// GXPlayer serves HLS as .txt and TS as .html/font, which native players reject.
// Normalize playlists and media MIME types. Only signed, short-lived host URLs are
// accepted, never arbitrary destinations. Video is streamed, never buffered in RAM.
const relayKey = process.env.TMDB_ACCESS_TOKEN || randomBytes(32);
const allowed = (url) => {
  const u = new URL(url);
  return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
    (/^(?:watch|s\d+)\.gxplayer\.xyz$/.test(u.hostname) || /^[a-z0-9-]+\.(?:owphbf24\.com|dropcdn\.io|mxcontent\.net)$/.test(u.hostname)) && /^\/(?:hls2|m3u8|stream|ts|v2)\//.test(u.pathname);
};
const signature = (value) => createHmac('sha256', relayKey).update(value).digest('base64url');
export const playbackUrl = (url, base, kind = 'playlist', referer = 'https://watch.gxplayer.xyz/') => {
  if (!allowed(url)) throw new Error('unsupported playback host');
  const value = Buffer.from(JSON.stringify({ u: url, k: kind, r: referer, e: Math.floor(Date.now() / 1000) + 43200 })).toString('base64url');
  return `${base}/play/${value}.${signature(value)}/${kind === 'playlist' ? 'index.m3u8' : kind === 'key' ? 'key.bin' : kind === 'mp4' ? 'video.mp4' : 'segment.ts'}`;
};
const relayFetch = async (url, headers) => {
  let current = url;
  for (let n = 0; n < 5; n++) {
    if (!allowed(current)) throw new Error('unsupported redirect');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let r;
    try { r = await fetch(current, { headers, redirect: 'manual', signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (![301, 302, 303, 307, 308].includes(r.status)) return r;
    const next = r.headers.get('location');
    if (!next) return r;
    await r.body?.cancel();
    current = new URL(next, current).href;
  }
  throw new Error('redirect limit');
};
export const handlePlayback = async (req, res, base) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!path.startsWith('/play/')) return false;
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return true; }
    const ticket = path.split('/')[2];
    if (!ticket || ticket.length > 12000) throw new Error('invalid ticket');
    const [value, sig] = ticket.split('.');
    const expected = Buffer.from(signature(value));
    const given = Buffer.from(sig ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('invalid signature');
    const data = JSON.parse(Buffer.from(value, 'base64url'));
    if (data.e < Date.now() / 1000 || !allowed(data.u) || !['playlist', 'segment', 'key', 'mp4'].includes(data.k)) throw new Error('expired ticket');
    const headers = { Referer: data.r || 'https://watch.gxplayer.xyz/', 'User-Agent': USER_AGENT };
    if (req.headers.range && /^bytes=\d*-\d*$/.test(req.headers.range)) headers.Range = req.headers.range;
    const upstream = await relayFetch(data.u, headers);
    if (!upstream.ok) { res.writeHead(upstream.status, { 'Access-Control-Allow-Origin': '*' }); res.end(); return true; }
    if (data.k === 'playlist') {
      const text = await upstream.text();
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('invalid upstream playlist');
      const rewritten = text.split(/\r?\n/).map((line) => {
        if (!line.trim()) return line;
        if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${playbackUrl(new URL(uri, data.u).href, base, /#EXT-X-KEY/.test(line) ? 'key' : 'playlist', data.r)}"`);
        const child = new URL(line.trim(), data.u).href;
        const kind = /\.m3u8(?:\?|$)|\/stream\//.test(child) ? 'playlist' : 'segment';
        return playbackUrl(child, base, kind, data.r);
      }).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
      res.end(req.method === 'HEAD' ? '' : rewritten);
    } else {
      const outHeaders = { 'Content-Type': data.k === 'key' ? 'application/octet-stream' : data.k === 'mp4' ? 'video/mp4' : 'video/mp2t', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=600' };
      for (const h of ['content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(h)) outHeaders[h] = upstream.headers.get(h);
      res.writeHead(upstream.status, outHeaders);
      if (req.method === 'HEAD') { await upstream.body?.cancel(); res.end(); }
      else {
        const body = Readable.fromWeb(upstream.body);
        res.on('close', () => body.destroy());
        body.on('error', () => res.destroy());
        body.pipe(res);
      }
    }
  } catch { if (!res.headersSent) res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end(); }
  return true;
};
