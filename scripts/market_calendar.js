const fs = require('fs');
const path = require('path');
const https = require('https');
const { isIsoDate } = require('./calendar_contract');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ENV_FILE = path.join(ROOT, '.env');
const FINNHUB_MARKET_HOLIDAY_URL = 'https://finnhub.io/api/v1/stock/market-holiday';
const REQUEST_TIMEOUT_MS = 10000;
const RESPONSE_LIMIT_BYTES = 128 * 1024;

function envFileValue(name, file = DEFAULT_ENV_FILE) {
  if (!fs.existsSync(file)) return '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0 || trimmed.slice(0, separator).trim() !== name) continue;
    return trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function finnhubApiKey(environment = process.env, envFile = DEFAULT_ENV_FILE) {
  if (environment.DASHBOARD_TEST_NO_API_CREDENTIALS === '1') return '';
  return String(environment.FINNHUB_API_KEY || envFileValue('FINNHUB_API_KEY', envFile)).trim();
}

function requestJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'DailyFinancialDashboard/1.0'
      },
      timeout: timeoutMs
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT_BYTES) {
          request.destroy(new Error('Finnhub market holiday response exceeded 128 KiB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const status = Number(response.statusCode) || 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`Finnhub market holiday request failed with HTTP ${status}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Finnhub market holiday response was not valid JSON.'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Finnhub market holiday request timed out.')));
    request.on('error', reject);
  });
}

async function fetchFinnhubMarketHolidays(apiKey, dependencies = {}) {
  if (!apiKey) throw new Error('FINNHUB_API_KEY is not configured.');
  const url = new URL(FINNHUB_MARKET_HOLIDAY_URL);
  url.searchParams.set('exchange', 'US');
  url.searchParams.set('token', apiKey);
  const fetchJson = dependencies.requestJson || requestJson;
  return fetchJson(url, dependencies.timeoutMs || REQUEST_TIMEOUT_MS);
}

function fullMarketClosure(payload, isoDate) {
  if (!isIsoDate(isoDate)) throw new Error('Scheduled market-calendar date must be an ISO date.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.exchange !== 'US'
    || payload.timezone !== 'America/New_York'
    || !Array.isArray(payload.data)) {
    throw new Error('Finnhub market holiday response had an invalid top-level shape.');
  }
  const entry = payload.data.find((row) => row?.atDate === isoDate);
  if (!entry) return null;
  if (typeof entry.eventName !== 'string' || !entry.eventName.trim()
    || typeof entry.tradingHour !== 'string') {
    throw new Error(`Finnhub market holiday entry for ${isoDate} was malformed.`);
  }
  if (entry.tradingHour.trim()) return null;
  return {
    date: isoDate,
    eventName: entry.eventName.trim()
  };
}

async function scheduledFullMarketClosure(isoDate, dependencies = {}) {
  const apiKey = dependencies.apiKey === undefined
    ? finnhubApiKey(dependencies.environment, dependencies.envFile)
    : String(dependencies.apiKey || '').trim();
  const payload = await fetchFinnhubMarketHolidays(apiKey, dependencies);
  return fullMarketClosure(payload, isoDate);
}

module.exports = {
  fetchFinnhubMarketHolidays,
  finnhubApiKey,
  fullMarketClosure,
  scheduledFullMarketClosure
};
