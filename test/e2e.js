// Dev harness: exercises sources + resolvers with known title mappings (no TMDB calls).
import { SOURCES } from '../src/sources/index.js';
import { resolveEmbed, hasResolver } from '../src/resolvers/index.js';

const cases = [
  { name: 'Das Boot (movie)', info: { kind: 'movie', tmdbId: 387, imdbId: 'tt0082096', title: 'Das Boot', originalTitle: 'Das Boot', year: 1981, displayTitle: 'Das Boot (1981)' } },
  { name: 'Fack ju Göhte (movie)', info: { kind: 'movie', tmdbId: 235263, imdbId: 'tt2987732', title: 'Fack ju Göhte', originalTitle: 'Fack ju Göhte', year: 2013, displayTitle: 'Fack ju Göhte (2013)' } },
  { name: 'Dark S01E01 (series)', info: { kind: 'series', tmdbId: 70523, imdbId: 'tt5753856', title: 'Dark', originalTitle: 'Dark', season: 1, episode: 1, displayTitle: 'Dark S01E01' } },
];

for (const { name, info } of cases) {
  console.log(`\n=== ${name}`);
  const t0 = Date.now();
  const perSource = await Promise.allSettled(
    SOURCES.filter((s) => s.kinds.includes(info.kind)).map(async (s) => ({ source: s, embeds: await s.getEmbeds(info) })),
  );
  for (const r of perSource) {
    if (r.status === 'rejected') { console.log('  source error:', r.reason?.message); continue; }
    const { source, embeds } = r.value;
    console.log(`  ${source.label}: ${embeds.length} embeds`);
    for (const e of embeds) {
      const supported = hasResolver(e.url);
      console.log(`    [${supported ? 'x' : ' '}] ${e.url}`);
      if (!supported) continue;
      const resolved = await resolveEmbed(e);
      for (const s of resolved) console.log(`      -> ${s.format} ${s.height ?? ''} ${s.url.slice(0, 110)}`);
    }
  }
  console.log(`  (${Date.now() - t0}ms)`);
}
