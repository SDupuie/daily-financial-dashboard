#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const inputFile = process.argv[2] || 'daily_financial_news.html';
const file = path.resolve(root, inputFile);
// Allow staging copies to be validated while keeping the checker scoped to this repository.
if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
  console.error(`Refusing to validate a file outside this repository: ${inputFile}`);
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');
const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);

const errors = [];
const warnings = [];

function escRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNow() {
  const override = process.env.VALIDATE_NOW_ISO;
  if (!override) return new Date();
  const parsed = new Date(override);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

if (!match) {
  errors.push('Could not find dashboard-data JSON block.');
} else {
  const dataBlock = match[1];
  // This guard is intentionally scoped to the embedded data block so JS escape helpers do not false-positive.
  const entityMatch = dataBlock.match(/&(amp|lt|gt);/);
  if (entityMatch) {
    errors.push(`Embedded dashboard JSON contains HTML entity "${entityMatch[0]}"; use normal text unless markup is intended.`);
  }

  let data;
  try {
    data = JSON.parse(dataBlock);
  } catch (error) {
    errors.push(`Embedded dashboard JSON is invalid: ${error.message}`);
  }

  if (data) {
    const now = getNow();
    const strictDates = process.env.VALIDATE_STRICT_DATES === '1';
    const tapeRows = data.tape?.rows ?? [];
    const sourcePattern = /(\bAP\b|Washington Post|Reuters|Investing\.com|Federal Reserve|Yahoo Finance|CoinGecko|\bsource\b|\bsnapshot\b|\brecap\b|\blisting\b)/i;
    const requireString = (value, label) => {
      if (typeof value !== 'string' || value.trim() === '') {
        errors.push(`${label} must be populated.`);
      }
    };
    const requireHttpsUrl = (url, label) => {
      const raw = String(url ?? '').trim();
      let isHttps = false;
      try {
        isHttps = raw.length > 0 && new URL(raw).protocol === 'https:';
      } catch (_error) {
        isHttps = false;
      }
      if (!isHttps) errors.push(`${label} must include an HTTPS url.`);
    };
    const requireIsoDate = (value, label) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        errors.push(`${label} must be an ISO date.`);
      }
    };
    const validateDividendEvents = (events, label, { optional = false } = {}) => {
      if (events === undefined && optional) return;
      if (!Array.isArray(events)) {
        errors.push(`${label} must be an array.`);
        return;
      }
      events.forEach((eventRaw, eventIndex) => {
        const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : {};
        requireIsoDate(event.exDate, `${label}[${eventIndex}].exDate`);
        if (!Number.isFinite(Number(event.amount))) {
          errors.push(`${label}[${eventIndex}].amount must be numeric.`);
        }
      });
    };
    const validateRequiredDividendBucket = (row, label, textKey, valueKey, eventsKey) => {
      requireString(row[textKey], `${label}.${textKey}`);
      if (!Number.isFinite(Number(row[valueKey]))) {
        errors.push(`${label}.${valueKey} must be numeric.`);
      }
      validateDividendEvents(row[eventsKey], `${label}.${eventsKey}`);
    };

    // Freshness advisory checks (strict only when VALIDATE_STRICT_DATES=1).
    const todayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).formatToParts(now);
    const part = (type) => todayParts.find((p) => p.type === type)?.value || '';
    const expectedDay = part('weekday');
    const expectedMonth = part('month');
    const expectedDate = part('day');
    const expectedYear = part('year');
    const mastheadDate = String(data.masthead?.date ?? '');
    const footerCompiled = String(data.footer?.compiled ?? '');
    const dateMsg = `Masthead/footer may be stale: expected ${expectedDay}, ${expectedMonth} ${expectedDate}, ${expectedYear}.`;

    const mastheadLooksFresh = new RegExp(
      `\\b${escRegex(expectedDay)}\\b[\\s\\S]*\\b${escRegex(expectedMonth)}\\b[\\s\\S]*\\b${escRegex(expectedDate)}\\b[\\s\\S]*\\b${escRegex(expectedYear)}\\b`,
      'i'
    ).test(mastheadDate);
    const footerLooksFresh = new RegExp(
      `\\b${escRegex(expectedMonth)}\\b[\\s\\S]*\\b${escRegex(expectedDate)}\\b(?:,)?[\\s\\S]*\\b${escRegex(expectedYear)}\\b`,
      'i'
    ).test(footerCompiled);
    if (!mastheadLooksFresh || !footerLooksFresh) {
      if (strictDates) {
        errors.push(dateMsg);
      } else {
        warnings.push(dateMsg);
      }
    }

    // Promoted-dashboard schema gates: catch old mockup/legacy sections and missing embedded production data.
    if (data.lede) {
      errors.push('Legacy lede section should not be present in the promoted dashboard data.');
    }
    if (data.renesas) {
      errors.push('Legacy renesas section should not be present in the promoted dashboard data.');
    }

    requireString(data.opening?.headline, 'opening.headline');
    requireString(data.opening?.deck, 'opening.deck');
    const catalysts = Array.isArray(data.opening?.catalysts) ? data.opening.catalysts : [];
    if (catalysts.length !== 4) {
      errors.push('opening.catalysts must contain exactly four catalyst items.');
    }
    for (const [index, catalystRaw] of catalysts.entries()) {
      const catalyst = catalystRaw && typeof catalystRaw === 'object' ? catalystRaw : {};
      requireString(catalyst.label, `opening.catalysts[${index}].label`);
      requireString(catalyst.body, `opening.catalysts[${index}].body`);
    }

    const staleTapeTickers = new Set(['6723.T', 'BZ', 'BTC', 'ETH', 'TOTAL']);
    for (const ticker of tapeRows.map((row) => String(row?.ticker ?? '').toUpperCase())) {
      if (staleTapeTickers.has(ticker)) {
        errors.push(`The Tape should not include stale or duplicated ticker ${ticker}.`);
      }
    }

    const requiredTapeTickers = ['SPX', 'IXIC', 'DJI', 'RUT', 'MXEA', 'MXEF', 'FNER', 'GSCI', 'XAU', 'XAG', 'CL', 'VIX', 'MOVE', 'UST10Y', 'UST30Y', 'IEF', 'AGG', 'LQD', 'HYG'];
    const tapeTickerSet = new Set(tapeRows.map((row) => String(row?.ticker ?? '').toUpperCase()));
    for (const ticker of requiredTapeTickers) {
      if (!tapeTickerSet.has(ticker)) {
        errors.push(`The Tape is missing required ticker ${ticker}.`);
      }
    }

    // Runtime does not fetch sidecar files; pre-market futures must be embedded and chart-ready.
    const futures = Array.isArray(data.preMarket?.futures) ? data.preMarket.futures : [];
    if (futures.length !== 4) {
      errors.push('preMarket.futures must contain exactly four index-futures rows.');
    }
    for (const [index, futureRaw] of futures.entries()) {
      const future = futureRaw && typeof futureRaw === 'object' ? futureRaw : {};
      requireString(future.label, `preMarket.futures[${index}].label`);
      requireString(future.value, `preMarket.futures[${index}].value`);
      requireString(future.body, `preMarket.futures[${index}].body`);
      if (!Array.isArray(future.series) || future.series.length < 2) {
        errors.push(`preMarket.futures[${index}].series must contain at least two chart points.`);
      }
      // The browser renderer uses this field to draw the previous-close reference line.
      if (!Number.isFinite(Number(future.raw?.previousClose))) {
        errors.push(`preMarket.futures[${index}].raw.previousClose must be numeric for the futures close reference line.`);
      }
    }

    const preMarketStories = Array.isArray(data.preMarket?.stories) ? data.preMarket.stories : [];
    if (preMarketStories.length < 1 || preMarketStories.length > 3) {
      errors.push('preMarket.stories must contain one to three priority stories.');
    }
    for (const [index, storyRaw] of preMarketStories.entries()) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      requireString(story.preMarketTag || story.tag, `preMarket.stories[${index}] tag`);
      requireString(story.title, `preMarket.stories[${index}].title`);
      requireString(story.body, `preMarket.stories[${index}].body`);
      requireHttpsUrl(story.url, `preMarket.stories[${index}]`);
    }

    // Portfolio validation is instrument-level only; tactical weights/model outputs are intentionally out of scope here.
    const portfolio = data.assetAllocationPortfolio && typeof data.assetAllocationPortfolio === 'object'
      ? data.assetAllocationPortfolio
      : {};
    const hasPortfolioReturn = portfolio.portfolioMtdReturnStatus !== undefined
      || portfolio.portfolioMtdReturnValue !== undefined
      || portfolio.portfolioMtdReturnAsOf !== undefined
      || portfolio.portfolioMtdReturnStale !== undefined;
    if (hasPortfolioReturn) {
      // This proves only the sanitized display contract. It intentionally does
      // not validate allocation weights, signals, or any source calculation.
      if (!['available', 'unavailable'].includes(portfolio.portfolioMtdReturnStatus)) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnStatus must be available or unavailable.');
      }
      if (portfolio.portfolioMtdReturnStatus === 'available' && !Number.isFinite(Number(portfolio.portfolioMtdReturnValue))) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnValue must be finite when status is available.');
      }
      if (portfolio.portfolioMtdReturnStatus === 'unavailable' && portfolio.portfolioMtdReturnValue !== null) {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnValue must be null when status is unavailable.');
      }
      requireIsoDate(portfolio.portfolioMtdReturnAsOf, 'assetAllocationPortfolio.portfolioMtdReturnAsOf');
      if (typeof portfolio.portfolioMtdReturnStale !== 'boolean') {
        errors.push('assetAllocationPortfolio.portfolioMtdReturnStale must be boolean.');
      }
    }
    const portfolioRows = Array.isArray(data.assetAllocationPortfolio?.rows) ? data.assetAllocationPortfolio.rows : [];
    const requiredPortfolioTickers = ['VTI', 'VEA', 'VWO', 'VNQ', 'DBC', 'GLD', 'IEF', 'BOXX'];
    const portfolioTickerSet = new Set(portfolioRows.map((row) => String(row?.ticker ?? '').toUpperCase()));
    for (const ticker of requiredPortfolioTickers) {
      if (!portfolioTickerSet.has(ticker)) {
        errors.push(`assetAllocationPortfolio.rows is missing ${ticker}.`);
      }
    }
    for (const rowRaw of portfolioRows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const label = `assetAllocationPortfolio row ${row.ticker ?? '(unknown)'}`;
      for (const key of ['ticker', 'sleeve', 'price', 'monthDivPerShare', 'dailyPriceChange', 'dailyTR', 'mtdPriceChange', 'mtdTR']) {
        requireString(row[key], `${label}.${key}`);
      }
      validateDividendEvents(row.dividends, `${label}.dividends`, { optional: true });
      // The portfolio fetcher always emits these lookahead buckets; require
      // them so stale pre-lookahead payloads cannot silently pass validation.
      validateRequiredDividendBucket(
        row,
        label,
        'upcomingCurrentMonthDividends',
        'upcomingCurrentMonthDividendsValue',
        'upcomingCurrentMonthDividendEvents'
      );
      validateRequiredDividendBucket(
        row,
        label,
        'futureMonthDividends',
        'futureMonthDividendsValue',
        'futureMonthDividendEvents'
      );
    }

    for (const rowRaw of tapeRows) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      const note = String(row.note ?? '');

      if (sourcePattern.test(note)) {
        errors.push(`Tape note for ${row.name} contains source/citation language.`);
      }

      for (const value of [row.last, row.delta, row.pct]) {
        if (value && value !== '0.00' && note.includes(String(value))) {
          errors.push(`Tape note for ${row.name} repeats row value "${value}".`);
        }
      }
    }

    const cryptoHeader = String(data.crypto?.tapeHeader ?? '');
    const cryptoNotes = data.crypto?.notes ?? [];
    const cryptoRows = data.crypto?.tape ?? [];
    const fng = (data.crypto?.tape ?? []).find(row => row.sym === 'F&G');
    const staleFngPattern = /(numeric read|pull still failed|F&G ~|unavailable|not retrievable|not extractable)/i;
    const staticCryptoPattern = /(placeholder|no update|no fresh|unchanged|static|evergreen|same as yesterday|table snapshot showed|historical close datasets showed|held modest gains)/i;

    if (staleFngPattern.test(cryptoHeader)) {
      errors.push('Crypto tape header contains stale F&G failure/unavailable language.');
    }

    for (const noteRaw of cryptoNotes) {
      const note = noteRaw && typeof noteRaw === 'object' ? noteRaw : {};
      const text = `${note.kicker ?? ''} ${note.title ?? ''} ${note.body ?? ''}`;
      if (staleFngPattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" contains stale F&G failure/unavailable language.`);
      }
      if (staticCryptoPattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" looks static, placeholder-like, or quote-recap-only.`);
      }
      for (const rowRaw of cryptoRows) {
        const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
        for (const value of [row.price, row.chg]) {
          if (value && !['Fear'].includes(String(value)) && text.includes(String(value))) {
            errors.push(`Crypto note "${note.title ?? '(untitled)'}" repeats crypto tape value "${value}".`);
          }
        }
      }
    }

    if (!Array.isArray(cryptoNotes) || cryptoNotes.length === 0) {
      errors.push('Crypto notes must include fresh daily crypto stories/items.');
    } else if (cryptoNotes.length > 6) {
      errors.push('Crypto notes must contain no more than six daily stories/items.');
    }

    const cryptoTotal = (data.crypto?.tape ?? []).find(row => row.sym === 'TOTAL' || /(?:total )?crypto market cap/i.test(String(row?.name ?? '')));
    if (!cryptoTotal) {
      errors.push('Crypto tape is missing the Crypto Market Cap stat row.');
    } else {
      requireString(cryptoTotal.price, 'Crypto Market Cap price');
      requireString(cryptoTotal.delta, 'Crypto Market Cap value change');
    }

    if (!fng) {
      errors.push('Crypto tape is missing the F&G row.');
    } else {
      const fngPrice = String(fng.price ?? '').trim();
      const fngChange = String(fng.chg ?? '').trim();

      if (!/^\d{1,3}$/.test(fngPrice)) {
        errors.push('F&G price must be a numeric 0-100 reading, not a placeholder.');
      } else {
        const value = Number(fngPrice);
        if (value < 0 || value > 100) {
          errors.push('F&G price must be between 0 and 100.');
        }
      }

      if (!fngChange || /^unavailable$/i.test(fngChange)) {
        errors.push('F&G change/classification must be populated.');
      }
    }

    if (!/Alternative\.me Crypto Fear & Greed Index/i.test(String(data.footer?.compiled ?? ''))) {
      errors.push('Footer source list must include Alternative.me Crypto Fear & Greed Index when F&G is shown.');
    }

    const stories = Array.isArray(data.stories) ? data.stories : [];
    if (stories.length < 8 || stories.length > 10) {
      errors.push('stories must contain 8-10 fresh market/news items.');
    }
    const preMarketUrls = new Set(preMarketStories.map((story) => String(story?.url ?? '').trim()).filter(Boolean));
    const preMarketTitles = new Set(preMarketStories.map((story) => String(story?.title ?? '').trim().toLowerCase()).filter(Boolean));
    for (const storyRaw of stories) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      requireString(story.tag, `Story "${story.title ?? '(untitled)'}" tag`);
      requireString(story.title, 'stories[].title');
      requireString(story.body, `Story "${story.title ?? '(untitled)'}" body`);
      requireHttpsUrl(story.url, `Story "${story.title ?? '(untitled)'}"`);
      const storyUrl = String(story.url ?? '').trim();
      const storyTitle = String(story.title ?? '').trim().toLowerCase();
      if (storyUrl && preMarketUrls.has(storyUrl)) {
        errors.push(`Story "${story.title ?? '(untitled)'}" duplicates a promoted Pre-Market URL.`);
      }
      if (storyTitle && preMarketTitles.has(storyTitle)) {
        errors.push(`Story "${story.title ?? '(untitled)'}" duplicates a promoted Pre-Market title.`);
      }
    }

    for (const noteRaw of cryptoNotes) {
      const note = noteRaw && typeof noteRaw === 'object' ? noteRaw : {};
      requireHttpsUrl(note.url, `Crypto note "${note.title ?? '(untitled)'}"`);
    }

    const earningsTiles = Array.isArray(data.earnings?.tiles) ? data.earnings.tiles : [];
    if (!earningsTiles.length) {
      errors.push('earnings.tiles must contain at least one earnings item.');
    }
    for (const [index, tileRaw] of earningsTiles.entries()) {
      const tile = tileRaw && typeof tileRaw === 'object' ? tileRaw : {};
      requireString(tile.co, `earnings.tiles[${index}].co`);
      requireString(tile.move, `earnings.tiles[${index}].move`);
      requireString(tile.body, `earnings.tiles[${index}].body`);
    }

    const weekRows = Array.isArray(data.weekAhead?.rows) ? data.weekAhead.rows : [];
    if (!weekRows.length) {
      errors.push('weekAhead.rows must contain at least one calendar row.');
    }
    for (const [index, rowRaw] of weekRows.entries()) {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      requireString(row.day, `weekAhead.rows[${index}].day`);
      requireString(row.event, `weekAhead.rows[${index}].event`);
      requireString(row.tickers, `weekAhead.rows[${index}].tickers`);
    }
  }
}

if (errors.length) {
  console.error('Dashboard validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (warnings.length) {
  console.warn('Dashboard validation warnings:');
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log('Dashboard validation OK');
