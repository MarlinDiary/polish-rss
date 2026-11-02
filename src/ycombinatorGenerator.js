import RSS from 'rss';
import * as cheerio from 'cheerio';
import { config } from './config.js';
import { fetchArticle } from './fetcher.js';
import { fetchHackerNewsApiArticles } from './hackerNewsApi.js';
import { articleCache, getOrSet } from './cache.js';

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return 'source';
  }
}

function resolveUrl(candidate, pageUrl) {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith('data:')) {
    return null;
  }

  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`;
  }

  try {
    return new URL(trimmed, pageUrl).href;
  } catch (error) {
    return trimmed;
  }
}

function pickFromSrcset(value, pageUrl) {
  if (!value) {
    return null;
  }

  const firstPart = value.split(',')[0];
  if (!firstPart) {
    return null;
  }

  const urlCandidate = firstPart.trim().split(/\s+/)[0];
  return resolveUrl(urlCandidate, pageUrl);
}

function extractLeadImage($, pageUrl) {
  const metaSelectors = [
    'meta[property="og:image"]',
    'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]',
    'meta[name="image"]',
  ];

  for (const selector of metaSelectors) {
    const content = $(selector).attr('content');
    const resolved = resolveUrl(content, pageUrl);
    if (resolved) {
      return resolved;
    }
  }

  const imgAttributes = ['src', 'data-src', 'data-original', 'data-url', 'data-srcset', 'srcset'];

  const images = $('picture source, article img, main img, img');
  for (const element of images.toArray()) {
    const $element = $(element);

    for (const attr of imgAttributes) {
      const candidate = $element.attr(attr);
      let resolved = null;

      if (attr === 'srcset' || attr === 'data-srcset') {
        resolved = pickFromSrcset(candidate, pageUrl);
      } else {
        resolved = resolveUrl(candidate, pageUrl);
      }

      if (resolved) {
        return resolved;
      }
    }
  }

  return null;
}

function collectSummaryParagraphs($) {
  const selectors = [
    'article p',
    'main p',
    '[class*="content"] p',
    '[class*="Article"] p',
    '[class*="body"] p',
    'p',
  ];

  const paragraphs = [];
  const seen = new Set();

  for (const selector of selectors) {
    const elements = $(selector);
    if (!elements.length) {
      continue;
    }

    for (const element of elements.toArray()) {
      if (paragraphs.length >= 3) {
        break;
      }

      const text = $(element).text().replace(/\s+/g, ' ').trim();
      if (!text || seen.has(text)) {
        continue;
      }

      if (text.length < 40 && paragraphs.length === 0) {
        continue;
      }

      seen.add(text);
      paragraphs.push(text);
    }

    if (paragraphs.length >= 3) {
      break;
    }
  }

  return paragraphs;
}

function extractSummaryData(html, pageUrl) {
  const $ = cheerio.load(html);

  const paragraphs = collectSummaryParagraphs($);

  const metaDescription =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="twitter:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';

  if (!paragraphs.length && metaDescription) {
    paragraphs.push(metaDescription.trim());
  }

  const deduped = [];
  const seen = new Set();
  for (const paragraph of paragraphs) {
    const normalized = paragraph.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized.length > 600 ? `${normalized.slice(0, 597)}...` : normalized);
  }

  const imageUrl = extractLeadImage($, pageUrl);

  return {
    paragraphs: deduped,
    imageUrl,
  };
}

function buildBeautifiedDescription(article, summaryData) {
  const parts = [];

  if (summaryData.imageUrl) {
    parts.push(
      `<p><img src="${escapeHtml(summaryData.imageUrl)}" alt="Preview image" /></p>`
    );
  }

  if (summaryData.paragraphs.length) {
    summaryData.paragraphs.forEach(paragraph => {
      parts.push(`<p>${escapeHtml(paragraph)}</p>`);
    });
  } else {
    parts.push('<p>We could not extract a summary, please visit the original article.</p>');
  }

  const hostname = safeHostname(article.link);
  parts.push(
    `<p><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">Read the original on ${escapeHtml(hostname)}</a></p>`
  );

  if (article.comments) {
    parts.push(
      `<p><a href="${escapeHtml(article.comments)}" target="_blank" rel="noopener noreferrer">Join the discussion on Hacker News</a></p>`
    );
  }

  return parts.join('\n');
}

function buildFallbackDescription(article) {
  const parts = [];
  const cleanedDescription = (article.description || '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();

  if (cleanedDescription) {
    parts.push(cleanedDescription);
  }

  parts.push(
    `<p><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">Read the original article</a></p>`
  );

  if (article.comments) {
    parts.push(
      `<p><a href="${escapeHtml(article.comments)}" target="_blank" rel="noopener noreferrer">Join the discussion on Hacker News</a></p>`
    );
  }

  return parts.join('\n');
}

async function getBeautifiedDescription(article) {
  const cacheKey = `hn-description:${article.link}`;
  return getOrSet(articleCache, cacheKey, async () => {
    try {
      const html = await fetchArticle(article.link, {
        headers: {
          Referer: config.hackernews.baseUrl,
        },
        timeout: 15000,
      });

      const summaryData = extractSummaryData(html, article.link);
      return buildBeautifiedDescription(article, summaryData);
    } catch (error) {
      console.error(`Failed to enrich Hacker News article ${article.link}:`, error.message);
      return buildFallbackDescription(article);
    }
  });
}

export async function generateHackerNewsRSS(baseUrl, { loadArticles = fetchHackerNewsApiArticles } = {}) {
  try {
    const articles = await loadArticles();

    console.log(`Found ${articles.length} articles in Hacker News RSS feed`);

    const feed = new RSS({
      title: 'Hacker News - Beautified Feed',
      description: 'Beautified summaries with lead images for Hacker News stories',
      feed_url: `${baseUrl}/ycombinator`,
      site_url: config.hackernews.baseUrl,
      language: 'en-US',
      pubDate: new Date(),
      ttl: 15,
    });

    const articlePromises = articles.map(async (article) => {
      try {
        const description = await getBeautifiedDescription(article);

        return {
          title: article.title,
          description,
          url: article.link,
          guid: article.guid || article.link,
          date: article.pubDate ? new Date(article.pubDate) : new Date(),
          author: article.author,
        };
      } catch (error) {
        console.error(`Failed to process article ${article.link}:`, error.message);
        return {
          title: article.title,
          description: buildFallbackDescription(article),
          url: article.link,
          guid: article.guid || article.link,
          date: article.pubDate ? new Date(article.pubDate) : new Date(),
          author: article.author,
        };
      }
    });

    const enrichedArticles = await Promise.all(articlePromises);

    enrichedArticles.forEach(article => {
      feed.item(article);
    });

    console.log('Hacker News RSS feed generated successfully');
    return feed.xml({ indent: true });
  } catch (error) {
    console.error('Error generating Hacker News RSS feed:', error.message);
    throw error;
  }
}
