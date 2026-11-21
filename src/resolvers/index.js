// Host resolvers: turn a hoster embed URL into playable stream URL(s).
// Each resolver returns [{ url, format ('hls'|'mp4'), headers, height, titleHint }].
import { fetchText, postJson } from '../lib/http.js';
import { unpackAllFromHtml } from '../lib/unpack.js';
import { TtlCache } from '../lib/cache.js';

const cache = new TtlCache();
const RESOLVED_TTL = 20 * 60_000; // signed URLs live for hours; keep it short anyway

// --- dropload / dr0pstream and supervideo/superplayer: packed JS with sources:[{file:"..."}]
const packedHls = async ({ url, referer }, label) => {
  const { text: html, finalUrl } = await fetchText(url, {
    headers: referer ? { Referer: referer } : {},
    timeoutMs: 9_000,
  });
  if (/File Not Found|Pending in queue|The file was deleted|The file expired|Video is processing/.test(html)) {
    return [];
  }
  const unpacked = unpackAllFromHtml(html);
  const m3u8 = unpacked.match(/sources:\s*\[\{file:\s*"(https?:[^"]+?\.m3u8[^"]*)"/)?.[1];
  if (!m3u8) return [];
  const origin = new URL(finalUrl).origin;
  const heightMatch = html.match(/\d{3,}x(\d{3,}),/);
  return [
    {
      url: m3u8,
      format: 'hls',
      headers: { Referer: `${origin}/` },
      height: heightMatch ? parseInt(heightMatch[1], 10) : undefined,
      resolverLabel: label,
    },
  ];
};

// --- gxplayer (watch.gxplayer.xyz): inline `video` JSON; HLS playlist is derived.
const gxplayer = async ({ url, referer }) => {
  const { text: html, finalUrl } = await fetchText(url, {
    headers: referer ? { Referer: referer } : {},
    timeoutMs: 9_000,
  });
  const videoRaw = html.match(/var\s+video\s*=\s*(\{[\s\S]*?\});\s*\n/)?.[1];
  if (!videoRaw) return [];
  let video;
  try {
    video = JSON.parse(videoRaw);
  } catch {
    return [];
  }
  if (!video.uid || !video.md5 || !video.id) return [];
  const origin = new URL(finalUrl).origin;
  const playlist = `${origin}/m3u8/${video.uid}/${video.md5}/master.txt?s=1&id=${video.id}&cache=${video.status ?? 1}`;
  return [
    {
      url: playlist,
      format: 'hls',
      headers: { Referer: `${origin}/` },
      height: 720,
      resolverLabel: 'GXPlayer',
    },
  ];
};

// --- firestream (firestream.to -> frstream.life): POST /api/videos/{slug}/resolve with token blob.
const firestream = async ({ url, referer }) => {
  const { text: html, finalUrl } = await fetchText(url, {
    headers: referer ? { Referer: referer } : {},
    timeoutMs: 9_000,
  });
  const blob = html.match(/id="token-blob"[^>]*>([^<]+)</)?.[1]?.trim();
  const slug = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
  if (!blob || !slug) return [];
  const origin = new URL(finalUrl).origin;
  const { json } = await postJson(
    `${origin}/api/videos/${encodeURIComponent(slug)}/resolve`,
    { blob },
    { headers: { Referer: finalUrl }, timeoutMs: 9_000 },
  );
  const signed = json?.signedVideoUrl ?? json?.signedVideoMp4Url;
  if (!signed) return [];
  return [
    {
      url: signed,
      format: (json.playbackFormat === 'hls' || signed.includes('.m3u8')) ? 'hls' : 'mp4',
      height: 1080,
      resolverLabel: 'Firestream',
    },
  ];
};

// --- mixdrop (mxdrop.*): packed JS with MDCore.wurl (direct mp4).
const mixdrop = async ({ url, referer }) => {
  const { text: html, finalUrl } = await fetchText(url, {
    headers: referer ? { Referer: referer } : {},
    timeoutMs: 9_000,
  });
  const unpacked = unpackAllFromHtml(html) || html;
  const wurl = unpacked.match(/MDCore\.wurl\s*=\s*"([^"]+)"/)?.[1];
  if (!wurl) return [];
  const direct = wurl.startsWith('//') ? `https:${wurl}` : wurl;
  const origin = new URL(finalUrl).origin;
  return [
    {
      url: direct,
      format: 'mp4',
      headers: { Referer: `${origin}/` },
      resolverLabel: 'Mixdrop',
    },
  ];
};

const RESOLVERS = [
  { re: /dropload|dr0pstream/i, label: 'Dropload', run: (e) => packedHls(e, 'Dropload') },
  { re: /supervideo|superplayer/i, label: 'SuperVideo', run: (e) => packedHls(e, 'SuperVideo') },
  { re: /gxplayer/i, label: 'GXPlayer', run: gxplayer },
  { re: /firestream|frstream/i, label: 'Firestream', run: firestream },
  { re: /mixdrop|mxdrop/i, label: 'Mixdrop', run: mixdrop },
];

export const resolveEmbed = async (embed) => {
  const resolver = RESOLVERS.find((r) => r.re.test(embed.url));
  if (!resolver) return [];
  return cache.wrap(`resolve:${embed.url}`, RESOLVED_TTL, async () => {
    try {
      const streams = await resolver.run(embed);
      return streams.map((s) => ({ ...s, resolverLabel: s.resolverLabel ?? resolver.label }));
    } catch {
      return [];
    }
  });
};

export const hasResolver = (url) => RESOLVERS.some((r) => r.re.test(url));
