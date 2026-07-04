#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const root = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.resolve(root, 'scripts', 'generated', 'earnings_week.json');
const DEFAULT_OUTPUT = path.resolve(root, 'scripts', 'generated', 'earnings_company_release_resolutions.json');
const REQUEST_TIMEOUT_MS = 20000;
const REACTION_LOOKBACK_DAYS = 5;
const REACTION_LOOKAHEAD_DAYS = 5;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    timeoutMs: REQUEST_TIMEOUT_MS,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_INPUT);
      i += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[i + 1] || DEFAULT_OUTPUT);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Math.max(1000, Number(argv[i + 1] || REQUEST_TIMEOUT_MS));
      i += 1;
      continue;
    }
    if (arg === '--compact') {
      args.compact = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/resolve_company_release_resolutions.js [options]

Options:
  --input PATH        Earnings week JSON with companyReleaseTasks (default: scripts/generated/earnings_week.json)
  --output PATH       Company-release resolution JSON output (default: scripts/generated/earnings_company_release_resolutions.json)
  --timeout-ms 20000  HTTP timeout in ms per request
  --compact           Print compact report
  --help              Show this help
`);
}

function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function requestHeaders(headers = {}) {
  const userAgent = String(process.env.SEC_USER_AGENT || '').trim();
  if (!userAgent) {
    throw new Error('SEC_USER_AGENT is required in .env or the environment for SEC/company-release resolution.');
  }
  // SEC requests require an identifying User-Agent; keep it configurable so
  // local operators can supply contact info without hard-coding it here.
  return {
    'User-Agent': userAgent,
    Accept: 'application/json,text/html,*/*',
    ...headers
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fetchText(url, args, headers = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, {
      timeout: args.timeoutMs,
      headers: requestHeaders(headers)
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        ms: Date.now() - started,
        body,
        error: res.statusCode >= 200 && res.statusCode < 300 ? '' : `HTTP ${res.statusCode}`
      }));
    });
    req.on('error', (error) => resolve({
      ok: false,
      status: 0,
      ms: Date.now() - started,
      body: '',
      error: error.message
    }));
    req.setTimeout(args.timeoutMs, () => req.destroy(new Error('request timeout')));
  });
}

async function fetchJson(url, args, headers = {}) {
  const result = await fetchText(url, args, headers);
  if (!result.ok) return { ...result, data: null, parseError: '' };
  try {
    return { ...result, data: JSON.parse(result.body), parseError: '' };
  } catch (error) {
    return { ...result, ok: false, data: null, parseError: error.message };
  }
}

function dateFromIso(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function isoFromDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = dateFromIso(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return isoFromDate(date);
}

function compareIsoDate(left, right) {
  return String(left).localeCompare(String(right));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedCents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function nearlyEqual(left, right, tolerance = 0.03) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance;
}

function moneyNumber(value, unit) {
  const number = Number(String(value || '').replace(/,/g, ''));
  if (!Number.isFinite(number)) return null;
  const normalizedUnit = String(unit || '').toLowerCase();
  if (normalizedUnit.startsWith('b')) return number * 1000000000;
  if (normalizedUnit.startsWith('m')) return number * 1000000;
  return number;
}

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#58;/g, ':')
    .replace(/&#8226;/g, ' ')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-')
    .replace(/&#47;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadTickerMap(args) {
  const result = await fetchJson('https://www.sec.gov/files/company_tickers.json', args);
  if (!result.ok || !result.data) throw new Error(`Unable to load SEC ticker map: ${result.error || result.parseError}`);
  const map = new Map();
  for (const item of Object.values(result.data)) {
    const ticker = String(item.ticker || '').toUpperCase();
    if (!ticker) continue;
    map.set(ticker, {
      cik: Number(item.cik_str),
      title: String(item.title || '').trim()
    });
  }
  return map;
}

function cikPadded(cik) {
  return String(cik).padStart(10, '0');
}

function cikPath(cik) {
  return String(Number(cik));
}

function daysBetween(left, right) {
  return Math.round((dateFromIso(right).getTime() - dateFromIso(left).getTime()) / 86400000);
}

function chooseEarningsFiling(task, recent) {
  const rows = [];
  for (let index = 0; index < recent.accessionNumber.length; index += 1) {
    const form = recent.form[index];
    const filingDate = recent.filingDate[index];
    const items = String(recent.items?.[index] || '');
    if (form !== '8-K') continue;
    if (!items.includes('2.02')) continue;
    const distance = Math.abs(daysBetween(task.reportDate, filingDate));
    if (distance > 3) continue;
    rows.push({
      accessionNumber: recent.accessionNumber[index],
      primaryDocument: recent.primaryDocument[index],
      filingDate,
      acceptanceDateTime: recent.acceptanceDateTime?.[index] || '',
      items,
      distance
    });
  }
  rows.sort((left, right) => left.distance - right.distance || left.filingDate.localeCompare(right.filingDate));
  return rows[0] || null;
}

async function fetchFilingIndex(cik, accessionNumber, args) {
  const accessionPath = accessionNumber.replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/data/${cikPath(cik)}/${accessionPath}/index.json`;
  const result = await fetchJson(url, args);
  return { ...result, url };
}

