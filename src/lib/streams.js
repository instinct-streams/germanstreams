// Turn resolved URLs into Stremio stream objects.
export const toStremioStream = ({ resolved, embed, info, sourceLabel }) => {
  const quality = resolved.height ? `${resolved.height}p` : resolved.format === 'hls' ? 'HD' : '';
  const stream = {
    name: `GermanStreams\n🇩🇪 ${sourceLabel} · ${resolved.resolverLabel}`,
    title: `${embed.titleHint ?? info.displayTitle}\n🇩🇪 German · ${resolved.format.toUpperCase()}${quality ? ` · ${quality}` : ''}`,
    url: resolved.url,
    behaviorHints: {},
  };
  if (resolved.headers) {
    stream.behaviorHints.proxyHeaders = { request: resolved.headers };
  }
  if (resolved.format === 'hls') {
    stream.behaviorHints.notWebReady = false;
  }
  return stream;
};
