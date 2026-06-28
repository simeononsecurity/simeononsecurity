#!/usr/bin/env node
/**
 * Zero-dependency "Latest from the Blog" README updater.
 *
 * Requires Node 18+ (uses the global `fetch`).
 *
 * What it does:
 *   1. Fetches an RSS/Atom feed (FEED_URL).
 *   2. Takes the latest N items (POST_COUNT).
 *   3. For each item, resolves a cover/meta image in this order:
 *        a) <enclosure url="..."> (image type)
 *        b) <media:content> / <media:thumbnail> url
 *        c) an <img> embedded in content:encoded / description
 *        d) scrape the post page's <meta property="og:image"> (or twitter:image)
 *        e) a configurable fallback image
 *   4. Decodes HTML entities in titles and HTML-escapes everything it writes.
 *   5. Renders an N-column HTML <table> (each cell = linked cover image + linked
 *      bold title) and injects it between the BLOG-POST-LIST marker comments in
 *      README.md, only rewriting the content between the markers.
 *
 * Configuration (all optional, via environment variables):
 *   FEED_URL       - RSS/Atom feed URL      (default: simeononsecurity feed)
 *   POST_COUNT     - number of posts        (default: 8)
 *   COLUMNS        - table columns          (default: 4, i.e. a 4x2 grid)
 *   FALLBACK_IMAGE - image used if none found
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FEED_URL = process.env.FEED_URL || 'https://simeononsecurity.com/index.xml';
const POST_COUNT = parseInt(process.env.POST_COUNT || '8', 10);
const COLUMNS = parseInt(process.env.COLUMNS || '4', 10);
const FALLBACK_IMAGE =
  process.env.FALLBACK_IMAGE ||
  'https://simeononsecurity.com/img/transparentavatar.png';

const README_PATH = path.join(__dirname, '..', 'README.md');
const START_MARKER = '<!-- BLOG-POST-LIST:START -->';
const END_MARKER = '<!-- BLOG-POST-LIST:END -->';

const USER_AGENT =
  'Mozilla/5.0 (compatible; readme-blog-updater/1.0; +https://github.com/simeononsecurity)';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
};

/** Decode CDATA wrappers and HTML/XML entities into plain text. */
function decodeEntities(input) {
  if (!input) return '';
  let str = String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch (_) {
    return '';
  }
}

/** Escape a string for safe inclusion in HTML attributes/text. */
function htmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Read an attribute value from a single tag string. */
function getAttr(tag, name) {
  const dq = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
  if (dq) return dq[1];
  const sq = tag.match(new RegExp(name + "\\s*=\\s*'([^']*)'", 'i'));
  return sq ? sq[1] : '';
}

/** Return the inner text of the first <tag>...</tag> within a block. */
function firstTagContent(block, tag) {
  const m = block.match(
    new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i')
  );
  return m ? m[1] : '';
}

