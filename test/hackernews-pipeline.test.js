import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { generateHackerNewsRSS } from '../src/ycombinatorGenerator.js';
import { fetchHackerNewsApiArticles } from '../src/hackerNewsApi.js';
import { articleCache, feedCache, buildFeedCacheKey, cacheKeys, getOrSet, clearAllCaches } from '../src/cache.js';
import { config } from '../src/config.js';

test('API fixture runs through untouched enrichment, links and both caches', async () => {
  clearAllCaches();
  const originalGet = axios.get;
  let originalFetches = 0, listFetches = 0;
  const p1 = 'A'.repeat(650), p2 = 'Second paragraph with enough meaningful text for the summary.', p3 = 'Third paragraph.', p4 = 'FOURTH MUST NOT APPEAR';
  axios.get = async (url, options) => {
    originalFetches++;
    assert.equal(url, 'https://example.org/path/article');
    assert.equal(options.timeout, 15000);
    return { data: Buffer.from(`<html><head><meta property="og:image" content="/lead.jpg"></head><body><article><p>${p1}</p><p>${p2}</p><p>${p3}</p><p>${p4}</p></article></body></html>`), headers: { 'content-type': 'text/html; charset=utf-8' } };
  };
  try {
    const loadArticles = () => fetchHackerNewsApiArticles({
      limit: 1, guidForItem: (_, { comments }) => comments,
      fetchJson: async url => {
        if (url.endsWith('topstories.json')) { listFetches++; return [42]; }
        return { id: 42, type: 'story', title: 'Fixture & title', url: 'https://example.org/path/article', by: 'alice', time: 1700000000 };
      },
    });
    const base = 'https://rss.protoyard.com';
    const key = buildFeedCacheKey(cacheKeys.hackerNewsFeed, base);
    const render = () => getOrSet(feedCache, key, () => generateHackerNewsRSS(base, { loadArticles }));
    const first = await render(), second = await render();
    assert.equal(first, second); assert.equal(listFetches, 1); assert.equal(originalFetches, 1);
    const $ = cheerio.load(first, { xmlMode: true });
    assert.equal($('item').length, 1);
    assert.equal($('item title').text(), 'Fixture & title');
    assert.equal($('item guid').text(), 'https://news.ycombinator.com/item?id=42');
    const html = $('item description').text();
    assert.ok(html.includes('https://example.org/lead.jpg'));
    assert.ok(html.includes('A'.repeat(597) + '...'));
    assert.ok(html.includes(p2)); assert.ok(html.includes(p3)); assert.ok(!html.includes(p4));
    assert.ok(html.includes('https://example.org/path/article'));
    assert.ok(html.includes('https://news.ycombinator.com/item?id=42'));
    // A separately scoped feed recomputes the feed but reuses the per-article cache.
    await generateHackerNewsRSS('https://second.example', { loadArticles });
    assert.equal(listFetches, 2); assert.equal(originalFetches, 1);
    assert.notEqual(key, buildFeedCacheKey(cacheKeys.hackerNewsFeed, 'https://second.example'));
    assert.equal(config.cache.feedTTL, 3600); assert.equal(config.cache.articleTTL, 3600);
    assert.ok(articleCache.has('hn-description:https://example.org/path/article'));
  } finally { axios.get = originalGet; clearAllCaches(); }
});

test('production default uses only official API for listing and does not cache transport failures', async () => {
  clearAllCaches();
  const originalFetch = globalThis.fetch, originalGet = axios.get;
  const seen = [];
  globalThis.fetch = async url => {
    seen.push(url);
    return { ok: true, json: async () => url.endsWith('topstories.json') ? [77] : { id:77, type:'story', title:'Default path', url:'https://example.org/default', time:1700000000 } };
  };
  axios.get = async url => {
    assert.equal(url, 'https://example.org/default');
    return { data: Buffer.from('<article><p>A full paragraph with enough characters to serve as an extracted summary.</p></article>'), headers: { 'content-type':'text/html' } };
  };
  try {
    const xml = await generateHackerNewsRSS('https://rss.protoyard.com');
    assert.ok(xml.includes('Default path'));
    assert.deepEqual(seen, ['https://hacker-news.firebaseio.com/v0/topstories.json','https://hacker-news.firebaseio.com/v0/item/77.json']);
    const key = buildFeedCacheKey(cacheKeys.hackerNewsFeed, 'https://failure.example');
    globalThis.fetch = async () => ({ ok:false, status:503 });
    await assert.rejects(getOrSet(feedCache, key, () => generateHackerNewsRSS('https://failure.example')), /503/);
    assert.equal(feedCache.has(key), false);
  } finally { globalThis.fetch = originalFetch; axios.get = originalGet; clearAllCaches(); }
});
