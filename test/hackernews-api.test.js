import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchHackerNewsApiArticles } from '../src/hackerNewsApi.js';
const items = {
  9: { id: 9, type: 'story', title: 'Original title', url: 'https://example.org/article', by: 'author', time: 1700000000 },
  2: { id: 2, type: 'job', title: 'Job title', time: 1700000100 },
  7: { id: 7, type: 'poll', title: 'Poll', time: 1700000200 },
};
const fixture = async url => url.endsWith('topstories.json') ? [9, 2, 7] : items[Number(url.match(/item\/(\d+)/)[1])];
const guidForItem = (_, { comments }) => comments;
test('uses approved 30-item maximum and stable discussion GUID by default', async () => {
  const requested = [];
  const fetchJson = async url => {
    if (url.endsWith('topstories.json')) return Array.from({length: 35}, (_, i) => i+1);
    const id = Number(url.match(/item\/(\d+)/)[1]); requested.push(id);
    return { id, type: 'story', title: `Item ${id}`, time: 1700000000, url: `https://example.org/${id}` };
  };
  const articles = await fetchHackerNewsApiArticles({ fetchJson });
  assert.equal(articles.length, 30); assert.equal(requested.length, 30);
  assert.equal(articles[29].guid, 'https://news.ycombinator.com/item?id=30');
  await assert.rejects(fetchHackerNewsApiArticles({ limit: 0 }), /limit/);
});
test('preserves source order, explicit count, title, date, author and links', async () => {
  const a = await fetchHackerNewsApiArticles({ limit: 2, guidForItem, fetchJson: fixture });
  assert.equal(a.length, 2);
  assert.deepEqual(a.map(x => x.title), ['Original title', 'Job title']);
  assert.equal(a[0].link, 'https://example.org/article');
  assert.equal(a[0].pubDate, new Date(1700000000000).toUTCString());
  assert.equal(a[0].comments, 'https://news.ycombinator.com/item?id=9');
  assert.equal(a[0].author, 'author');
  assert.equal(a[1].link, a[1].comments);
  assert.equal(a[1].guid, 'https://news.ycombinator.com/item?id=2');
  assert.deepEqual(Object.keys(a[0]), ['title','link','pubDate','author','guid','description','comments']);
});
test('rejects transport errors and skips missing upstream items', async () => {
  await assert.rejects(fetchHackerNewsApiArticles({ limit: 1, guidForItem, fetchJson: async () => { throw new Error('HTTP 503'); } }), /503/);
  const absent = await fetchHackerNewsApiArticles({ limit: 1, guidForItem, fetchJson: async url => url.endsWith('topstories.json') ? [9] : null });
  assert.deepEqual(absent, []);
});
test('bounded concurrency does not reorder returned stories', async () => {
  let active = 0, peak = 0;
  const fetchJson = async url => {
    if (url.endsWith('topstories.json')) return [9,2,7];
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, url.includes('/9.') ? 20 : 1));
    active--; return fixture(url);
  };
  const a = await fetchHackerNewsApiArticles({ limit: 3, concurrency: 2, guidForItem, fetchJson });
  assert.equal(peak, 2); assert.deepEqual(a.map(x => x.title), ['Original title','Job title','Poll']);
});
test('existing extraction, lead image, 3-paragraph summary, fallback and RSS output stay byte-for-byte unchanged', () => {
  const current = readFileSync(new URL('../src/ycombinatorGenerator.js', import.meta.url), 'utf8');
  const restored = current
    .replace("import { fetchArticle } from './fetcher.js';\nimport { fetchHackerNewsApiArticles } from './hackerNewsApi.js';", "import { fetchHackerNewsRSS, fetchArticle } from './fetcher.js';\nimport { parseRSSFeed } from './scraper.js';")
    .replace('export async function generateHackerNewsRSS(baseUrl, { loadArticles = fetchHackerNewsApiArticles } = {}) {', 'export async function generateHackerNewsRSS(baseUrl) {')
    .replace('    const articles = await loadArticles();', '    const originalRssXml = await fetchHackerNewsRSS();\n    const articles = parseRSSFeed(originalRssXml);');
  assert.equal(createHash('sha256').update(restored).digest('hex'), '4aa32c16e6bc73270b823e6f1392d68ab2515298ff49a2c6fe62d96fe67cc577');
});

test('skips deleted/dead/null items within selected IDs without refill or reordering', async () => {
  const requested = [];
  const fetchJson = async url => {
    if (url.endsWith('topstories.json')) return [9, 2, 7, 8, 10];
    const id = Number(url.match(/item\/(\d+)/)[1]); requested.push(id);
    return id === 2 ? { id, deleted: true } : id === 7 ? null : id === 8 ? { id, dead: true } : items[id];
  };
  const articles = await fetchHackerNewsApiArticles({ limit: 4, fetchJson });
  assert.equal(articles.length, 1); assert.equal(articles[0].title, 'Original title');
  assert.deepEqual(requested.sort((a,b)=>a-b), [2,7,8,9]);
});