function chooseExhibit(indexData) {
  const items = Array.isArray(indexData?.directory?.item) ? indexData.directory.item : [];
  const htmlItems = items.filter((item) => /\.html?$/i.test(item.name));
  const exhibit = htmlItems.find((item) => /(?:exhibit|ex-?)?99[\d._-]*.*\.html?$/i.test(item.name) && !/index/i.test(item.name))
    || htmlItems.find((item) => /99/i.test(item.name) && !/index/i.test(item.name))
    || htmlItems.find((item) => /exhibit/i.test(item.name) && !/index/i.test(item.name));
  return exhibit?.name || '';
}

function extractFiscalPeriod(text, reportDate) {
  const year = reportDate.slice(0, 4);
  const lower = text.toLowerCase();
  const fiscalYear = text.match(/fiscal\s+(\d{4})/i)?.[1] || year;
  if (lower.includes('fourth quarter') || /\bq4\b/i.test(text)) return `Fiscal Q4 ${fiscalYear}`;
  if (lower.includes('third quarter') || /\bq3\b/i.test(text)) return `Fiscal Q3 ${fiscalYear}`;
  if (lower.includes('second quarter') || /\bq2\b/i.test(text)) return `Fiscal Q2 ${fiscalYear}`;
  if (lower.includes('first quarter') || /\bq1\b/i.test(text)) return `Fiscal Q1 ${fiscalYear}`;
  return `Fiscal period ending ${reportDate}`;
}

function extractReportTiming(filing) {
  const acceptedDate = new Date(filing.acceptanceDateTime || '');
  if (Number.isNaN(acceptedDate.getTime())) return 'unknown';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(acceptedDate);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 'unknown';
  const minutes = hour * 60 + minute;
  if (minutes < 9 * 60 + 30) return 'bmo';
  if (minutes >= 16 * 60) return 'amc';
  return 'unknown';
}

function extractEps(text) {
  const patterns = [
    { basis: 'adjusted_non_gaap', regex: /(?:Adjusted diluted EPS|Adjusted EPS|Non-GAAP diluted earnings per share|Non-GAAP diluted EPS)[^$]{0,220}\$\s*([\d.]+)/i },
    { basis: 'gaap_diluted', regex: /Diluted earnings per (?:common )?share[^$]{0,220}\$\s*([\d.]+)/i },
    { basis: 'gaap_diluted', regex: /Diluted EPS[^$]{0,160}\$\s*([\d.]+)/i }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.regex);
    if (match) return { value: Number(match[1]), basis: pattern.basis };
  }
  return { value: null, basis: '' };
}

function extractPerShareAdjustment(text, actual) {
  if (!Number.isFinite(actual)) return null;
  const match = text.match(/Diluted earnings per share was\s*\$\s*([\d.]+)[^.]{0,260}?including a\s*\$\s*([\d.]+)\s*(benefit|charge|expense|loss|gain)[^.]{0,220}\./i);
  if (!match) return null;
  const headline = Number(match[1]);
  const amount = Number(match[2]);
  if (!nearlyEqual(headline, actual, 0.005) || !Number.isFinite(amount)) return null;
  const kind = match[3].toLowerCase();
  const isBenefit = kind === 'benefit' || kind === 'gain';
  const comparable = roundedCents(isBenefit ? actual - amount : actual + amount);
  return {
    kind,
    amount,
    comparableEps: comparable,
    note: `GAAP EPS ${moneyText(actual)} includes ${moneyText(amount)} ${kind}.`
  };
}

