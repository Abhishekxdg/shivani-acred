/**
 * Headless Chromium (Puppeteer) — the agent's real browser. A single shared
 * instance is launched lazily on first use (so boot stays fast and the app runs
 * fine without Chromium until web tools are actually called), reused across
 * calls, and relaunched if it dies. Puppeteer is imported dynamically for the
 * same reason. No paid search APIs — she drives a real browser.
 */
import { logger } from '../logger.js';
import type { Browser, Page } from 'puppeteer';

let browserPromise: Promise<Browser> | null = null;

async function launch(): Promise<Browser> {
  const puppeteer = (await import('puppeteer')).default;
  return puppeteer.launch({
    headless: true,
    // --no-sandbox is required to run Chromium as root on a VM; the others make
    // it stable in low-memory / headless containers.
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
}

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().catch((e) => {
      browserPromise = null;
      throw e;
    });
  }
  const browser = await browserPromise;
  if (!browser.connected) {
    browserPromise = null;
    return getBrowser();
  }
  return browser;
}

const REALISTIC_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Run work with a fresh page that is always closed afterward. */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(REALISTIC_UA);
    await page.setViewport({ width: 1280, height: 900 });
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch (e) {
    logger.warn({ err: String(e) }, 'closeBrowser failed');
  } finally {
    browserPromise = null;
  }
}
