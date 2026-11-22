import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, catalogCandidates, postIdentity, catalogTitle } from '../src/sources/xcine.js';

test('sitemap rejects unrelated origins, paths, and duplicates', () => {
 const xml='<urlset><loc>https://xcine.hair/25522-babylon-berlin-stream-deutsch-kostenlos.html</loc><loc>https://evil.test/1-other.html</loc><loc>https://xcine.hair/25522-babylon-berlin-stream-deutsch-kostenlos.html</loc></urlset>';
 assert.equal(parseSitemap(xml).length,1);
});
test('season and legacy suffixes reduce to title hints', () => {
 assert.equal(catalogTitle('https://xcine.hair/5085-dark-staffel-1-serien-stream.html'),'dark');
 assert.equal(catalogTitle('https://xcine.hair/1-kleo-hd-kostenlos.html'),'kleo');
});
test('exact title ranks ahead of prefix, unrelated titles excluded', () => {
 const e=[{url:'a',title:'darkmatter'},{url:'b',title:'dark'},{url:'c',title:'babylonberlin'}];
 assert.deepEqual(catalogCandidates(e,{title:'Dark'}).map(x=>x.url),['b','a']);
 assert.deepEqual(catalogCandidates(e,{title:'It'}),[]);
});
test('umlaut title transliterations match site slugs', () => {
 const e=[{url:'a',title:'fackjugoehte'}];
 assert.equal(catalogCandidates(e,{title:'Fack ju Göhte'}).length,1);
});
test('only actual embedded identity can confirm a post', () => {
 assert.equal(postIdentity("var rawId = ('tt4378376' || '').trim();"),'tt4378376');
 assert.equal(postIdentity("var rawId = ('4378376' || '').trim();"),'tt4378376');
 assert.equal(postIdentity('<title>tt4378376</title>'),null);
});