function moneyText(value) {
  return Number.isFinite(value) ? `$${value.toFixed(2)}` : '';
}

function earningsApiBackup(task) {
  const coverage = task.sourceAudit?.earningsApiCompany?.selectedRow || {};
  return {
    eps: {
      estimate: numberOrNull(coverage.eps?.estimate),
      actual: numberOrNull(coverage.eps?.actual)
    },
    revenue: {
      estimate: numberOrNull(coverage.revenue?.estimate)
    },
    fiscalQuarterEnding: String(coverage.fiscalQuarterEnding || '').trim()
  };
}

function resolveComparableEps(secEps, task, text) {
  const backup = earningsApiBackup(task);
  const adjustment = extractPerShareAdjustment(text, secEps.value);
  const result = {
    actual: secEps.value,
    basis: secEps.basis,
    gaapActual: secEps.basis === 'gaap_diluted' ? secEps.value : null,
    gaapBasis: secEps.basis === 'gaap_diluted' ? secEps.basis : '',
    adjustment,
    estimate: backup.eps.estimate,
    estimateSource: Number.isFinite(backup.eps.estimate) ? 'earningsapi_company' : '',
    estimateCount: '',
    actualSource: 'sec_company_release',
    comparisonSource: ''
  };
  if (!Number.isFinite(backup.eps.actual)) return result;
  if (nearlyEqual(secEps.value, backup.eps.actual)) {
    result.actual = secEps.value;
    result.actualSource = 'sec_company_release';
    result.comparisonSource = 'earningsapi_company_eps_estimate';
    return result;
  }
  if (adjustment && nearlyEqual(adjustment.comparableEps, backup.eps.actual)) {
    result.actual = adjustment.comparableEps;
    result.basis = 'comparable_adjusted';
    result.actualSource = 'sec_company_release_adjusted_to_earningsapi_basis';
    result.comparisonSource = 'earningsapi_company_eps_estimate';
    return result;
  }
  result.comparisonSource = 'unreconciled_earningsapi_company';
  result.estimate = null;
  result.estimateSource = '';
  result.estimateCount = '';
  return result;
}

function extractRevenue(text) {
  const patterns = [
    /Fourth quarter revenues were[^$]{0,120}\$\s*([\d,.]+)\s*(billion|million)/i,
    /Revenues? for [^.]{0,120}?(?:were|was)[^$]{0,120}\$\s*([\d,.]+)\s*(billion|million)/i,
    /(?:Revenue|Revenues|Net sales)(?:\s+for [^.]{0,100})?(?:\s+were|\s+was|\s+of|\s+totaled)?[^$]{0,140}\$\s*([\d,.]+)\s*(billion|million)/i
  ];
  for (const regex of patterns) {
    const match = text.match(regex);
    if (match) return moneyNumber(match[1], match[2]);
  }
  return null;
}

function pctChange(from, to) {
  const left = numberOrNull(from);
  const right = numberOrNull(to);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === 0) return null;
  return (right / left - 1) * 100;
}

function yahooPeriodSeconds(isoDate) {
  return Math.floor(dateFromIso(isoDate).getTime() / 1000);
}

