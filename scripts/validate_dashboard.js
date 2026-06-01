#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'daily_financial_news.html');
const html = fs.readFileSync(file, 'utf8');
const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);

const errors = [];
const warnings = [];

function escRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (!match) {
  errors.push('Could not find dashboard-data JSON block.');
} else {
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (error) {
    errors.push(`Embedded dashboard JSON is invalid: ${error.message}`);
  }

  if (data) {
    const strictDates = process.env.VALIDATE_STRICT_DATES === '1';
    const tapeRows = data.tape?.rows ?? [];
    const sourcePattern = /(\bAP\b|Washington Post|Reuters|Investing\.com|Federal Reserve|Yahoo Finance|CoinGecko|\bsource\b|\bsnapshot\b|\brecap\b|\blisting\b)/i;

    // Freshness advisory checks (strict only when VALIDATE_STRICT_DATES=1).
    const todayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).formatToParts(new Date());
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

    for (const storyRaw of data.stories ?? []) {
      const story = storyRaw && typeof storyRaw === 'object' ? storyRaw : {};
      const url = String(story.url ?? '').trim();
      let isHttps = false;
      try {
        isHttps = url.length > 0 && new URL(url).protocol === 'https:';
      } catch (_error) {
        isHttps = false;
      }
      if (!isHttps) {
        errors.push(`Story "${story.title ?? '(untitled)'}" must include an HTTPS url.`);
      }
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
