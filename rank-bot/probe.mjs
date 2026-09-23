import { chromium } from 'playwright';

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
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'rank-initial.png', fullPage: false }).catch(() => {});

  // Set delivery location using the same UI an Amazon shopper uses.
  let locationLink = page.locator('#nav-global-location-popover-link');
  if (!(await locationLink.count())) locationLink = page.locator('#glow-ingress-line2');
  if (!(await locationLink.count())) locationLink = page.getByText('Update location', { exact: true });
  await locationLink.first().click({ timeout: 15000 });

  const zip = page.locator('#GLUXZipUpdateInput');
  await zip.waitFor({ state: 'visible', timeout: 15000 });
  await zip.fill(pincode);

  // Amazon.in's actual clickable Apply control is the nested input.
  const applyInput = page.locator('#GLUXZipUpdate > span > input, #GLUXZipUpdate input');
  await applyInput.first().click({ timeout: 15000 });

  await page.waitForTimeout(2500);

  // Some layouts require closing a confirmation dialog after the ZIP is accepted.
  const confirmClose = page.locator('#GLUXConfirmClose, #GLUXConfirmClose-announce');
  if (await confirmClose.count()) {
    await confirmClose.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Verify the pincode really took effect. Never trust a rank collected for the wrong location.
  result.location_text = ((await page.locator('#glow-ingress-line1').first().textContent().catch(() => '')) + ' ' +
                          (await page.locator('#glow-ingress-line2').first().textContent().catch(() => '')))
                          .replace(/\\s+/g,' ').trim();

  if (!result.location_text.includes(pincode)) {
    await page.screenshot({ path: 'rank-location-failed.png', fullPage: false }).catch(() => {});
    throw new Error('Pincode verification failed. Amazon header shows: ' + result.location_text);
  }

  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

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
if (result.status !== 'SUCCESS') process.exitCode = 2;
