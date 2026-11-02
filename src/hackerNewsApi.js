// Official HN API adapter: preserve the approved top-30 scope and stable discussion IDs.
const API_BASE = 'https://hacker-news.firebaseio.com/v0';
const discussionUrl = id => `https://news.ycombinator.com/item?id=${id}`;
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function fetchHackerNewsApiArticles({
  // User approved this scope/identity on 2026-11-02; no refill beyond these IDs.
  limit = 30,
  guidForItem = (_, { comments }) => comments,
  fetchJson = async url => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HN API returned HTTP ${response.status}`);
    return response.json();
  },
  concurrency = 4,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Verified HN feed item limit is required (1–500)');
  if (typeof guidForItem !== 'function') throw new Error('Verified historical HN GUID mapping is required');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid concurrency');
  const ids = await fetchJson(`${API_BASE}/topstories.json`);
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) throw new Error('Invalid HN topstories response');
  const selected = ids.slice(0, limit);
  const results = new Array(selected.length);
  let cursor = 0;
  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      const id = selected[index];
      const item = await fetchJson(`${API_BASE}/item/${id}.json`);
      // Deleted/null items are expected upstream churn: skip without expanding the list.
      if (item === null || item?.deleted || item?.dead) continue;
      // Transport failures still reject the snapshot and are never cached as success.
      if (!item || item.id !== id || !['story', 'job', 'poll'].includes(item.type) || typeof item.title !== 'string' || !Number.isSafeInteger(item.time)) throw new Error(`HN item ${id} invalid`);
      const comments = discussionUrl(id);
      const link = item.url || comments;
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsafe HN item URL for ${id}`);
      const guid = guidForItem(item, { link, comments });
      if (typeof guid !== 'string' || !guid) throw new Error(`Invalid HN GUID for ${id}`);
      results[index] = {
        title: item.title, link, pubDate: new Date(item.time * 1000).toUTCString(),
        author: item.by || '', guid,
        description: `<a href="${escapeHtml(comments)}">Comments</a>`, comments,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, worker));
  return results.filter(Boolean);
}