async function fetchYahooBars(symbol, from, to, args) {
  const start = addDays(from, -REACTION_LOOKBACK_DAYS);
  const endExclusive = addDays(to, REACTION_LOOKAHEAD_DAYS + 1);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${yahooPeriodSeconds(start)}&period2=${yahooPeriodSeconds(endExclusive)}&interval=1d&events=history`;
  const result = await fetchJson(url, args, { Accept: 'application/json,text/plain,*/*' });
  const chart = result.data?.chart;
  const item = chart?.result?.[0];
  const timestamps = Array.isArray(item?.timestamp) ? item.timestamp : [];
  const quote = item?.indicators?.quote?.[0] || {};
  const bars = timestamps.map((timestamp, index) => ({
    date: isoFromDate(new Date(timestamp * 1000)),
    close: numberOrNull(quote.close?.[index])
  })).filter((bar) => bar.close !== null);
  return {
    symbol,
    status: result.status,
    bars,
    error: result.ok ? '' : result.error || result.parseError || chart?.error?.description || ''
  };
}

function previousBar(bars, date) {
  return [...bars].filter((bar) => compareIsoDate(bar.date, date) < 0).pop() || null;
}

function barOnOrAfter(bars, date) {
  return bars.find((bar) => compareIsoDate(bar.date, date) >= 0) || null;
}

function barAfter(bars, date) {
  return bars.find((bar) => compareIsoDate(bar.date, date) > 0) || null;
}

async function resolveReaction(task, reportTiming, args) {
  const yahoo = await fetchYahooBars(task.symbol, task.reportDate, task.reportDate, args);
  const bars = yahoo.bars || [];
  let basis = 'unavailable';
  let fromBar = null;
  let toBar = null;
  if (reportTiming === 'bmo' || reportTiming === 'dmh') {
    basis = reportTiming === 'bmo' ? 'same_day_close' : 'during_market_close';
    fromBar = previousBar(bars, task.reportDate);
    toBar = barOnOrAfter(bars, task.reportDate);
  } else if (reportTiming === 'amc') {
    basis = 'next_session_close';
    fromBar = barOnOrAfter(bars, task.reportDate);
    toBar = barAfter(bars, task.reportDate);
  }
  const pct = fromBar && toBar ? pctChange(fromBar.close, toBar.close) : null;
  return {
    basis: pct === null ? 'unavailable' : basis,
    percent: pct,
    fromDate: fromBar?.date || '',
    fromClose: fromBar?.close ?? null,
    toDate: toBar?.date || '',
    toClose: toBar?.close ?? null,
    status: pct === null ? 'unavailable' : 'computed',
    note: '',
    source: 'Yahoo Finance Chart API',
    sourceAudit: {
      status: yahoo.status,
      rowCount: bars.length,
      error: yahoo.error
    }
  };
}

async function resolveTask(task, tickerMap, args) {
  const ticker = tickerMap.get(task.symbol);
  if (!ticker) {
    return unresolved(task, 'ticker_not_found_in_sec_company_tickers');
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded(ticker.cik)}.json`;
  const submissions = await fetchJson(submissionsUrl, args);
  if (!submissions.ok || !submissions.data?.filings?.recent) {
    return unresolved(task, 'sec_submissions_unavailable', { submissionsUrl, status: submissions.status, error: submissions.error || submissions.parseError });
  }

  const filing = chooseEarningsFiling(task, submissions.data.filings.recent);
  if (!filing) {
    return unresolved(task, 'earnings_8k_not_found', { submissionsUrl });
  }

  const filingIndex = await fetchFilingIndex(ticker.cik, filing.accessionNumber, args);
  if (!filingIndex.ok || !filingIndex.data) {
    return unresolved(task, 'filing_index_unavailable', { filingIndexUrl: filingIndex.url, status: filingIndex.status, error: filingIndex.error || filingIndex.parseError });
  }

  const exhibitName = chooseExhibit(filingIndex.data);
  if (!exhibitName) {
    return unresolved(task, 'earnings_exhibit_not_found', { filingIndexUrl: filingIndex.url });
  }

  const accessionPath = filing.accessionNumber.replace(/-/g, '');
  const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${cikPath(ticker.cik)}/${accessionPath}/${exhibitName}`;
  const exhibit = await fetchText(sourceUrl, args);
  if (!exhibit.ok) {
    return unresolved(task, 'earnings_exhibit_unavailable', { sourceUrl, status: exhibit.status, error: exhibit.error });
  }

  const text = cleanText(exhibit.body);
  const eps = extractEps(text);
  // Company releases may report GAAP, adjusted, and special-item EPS in the
  // same exhibit; reconcile to the queued task before classifying beat/miss.
  const comparableEps = resolveComparableEps(eps, task, text);
  const backup = earningsApiBackup(task);
  const revenueActual = extractRevenue(text);
  const reportTiming = extractReportTiming(filing);
  const reaction = await resolveReaction(task, reportTiming, args);
  const status = Number.isFinite(comparableEps.actual) && Number.isFinite(revenueActual) ? 'resolved' : 'needs_review';
  const notes = [
    Number.isFinite(comparableEps.estimate)
      ? 'EarningsAPI company endpoint supplied secondary-recovery EPS consensus; revenue consensus is used only when present in the deterministic backup row.'
      : 'Company release supplied reported actuals; consensus estimates remain unavailable unless supplied by another deterministic source.'
  ];
  if (comparableEps.adjustment?.note) notes.push(comparableEps.adjustment.note);
  if (comparableEps.comparisonSource === 'unreconciled_earningsapi_company') {
    notes.push('EarningsAPI EPS actual did not reconcile to the SEC/company-release EPS basis; avoid EPS beat/miss classification without review.');
  }

  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status,
    sourceType: 'sec_8k_exhibit_99_1',
    sourceUrl,
    secFilingUrl: `https://www.sec.gov/Archives/edgar/data/${cikPath(ticker.cik)}/${accessionPath}/${filing.primaryDocument}`,
    confidence: status === 'resolved' ? 'high' : 'medium',
    fields: {
      company: task.company,
      fiscalPeriod: extractFiscalPeriod(text, task.reportDate),
      reportTiming,
      eps: {
        actual: comparableEps.actual,
        basis: comparableEps.basis,
        gaapActual: comparableEps.gaapActual,
        gaapBasis: comparableEps.gaapBasis,
        adjustment: comparableEps.adjustment,
        actualSource: comparableEps.actualSource,
        estimate: comparableEps.estimate,
        estimateSource: comparableEps.estimateSource,
        estimateCount: comparableEps.estimateCount,
        comparisonSource: comparableEps.comparisonSource
      },
      revenue: {
        actual: revenueActual,
        estimate: backup.revenue.estimate,
        estimateSource: Number.isFinite(backup.revenue.estimate) ? 'earningsapi_company' : ''
      }
    },
    reaction,
    notes,
    sourceAudit: {
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      filing,
      exhibitName,
      earningsApiCalendar: task.sourceAudit?.earningsApiCalendar || null,
      extractedTextPreview: text.slice(0, 800)
    }
  };
}

