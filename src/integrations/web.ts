import { logger } from '../logger.js';

/**
 * Web access for the agent. Two capabilities, both designed to degrade
 * gracefully — never throw for a missing credential, always fall back:
 *   - webSearch: a configured Tavily/Serper-style JSON API (SEARCH_API_URL +
 *     SEARCH_API_KEY) with a keyless DuckDuckGo HTML fallback.
 *   - webFetch:  fetch a page and return readable, tag-stripped text.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (compatible; cos-agent/0.1; +https://acred.in)';

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Convert an HTML document into readable plain text. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Normalize the many result shapes of Tavily/Serper/Bing/Brave-style APIs. */
function normalizeSearch(data: Record<string, unknown>, limit: number): SearchResult[] {
  const webPages = data.webPages as Record<string, unknown> | undefined;
  const buckets: unknown[] = [
    ...asArray(data.results),
    ...asArray(data.organic),
    ...asArray(data.items),
    ...asArray(webPages?.value),
    ...asArray(data.data),
  ];
  const out: SearchResult[] = [];
  for (const item of buckets) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const url = str(r.url ?? r.link ?? r.href);
    if (!url) continue;
    out.push({
      title: str(r.title ?? r.name) || url,
      url,
      snippet: str(r.content ?? r.snippet ?? r.description ?? r.body),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchViaApi(query: string, limit: number): Promise<SearchResult[]> {
  const url = process.env.SEARCH_API_URL;
  if (!url) return [];
  const key = process.env.SEARCH_API_KEY ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) {
    // Cover the common auth styles: Tavily (body api_key), Serper (x-api-key),
    // and Bearer-token providers — harmless extras are ignored by each API.
    headers.authorization = `Bearer ${key}`;
    headers['x-api-key'] = key;
  }
  const body = JSON.stringify({ query, q: query, api_key: key, max_results: limit, num: limit });
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body }, 15_000);
  if (!res.ok) throw new Error(`search API ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Record<string, unknown>;
  return normalizeSearch(data, limit);
}

/** Resolve DuckDuckGo's `/l/?uddg=` redirect wrapper to the real destination. */
function resolveDdgUrl(href: string): string {
  let h = href.trim();
  if (!h) return '';
  if (h.startsWith('//')) h = `https:${h}`;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    return uddg ?? (u.protocol.startsWith('http') ? u.toString() : '');
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

function parseDuckDuckGo(html: string, limit: number): SearchResult[] {
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1] ?? ''));

  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out: SearchResult[] = [];
  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) !== null && out.length < limit) {
    const url = resolveDdgUrl(lm[1] ?? '');
    if (url) out.push({ title: stripTags(lm[2] ?? '') || url, url, snippet: snippets[i] ?? '' });
    i++;
  }
  return out;
}

async function searchViaDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(
    endpoint,
    { method: 'GET', headers: { 'user-agent': UA, accept: 'text/html' } },
    15_000,
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status} ${res.statusText}`);
  return parseDuckDuckGo(await res.text(), limit);
}

/**
 * Search the web. Prefers a configured API (SEARCH_API_URL + SEARCH_API_KEY);
 * otherwise, or on failure, falls back to keyless DuckDuckGo. Returns [] rather
 * than throwing if everything is unreachable, so callers degrade cleanly.
 */
export async function webSearch(query: string, limit = 6): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const lim = Math.min(Math.max(Math.trunc(limit) || 6, 1), 15);

  if (process.env.SEARCH_API_URL) {
    try {
      const results = await searchViaApi(q, lim);
      if (results.length) return results;
    } catch (e) {
      logger.warn({ err: String(e) }, 'configured search API failed; falling back to DuckDuckGo');
    }
  }

  try {
    return await searchViaDuckDuckGo(q, lim);
  } catch (e) {
    logger.warn({ err: String(e) }, 'DuckDuckGo search failed');
    return [];
  }
}

function normalizeUrl(url: string): string {
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * Fetch a URL and return readable text. HTML is tag-stripped; JSON/plain text is
 * returned as-is. Throws on a hard network/HTTP error (callers should catch).
 */
export async function webFetch(url: string): Promise<string> {
  const target = normalizeUrl(url);
  const res = await fetchWithTimeout(
    target,
    { method: 'GET', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' } },
    20_000,
  );
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const ctype = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  if (/json|javascript|text\/plain|csv/i.test(ctype)) return raw.trim();
  if (/html|xml/i.test(ctype) || /^\s*</.test(raw)) return htmlToText(raw);
  return raw.trim();
}
