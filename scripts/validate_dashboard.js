#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'daily_financial_news.html');
const html = fs.readFileSync(file, 'utf8');
const match = html.match(/<script type="application\/json" id="dashboard-data">([\s\S]*?)<\/script>/);

const errors = [];

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
    const tapeRows = data.tape?.rows ?? [];
    const sourcePattern = /(\bAP\b|Washington Post|Reuters|Investing\.com|Federal Reserve|Yahoo Finance|CoinGecko|\bsource\b|\bsnapshot\b|\brecap\b|\blisting\b)/i;

    for (const row of tapeRows) {
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

    for (const note of cryptoNotes) {
      const text = `${note.kicker ?? ''} ${note.title ?? ''} ${note.body ?? ''}`;
      if (staleFngPattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" contains stale F&G failure/unavailable language.`);
      }
      if (staticCryptoPattern.test(text)) {
        errors.push(`Crypto note "${note.title ?? '(untitled)'}" looks static, placeholder-like, or quote-recap-only.`);
      }
      for (const row of cryptoRows) {
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

    for (const story of data.stories ?? []) {
      const url = String(story.url ?? '').trim();
      if (!/^https:\/\/\S+$/i.test(url)) {
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

console.log('Dashboard validation OK');
