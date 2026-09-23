import { chromium } from 'playwright';

// Free Amazon rank worker probe with multi-runner fallback.
const keyword = process.env.RANK_KEYWORD || 'zip lock bag';
const asin = (process.env.RANK_ASIN || 'B0CZNM35RC').toUpperCase();
const pincode = process.env.RANK_PINCODE || '380015';

const result = {
  keyword, asin, pincode,
  status: 'FAILED',
  organic_rank: null,
  organic_absolute_position: null,
  sponsored_position: null,
  sponsored_absolute_position: null,
  sponsored_found: false,
  cards: 0,
  location_text: null,
  title: null,
  url: null,
  error: null,
};

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox']
});

try {
  const context = await browser.newContext({
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    viewport: { width: 1440, height: 1000 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const searchUrl = 'https://www.amazon.in/s?k=' + encodeURIComponent(keyword);

  async function loadSearch(attempts = 4) {
    let lastTitle = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000 + attempt * 1000);
        lastTitle = await page.title().catch(() => '');
        const body = await page.locator('body').innerText().catch(() => '');
        const hasHeader = (await page.locator('#nav-global-location-popover-link, #glow-ingress-line2').count()) > 0;
        const hasResults = (await page.locator('[data-component-type="s-search-result"][data-asin]').count()) > 0;
        if (body.trim().length > 200 && (hasHeader || hasResults)) return;
      } catch {}
      await page.waitForTimeout(1500 * attempt);
    }
    throw new Error('Amazon search page did not load usable content. Last title: ' + lastTitle);
  }

  async function currentLocation() {
    const one = await page.locator('#glow-ingress-line1').first().textContent().catch(() => '');
    const two = await page.locator('#glow-ingress-line2').first().textContent().catch(() => '');
    return ((one || '') + ' ' + (two || '')).replace(/\\s+/g,' ').trim();
  }

  async function setPincode() {
    // Use Amazon's own delivery-location endpoint inside the current browser session.
    // This avoids brittle popup selectors and keeps all cookies/session state in Chromium.
    const response = await page.evaluate(async (zip) => {
      const body = new URLSearchParams({
        locationType: 'LOCATION_INPUT',
        zipCode: zip,
        storeContext: 'generic',
        deviceType: 'web',
        pageType: 'Search',
        actionSource: 'glow'
      });

      const r = await fetch('/gp/delivery/ajax/address-change.html', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: body.toString()
      });

      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, text: text.slice(0, 1000), json };
    }, pincode);

    const acceptedZip = String(response?.json?.address?.zipCode || '');
    const accepted = response?.ok &&
      (response?.json?.sembuUpdated === 1 || response?.json?.sembuUpdated === true) &&
      acceptedZip === pincode;

    if (!accepted) {
      throw new Error('Amazon rejected pincode update: HTTP ' + response.status + ' ' + response.text);
    }

    // Reload so search results are rendered under the accepted delivery location.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    const loc = await currentLocation();

    // Header text is useful evidence, but Amazon variants do not always echo the postal code.
    // The address-change response above is the authoritative acceptance check.
    return loc || ('Pincode ' + acceptedZip + ' accepted by Amazon');
  }

  await loadSearch();
  await page.screenshot({ path: 'rank-initial.png', fullPage: false }).catch(() => {});
  result.location_text = await setPincode();

  // Reload search results after the location is confirmed.
  await loadSearch();
  const headerLocation = await currentLocation();
  if (headerLocation) result.location_text = headerLocation;

  result.title = await page.title();
  result.url = page.url();

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/503 - Service Unavailable|Robot Check|Enter the characters you see below/i.test(bodyText)) {
    throw new Error('Amazon blocked the GitHub browser session: ' + result.title);
  }

  await page.locator('[data-component-type="s-search-result"][data-asin]').first()
    .waitFor({ state: 'attached', timeout: 30000 });

  const cards = await page.locator('[data-component-type="s-search-result"][data-asin]').evaluateAll((els) =>
    els.map((el, index) => {
      const a = (el.getAttribute('data-asin') || '').trim().toUpperCase();
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const sponsored = /\bSponsored\b/i.test(txt);
      return { asin: a, sponsored, absolute: index + 1 };
    }).filter(x => x.asin)
  );

  result.cards = cards.length;
  let organicCounter = 0;
  let sponsoredCounter = 0;

  for (const card of cards) {
    if (card.sponsored) {
      sponsoredCounter++;
      if (card.asin === asin && result.sponsored_position === null) {
        result.sponsored_position = sponsoredCounter;
        result.sponsored_absolute_position = card.absolute;
        result.sponsored_found = true;
      }
    } else {
      organicCounter++;
      if (card.asin === asin && result.organic_rank === null) {
        result.organic_rank = organicCounter;
        result.organic_absolute_position = card.absolute;
      }
    }
  }

  result.status = 'SUCCESS';
  await page.screenshot({ path: 'rank-probe.png', fullPage: true }).catch(() => {});
} catch (err) {
  result.error = err instanceof Error ? err.message : String(err);
} finally {
  await browser.close();
}

console.log('RANK_PROBE_RESULT=' + JSON.stringify(result));
// A blocked/unavailable Amazon check is data-quality failure, not CI failure.
// Keep the workflow successful and let production persist FAILED with the reason.
