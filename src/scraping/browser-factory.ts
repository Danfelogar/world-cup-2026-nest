import { chromium, BrowserContext } from 'patchright';
import * as path from 'path';

export async function createBrowser(): Promise<BrowserContext> {
  const userDataDir = path.join(process.cwd(), '.browser-data');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    slowMo: 50,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=ChromeWhatsNewUI',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--window-size=1280,800',
    ],
    viewport: { width: 1280, height: 800 },
  });

  return context;
}