function unresolved(task, reason, audit = {}) {
  return {
    taskId: task.id,
    symbol: task.symbol,
    company: task.company,
    reportDate: task.reportDate,
    status: 'unresolved',
    sourceType: '',
    sourceUrl: '',
    secFilingUrl: '',
    confidence: 'low',
    fields: {
      company: task.company,
      fiscalPeriod: '',
      reportTiming: 'unknown',
      eps: {
        actual: null,
        basis: '',
        gaapActual: null,
        gaapBasis: '',
        adjustment: null,
        actualSource: '',
        estimate: null,
        estimateSource: '',
        estimateCount: '',
        comparisonSource: ''
      },
      revenue: {
        actual: null,
        estimate: null,
        estimateSource: ''
      }
    },
    reaction: {
      basis: 'unavailable',
      percent: null,
      fromDate: '',
      fromClose: null,
      toDate: '',
      toClose: null,
      status: 'unavailable',
      note: '',
      source: '',
      sourceAudit: {}
    },
    notes: [reason],
    sourceAudit: audit
  };
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const source = readJson(args.input);
  const companyReleaseTasks = Array.isArray(source.companyReleaseTasks) ? source.companyReleaseTasks : [];
  const tickerMap = await loadTickerMap(args);
  const companyReleaseResolutions = [];
  for (const task of companyReleaseTasks) {
    companyReleaseResolutions.push(await resolveTask(task, tickerMap, args));
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: source.generatedAt,
    sourceArtifact: path.relative(root, args.input),
    sourceRange: source.range,
    companyReleaseResolutions,
    summary: {
      total: companyReleaseResolutions.length,
      resolved: companyReleaseResolutions.filter((item) => item.status === 'resolved').length,
      needsReview: companyReleaseResolutions.filter((item) => item.status === 'needs_review').length,
      unresolved: companyReleaseResolutions.filter((item) => item.status === 'unresolved').length
    },
    outputPath: args.output
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);

  process.stdout.write(`Earnings Company-Release Resolution Summary
===========================================
Tasks: ${payload.summary.total}
Resolved: ${payload.summary.resolved}
Needs review: ${payload.summary.needsReview}
Unresolved: ${payload.summary.unresolved}
Output: ${args.output}
`);
  if (!args.compact) {
    for (const item of companyReleaseResolutions) {
      process.stdout.write(`${item.symbol} ${item.status} EPS ${item.fields.eps?.actual ?? 'n/a'} revenue ${item.fields.revenue?.actual ?? 'n/a'} ${item.sourceUrl}\n`);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
