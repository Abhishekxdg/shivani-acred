/**
 * Web access for the agent, powered by a REAL headless Chromium (see browser.ts)
 * — no paid search APIs. webSearch drives DuckDuckGo (Bing fallback) and reads
 * the results off the rendered DOM; webFetch opens a page and returns the text
 * the browser actually rendered (so JS-heavy pages work too). Both degrade
 * cleanly: [] / a throw the caller catches when Chromium is unavailable.
 */
import { withPage } from './browser.js';
import { logger } from '../logger.js';
import type { Page } from 'puppeteer';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface RawHit {
  href: string;
  title: string;
  snippet: string;
}

const NAV = { waitUntil: 'domcontentloaded' as const, timeout: 30_000 };

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit) || 6, 1), 15);
}

/** Resolve DuckDuckGo's `/l/?uddg=` redirect wrapper to the real destination. */
function resolveDdgUrl(href: string): string {
  let h = (href ?? '').trim();
  if (!h) return '';
  if (h.startsWith('//')) h = `https:${h}`;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return u.protocol.startsWith('http') ? u.toString() : '';
  } catch {
    const m = /uddg=([^&"]+)/.exec(href);
    if (m?.[1]) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return '';
      }
    }
    return /^https?:/i.test(href) ? href : '';
  }
}

function normalizeUrl(url: string): string {
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

async function ddgResults(page: Page, query: string): Promise<RawHit[]> {
  await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, NAV);
  return page.evaluate(() => {
    const hits: RawHit[] = [];
    document.querySelectorAll('.result__body, .web-result').forEach((el) => {
      const a = el.querySelector('a.result__a') as HTMLAnchorElement | null;
      const sn = el.querySelector('.result__snippet');
      if (a) {
        hits.push({
          href: a.getAttribute('href') ?? '',
          title: (a.textContent ?? '').trim(),
          snippet: (sn?.textContent ?? '').trim(),
        });
      }
    });
    return hits;
  });
}

async function bingResults(page: Page, query: string): Promise<RawHit[]> {
  await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, NAV);
  return page.evaluate(() => {
    const hits: RawHit[] = [];
    document.querySelectorAll('li.b_algo').forEach((el) => {
      const a = el.querySelector('h2 a') as HTMLAnchorElement | null;
      const p = el.querySelector('.b_caption p') ?? el.querySelector('p');
      if (a) {
        hits.push({
          href: a.getAttribute('href') ?? '',
          title: (a.textContent ?? '').trim(),
          snippet: (p?.textContent ?? '').trim(),
        });
      }
    });
    return hits;
  });
}

/**
 * Search the web with a real browser. DuckDuckGo first, Bing as a fallback.
 * Returns [] (never throws) if Chromium is unavailable, so callers degrade.
 */
export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const lim = clampLimit(limit);

  try {
    return await withPage(async (page) => {
      let raw = await ddgResults(page, q).catch(() => [] as RawHit[]);
      let mapped = raw
        .map((r) => ({ title: r.title || resolveDdgUrl(r.href), url: resolveDdgUrl(r.href), snippet: r.snippet }))
        .filter((r) => r.url);

      if (mapped.length === 0) {
        raw = await bingResults(page, q).catch(() => [] as RawHit[]);
        mapped = raw
          .map((r) => ({ title: r.title || r.href, url: r.href, snippet: r.snippet }))
          .filter((r) => /^https?:/i.test(r.url));
      }
      return mapped.slice(0, lim);
    });
  } catch (e) {
    logger.warn({ err: String(e) }, 'browser web search failed (is Chromium installed?)');
    return [];
  }
}

/**
 * Open a URL in the browser and return the readable text it actually rendered.
 * Throws on a hard navigation failure (the caller/tool catches and reports).
 */
export async function webFetch(url: string): Promise<string> {
  const target = normalizeUrl(url);
  return withPage(async (page) => {
    await page.goto(target, NAV);
    // Let late client-side content settle a moment.
    await new Promise((r) => setTimeout(r, 600));
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    const clean = text
      .replace(/[ \t\f\r]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return clean || '(the page rendered no readable text)';
  });
}