/** Resolve a possibly-relative URL against a base. */
function absolutize(url, base) {
  if (!url) return url;
  try {
    return new URL(url, base).toString();
  } catch (_) {
    return url;
  }
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

/** Split a feed into raw <item> (RSS) or <entry> (Atom) blocks. */
function extractEntries(xml) {
  const blocks = [];
  let m;
  const itemRe = /<item\b[\s\S]*?<\/item>/gi;
  while ((m = itemRe.exec(xml)) !== null) blocks.push(m[0]);
  if (blocks.length === 0) {
    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    while ((m = entryRe.exec(xml)) !== null) blocks.push(m[0]);
  }
  return blocks;
}

function getTitle(block) {
  return decodeEntities(firstTagContent(block, 'title'));
}

function getLink(block) {
  // RSS: <link>https://...</link>
  const rss = decodeEntities(firstTagContent(block, 'link')).trim();
  if (rss) return rss;
  // Atom: <link rel="alternate" href="https://..."/> (prefer alternate/no-rel)
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (const tag of links) {
    const rel = getAttr(tag, 'rel');
    const href = getAttr(tag, 'href');
    if (!href) continue;
    if (!rel || rel.toLowerCase() === 'alternate') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

/** Try to resolve an image from the feed entry XML itself (steps a-c). */
function imageFromEntry(block) {
  // a) <enclosure url="..." type="image/...">
  const enc = block.match(/<enclosure\b[^>]*>/i);
  if (enc) {
    const url = getAttr(enc[0], 'url');
    const type = getAttr(enc[0], 'type');
    if (url && (!type || /^image\//i.test(type))) return url;
  }

  // b) <media:content url="..."> / <media:thumbnail url="...">
  const mediaContent = block.match(/<media:content\b[^>]*>/i);
  if (mediaContent) {
    const url = getAttr(mediaContent[0], 'url');
    const medium = getAttr(mediaContent[0], 'medium');
    const type = getAttr(mediaContent[0], 'type');
    if (url && (!medium || /image/i.test(medium)) && (!type || /^image\//i.test(type))) {
      return url;
    }
  }
  const mediaThumb = block.match(/<media:thumbnail\b[^>]*>/i);
  if (mediaThumb) {
    const url = getAttr(mediaThumb[0], 'url');
    if (url) return url;
  }

  // c) first <img src="..."> inside content:encoded / description / content / summary
  const content =
    firstTagContent(block, 'content:encoded') ||
    firstTagContent(block, 'description') ||
    firstTagContent(block, 'content') ||
    firstTagContent(block, 'summary');
  if (content) {
    const decoded = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const img = decoded.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    if (img) return img[1];
  }

  return '';
}

/** Step d) scrape the post page for og:image / twitter:image. */
async function imageFromPage(pageUrl) {
  if (!pageUrl) return '';
  try {
    const html = await fetchText(pageUrl);
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (const tag of metas) {
      const key = (getAttr(tag, 'property') || getAttr(tag, 'name')).toLowerCase();
      if (key === 'og:image' || key === 'og:image:url' ||
          key === 'twitter:image' || key === 'twitter:image:src') {
        const content = getAttr(tag, 'content');
        if (content) return content;
      }
    }
  } catch (err) {
    console.warn(`  ! og:image scrape failed for ${pageUrl}: ${err.message}`);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Rendering & injection
// ---------------------------------------------------------------------------

function buildTable(posts, columns) {
  const colWidth = Math.max(1, Math.floor(100 / columns));
  const lines = ['<table>', '<tr>'];
  posts.forEach((post, index) => {
    const title = htmlEscape(post.title);
    const link = htmlEscape(post.link);
    const image = htmlEscape(post.image);
    // IMPORTANT: keep every <td> on a single, un-indented line. GitHub's
    // Markdown pipeline silently drops subsequent <tr> rows when raw-HTML
    // table cells span multiple indented lines, so a multi-row grid only
    // renders reliably when each cell is emitted compactly.
    lines.push(
      `<td align="center" valign="top" width="${colWidth}%">` +
        `<a href="${link}"><img src="${image}" alt="${title}" width="100%"></a>` +
        `<br><a href="${link}"><b>${title}</b></a>` +
        '</td>'
    );
    const isRowEnd = (index + 1) % columns === 0;
    const isLast = index === posts.length - 1;
    if (isRowEnd && !isLast) {
      lines.push('</tr>', '<tr>');
    }
  });
  lines.push('</tr>', '</table>');
  return lines.join('\n');
}

function injectIntoReadme(tableHtml) {
  const readme = fs.readFileSync(README_PATH, 'utf8');
  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      `Could not find markers "${START_MARKER}" / "${END_MARKER}" in README.md`
    );
  }
  const before = readme.slice(0, startIdx + START_MARKER.length);
  const after = readme.slice(endIdx);
  const updated = `${before}\n${tableHtml}\n${after}`;
  if (updated === readme) {
    console.log('README.md already up to date; no changes written.');
    return;
  }
  fs.writeFileSync(README_PATH, updated);
  console.log('README.md blog grid updated.');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fetching feed: ${FEED_URL}`);
  const xml = await fetchText(FEED_URL);

  const entries = extractEntries(xml).slice(0, POST_COUNT);
  if (entries.length === 0) {
    throw new Error('No <item>/<entry> elements found in the feed.');
  }

  const posts = [];
  for (const block of entries) {
    const title = getTitle(block) || 'Untitled';
    const link = getLink(block);

    let image = imageFromEntry(block);
    if (!image) image = await imageFromPage(link);
    if (!image) image = FALLBACK_IMAGE;
    image = absolutize(image, link || FEED_URL);

    posts.push({ title, link, image });
    console.log(`  - ${title}\n      ${image}`);
  }

  const tableHtml = buildTable(posts, COLUMNS);
  injectIntoReadme(tableHtml);
}

main().catch((err) => {
  console.error(`Failed to update README: ${err.stack || err.message}`);
  process.exit(1);
});
