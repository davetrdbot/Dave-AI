import { chromium } from "playwright";

/**
 * Step 6.2: real browser automation through the same sandbox layer.
 * DSH's own package set has no dedicated browser-automation provider
 * (confirmed by inspecting its full package list in Step 6 research --
 * only dsh-web/dsh-web-fetch-http/dsh-web-search exist, none of them
 * drive a real browser), so this runs a real headless Chromium via
 * Playwright as a code-execution task inside the workspace, consistent
 * with "one consistent execution/browsing layer" rather than adding a
 * second unrelated sandbox product.
 */
export interface BrowserTaskResult {
  url: string;
  title: string;
  status: number | null;
}

export async function fetchPageTitle(url: string): Promise<BrowserTaskResult> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    const title = await page.title();
    return { url, title, status: response?.status() ?? null };
  } finally {
    await browser.close();
  }
}
