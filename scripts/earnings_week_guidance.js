#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { isDisplayEligibleEarningsRow } = require('./earnings_week_contract');
const { isIsoDate } = require('./calendar_contract');
const { atomicWriteJson } = require('./staging_writer');
const { mapConcurrent } = require('./fetch_concurrency');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'generated', 'earnings_week.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'generated', 'editorial', 'earnings_week_guidance.json');
const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_GUIDANCE_CONCURRENCY = 3;
const MAX_DOCUMENTS_PER_ROW = 2;
const MAX_SNIPPETS_PER_DOCUMENT = 8;
const MAX_SNIPPET_LENGTH = 620;
const GUIDANCE_KEYWORDS = [
  'guidance',
  'outlook',
  'expects',
  'expect',
  'forecast',
  'forecasts',
  'full-year',
  'full year',
  'fiscal year',
  'third quarter',
  'fourth quarter',
  'next quarter',
  'revenue',
  'sales',
  'eps',
  'earnings per share',
  'margin',
  'free cash flow',
  'capital expenditures',
  'capex'
];
const RELEASE_DESCRIPTION_PATTERN = /\b(?:NEWS|PRESS|EARNINGS?)\s+RELEASE\b|\bRESULTS?\b|\bSHAREHOLDER\s+LETTER\b|\b(?:FINANCIAL|QUARTERLY|INTERIM|ANNUAL|SECOND|THIRD|FOURTH|FIRST)\s+REPORT\b/;

function requestHeaders(headers = {}) {
  return {
    'User-Agent': String(process.env.SEC_USER_AGENT || 'DailyFinancialDashboard/1.0 earnings-week-guidance').trim(),
    Accept: 'application/json,text/html,*/*',
    ...headers
  };
}

function fetchWithTimeout(fetchImpl, url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  return fetchImpl(url, {
    headers: requestHeaders(options.headers),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));
}

async function fetchText(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable in this Node runtime.');
  const started = Date.now();
  const response = await fetchWithTimeout(fetchImpl, url, {
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    headers: options.headers || {}
  });
  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    ms: Date.now() - started,
    body,
    error: response.ok ? '' : `HTTP ${response.status}`
  };
}

async function fetchJson(url, options = {}) {
  const result = await fetchText(url, options);
  if (!result.ok) return { ...result, data: null, parseError: '' };
  try {
    return { ...result, data: JSON.parse(result.body), parseError: '' };
  } catch (error) {
    return { ...result, ok: false, data: null, parseError: error.message };
  }
}

function cikPadded(cik) {
  return String(cik).padStart(10, '0');
}

function cikPath(cik) {
  return String(Number(cik));
}

function archiveBaseUrl(cik, accessionNumber) {
  return `https://www.sec.gov/Archives/edgar/data/${cikPath(cik)}/${String(accessionNumber).replace(/-/g, '')}`;
}

function documentUrl(cik, accessionNumber, documentName) {
  return `${archiveBaseUrl(cik, accessionNumber)}/${encodeURIComponent(documentName)}`;
}

function filingDetailUrl(cik, accessionNumber) {
  return `${archiveBaseUrl(cik, accessionNumber)}/${accessionNumber}-index.htm`;
}

function daysBetween(left, right) {
  return Math.round((new Date(`${right}T00:00:00Z`).getTime() - new Date(`${left}T00:00:00Z`).getTime()) / 86400000);
}

function hasActuals(row) {
  return Number.isFinite(row?.eps?.actual) || Number.isFinite(row?.revenue?.actual);
}

function guidanceTargetRows(week, options = {}) {
  const rows = Array.isArray(week?.rows) ? week.rows : [];
  const targets = rows
    .filter((row) => isDisplayEligibleEarningsRow(row))
    .filter(hasActuals)
    .map((row) => ({
      symbol: String(row.symbol || '').trim().toUpperCase(),
      company: String(row.company || '').trim(),
      reportDate: String(row.reportDate || '').trim(),
      reportTiming: String(row.reportTiming || 'unknown').trim() || 'unknown'
    }))
    .filter((row) => row.symbol && isIsoDate(row.reportDate));
  return Number.isFinite(options.maxRows) ? targets.slice(0, options.maxRows) : targets;
}

async function loadTickerMap(options = {}) {
  const result = await fetchJson('https://www.sec.gov/files/company_tickers.json', options);
  if (!result.ok || !result.data) {
    throw new Error(`Unable to load SEC ticker map: ${result.error || result.parseError || 'empty response'}`);
  }
  const map = new Map();
  for (const item of Object.values(result.data)) {
    const ticker = String(item.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    map.set(ticker, {
      cik: Number(item.cik_str),
      title: String(item.title || '').trim()
    });
  }
  return map;
}

function recentFilingAt(recent, index) {
  return {
    accessionNumber: recent.accessionNumber[index],
    primaryDocument: recent.primaryDocument[index],
    filingDate: recent.filingDate[index],
    acceptanceDateTime: recent.acceptanceDateTime?.[index] || '',
    form: recent.form[index],
    items: String(recent.items?.[index] || '')
  };
}

function filingScore(row, filing) {
  const distance = Math.abs(daysBetween(row.reportDate, filing.filingDate));
  if (distance > 3) return null;
  const items = filing.items;
  if (filing.form === '8-K' && /\b2\.02\b/.test(items)) return { rank: 0, distance };
  if (filing.form === '8-K' && /\b(?:7\.01|9\.01)\b/.test(items)) return { rank: 10, distance };
  if (filing.form === '6-K') return { rank: 20, distance };
  return null;
}

function chooseEarningsFiling(row, recent) {
  if (!recent || !Array.isArray(recent.accessionNumber)) return null;
  const filings = [];
  for (let index = 0; index < recent.accessionNumber.length; index += 1) {
    const filing = recentFilingAt(recent, index);
    if (!['8-K', '6-K'].includes(filing.form)) continue;
    if (!isIsoDate(filing.filingDate)) continue;
    const score = filingScore(row, filing);
    if (!score) continue;
    filings.push({ ...filing, ...score });
  }
  filings.sort((left, right) => (
    left.rank - right.rank
    || left.distance - right.distance
    || left.filingDate.localeCompare(right.filingDate)
    || left.accessionNumber.localeCompare(right.accessionNumber)
  ));
  return filings[0] || null;
}

async function fetchFilingIndex(cik, accessionNumber, options = {}) {
  const url = `${archiveBaseUrl(cik, accessionNumber)}/index.json`;
  const result = await fetchJson(url, options);
  return { ...result, url };
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function cleanText(html) {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function basenameFromHref(href) {
  const value = String(href || '').trim();
  if (!value || /^https?:\/\//i.test(value)) {
    try {
      return path.basename(new URL(value).pathname);
    } catch {
      return '';
    }
  }
  return path.basename(value.split('#')[0].split('?')[0]);
}

function extractAnchorCandidates(primaryHtml) {
  const html = String(primaryHtml || '');
  const anchors = [];
  const regex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const name = basenameFromHref(match[1]);
    if (!/\.html?$/i.test(name)) continue;
    const rowStart = html.lastIndexOf('<tr', match.index);
    const rowEnd = html.indexOf('</tr>', regex.lastIndex);
    const contextHtml = rowStart >= 0 && rowEnd >= regex.lastIndex
      ? html.slice(rowStart, rowEnd + 5)
      : html.slice(Math.max(0, match.index - 180), Math.min(html.length, regex.lastIndex + 180));
    const context = cleanText(contextHtml);
    const label = cleanText(match[2]);
    anchors.push({ name, label, context });
  }
  return anchors;
}

function cellTexts(rowHtml) {
  const cells = [];
  const regex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let match;
  while ((match = regex.exec(rowHtml))) {
    cells.push(cleanText(match[1]));
  }
  return cells;
}

function extractFilingDetailDocuments(detailHtml) {
  const html = String(detailHtml || '');
  const rows = [];
  const regex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = regex.exec(html))) {
    const rowHtml = match[1];
    const href = rowHtml.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1] || '';
    const name = basenameFromHref(href);
    if (!name) continue;
    const cells = cellTexts(rowHtml);
    if (cells.length < 4) continue;
    const numericSizeIndex = cells.findLastIndex((cell) => /^\d+$/.test(cell.replace(/,/g, '')));
    const sizeIndex = numericSizeIndex >= 0 ? numericSizeIndex : cells.length - 1;
    const typeIndex = Math.max(0, sizeIndex - 1);
    rows.push({
      sequence: cells[0] || '',
      description: cells[1] || '',
      name,
      type: cells[typeIndex] || '',
      size: Number(String(cells[sizeIndex] || '').replace(/,/g, '')) || 0
    });
  }
  return rows;
}

function metadataPriority(record) {
  const name = String(record?.name || '');
  const type = String(record?.type || '').toUpperCase();
  const description = String(record?.description || '').toUpperCase();
  const haystack = `${name} ${type} ${description}`.toLowerCase();
  if (/\.(?:xml|xsd|jpg|jpeg|gif|png|css|js)$/i.test(name)) return null;
  if (/XBRL|XML|GRAPHIC|EX-101|SCHEMA|LINKBASE/.test(`${type} ${description}`)) return null;
  if (/\bINVESTOR\s+RELATIONS\s+DATA\s+SUMMARY\b/.test(description)) return null;
  if (/\b(?:PRESENTATION|SUPPLEMENT(?:AL)?|SLIDES?|GLOSSARY)\b/.test(description)) return null;
  if (!/\.html?$/i.test(name)) return null;

  let priority = 70;
  if (/\bEX-?99\.?1\b/i.test(type) || /\b(?:exhibit\s*)?99\.?1\b|ex-?99\.?1|ex991|xex991/.test(haystack)) priority = 20;
  else if (/\bEX-?99\.?2\b/i.test(type) || /\b(?:exhibit\s*)?99\.?2\b|ex-?99\.?2|ex992|xex992/.test(haystack)) priority = 40;
  else if (/EX-?99/i.test(type) || /ex99|exhibit99/i.test(haystack)) priority = 55;
  if (priority > 20 && /presentatio|supplement|slides?|glossary/i.test(name)) return null;
  if (priority > 40 && /\bEX-?99\.?[3-9]\b|ex99[3-9]|xex99[3-9]/i.test(`${type} ${name}`) && !RELEASE_DESCRIPTION_PATTERN.test(description)) return null;

  if (RELEASE_DESCRIPTION_PATTERN.test(description)) priority -= 35;
  if (/\b(?:GRAPHIC|XBRL|XML)\b/.test(description)) priority += 90;
  if (/\b99\.?1\b/.test(description)) priority -= 20;
  if (/\b99\.?2\b/.test(description)) priority -= 5;
  if (/\b(?:earnings?|release|press|results?|financial)\b/.test(haystack)) priority -= 5;
  return priority >= 100 ? null : priority;
}

function fallbackPriority(name, sourceText = '') {
  const haystack = `${name} ${sourceText}`.toLowerCase();
  if (/investor relations data summary|presentatio|supplement|slides?|glossary/.test(haystack)) return null;
  if (/\b(?:exhibit\s*)?99\.?[3-9]\b|ex-?99\.?[3-9]|ex99[3-9]|xex99[3-9]/.test(haystack)) return null;
  if (/\b(?:exhibit\s*)?99\.?1\b|ex-?99\.?1|ex991|xex991/.test(haystack)) return 20;
  if (/\b(?:exhibit\s*)?99\.?2\b|ex-?99\.?2|ex992|xex992/.test(haystack)) return 40;
  if (/\bearnings?\b|\brelease\b|\bpress\b|\bresults?\b|\bfinancial\b/.test(haystack)) return 60;
  return 90;
}

function isIgnoredDocument(name, primaryDocument, options = {}) {
  const lower = String(name || '').toLowerCase();
  return !/\.html?$/.test(lower)
    || (!options.allowPrimaryDocument && lower === String(primaryDocument || '').toLowerCase())
    || /-index(?:-headers)?\.html?$/.test(lower)
    || /^r\d+\.html?$/i.test(name)
    || /^(index|filing-summary)\.html?$/i.test(name);
}

function chooseExhibitDocuments(indexData, filing = {}, primaryHtml = '', detailHtml = '') {
  const items = Array.isArray(indexData?.directory?.item) ? indexData.directory.item : [];
  const itemByName = new Map(items.map((item) => [String(item.name || ''), item]));
  const tableCandidates = extractFilingDetailDocuments(detailHtml)
    .filter((record) => !isIgnoredDocument(record.name, filing.primaryDocument, {
      allowPrimaryDocument: filing.form === '6-K'
    }))
    .map((record) => {
      const item = itemByName.get(record.name) || {};
      const priority = metadataPriority(record);
      if (priority === null) return null;
      return {
        name: record.name,
        type: /^EX-?99\.?2$/i.test(record.type) ? 'exhibit_99_2' : /^EX-?99\.?1$/i.test(record.type) ? 'exhibit_99_1' : 'possible_earnings_release',
        priority,
        size: Number(record.size || item.size) || 0,
        source: 'filing_detail_table',
        description: record.description,
        exhibitType: record.type
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.priority - right.priority || right.size - left.size || left.name.localeCompare(right.name));
  if (tableCandidates.length) return tableCandidates.slice(0, MAX_DOCUMENTS_PER_ROW);

  const candidates = new Map();
  const addCandidate = (name, sourceText, source) => {
    if (isIgnoredDocument(name, filing.primaryDocument)) return;
    const item = itemByName.get(name) || {};
    const priority = fallbackPriority(name, sourceText);
    if (priority === null) return;
    const previous = candidates.get(name);
    const candidate = {
      name,
      type: priority === 20 ? 'exhibit_99_1' : priority === 40 ? 'exhibit_99_2' : 'possible_earnings_release',
      priority,
      size: Number(item.size) || 0,
      source
    };
    if (!previous || candidate.priority < previous.priority || candidate.size > previous.size) {
      candidates.set(name, candidate);
    }
  };

  for (const anchor of extractAnchorCandidates(primaryHtml)) {
    addCandidate(anchor.name, `${anchor.label} ${anchor.context}`, 'primary_document');
  }
  for (const item of items) {
    addCandidate(String(item.name || ''), String(item.name || ''), 'filing_index');
  }

  return [...candidates.values()]
    .sort((left, right) => left.priority - right.priority || right.size - left.size || left.name.localeCompare(right.name))
    .slice(0, MAX_DOCUMENTS_PER_ROW);
}

function guidanceSignalsFromText(text, options = {}) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  const chunks = normalized
    .split(/(?<=[.!?])\s+(?=[A-Z0-9$])|\s{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 40);
  const scored = [];
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const keyword of GUIDANCE_KEYWORDS) {
      if (lower.includes(keyword)) score += keyword.includes('guidance') || keyword.includes('outlook') ? 4 : 1;
    }
    if (!score) continue;
    scored.push({
      score,
      text: chunk.length > MAX_SNIPPET_LENGTH ? `${chunk.slice(0, MAX_SNIPPET_LENGTH - 1).trim()}...` : chunk
    });
  }
  scored.sort((left, right) => right.score - left.score || left.text.length - right.text.length);
  const seen = new Set();
  const snippets = [];
  for (const item of scored) {
    const key = item.text.toLowerCase().slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push({ text: item.text, score: item.score });
    if (snippets.length >= (options.maxSnippets || MAX_SNIPPETS_PER_DOCUMENT)) break;
  }
  return snippets;
}

async function buildRowEvidence(row, tickerMap, options = {}) {
  const ticker = tickerMap.get(row.symbol);
  if (!ticker) {
    return {
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'no_sec_ticker',
      documents: [],
      guidanceSignalCount: 0,
      message: 'Ticker was not found in SEC company_tickers.json.'
    };
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${cikPadded(ticker.cik)}.json`;
  const submissions = await fetchJson(submissionsUrl, options);
  if (!submissions.ok || !submissions.data?.filings?.recent) {
    return {
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'submissions_unavailable',
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      submissionsUrl,
      documents: [],
      guidanceSignalCount: 0,
      message: submissions.error || submissions.parseError || 'SEC submissions response was unavailable.'
    };
  }
  const filing = chooseEarningsFiling(row, submissions.data.filings.recent);
  if (!filing) {
    return {
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'filing_not_found',
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      submissionsUrl,
      documents: [],
      guidanceSignalCount: 0,
      message: 'No same-event 8-K or 6-K filing was found within three calendar days.'
    };
  }
  const filingIndex = await fetchFilingIndex(ticker.cik, filing.accessionNumber, options);
  if (!filingIndex.ok || !filingIndex.data) {
    return {
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'filing_index_unavailable',
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      filing,
      filingIndexUrl: filingIndex.url,
      documents: [],
      guidanceSignalCount: 0,
      message: filingIndex.error || filingIndex.parseError || 'SEC filing index was unavailable.'
    };
  }

  const detailUrl = filingDetailUrl(ticker.cik, filing.accessionNumber);
  const filingDetail = await fetchText(detailUrl, options);
  const primaryUrl = documentUrl(ticker.cik, filing.accessionNumber, filing.primaryDocument);
  const primary = await fetchText(primaryUrl, options);
  const exhibitCandidates = chooseExhibitDocuments(
    filingIndex.data,
    filing,
    primary.ok ? primary.body : '',
    filingDetail.ok ? filingDetail.body : ''
  );
  if (!exhibitCandidates.length) {
    return {
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'exhibit_not_found',
      cik: ticker.cik,
      secCompanyTitle: ticker.title,
      filing,
      filingUrl: primaryUrl,
      filingDetailUrl: detailUrl,
      filingIndexUrl: filingIndex.url,
      documents: [],
      guidanceSignalCount: 0,
      message: 'No earnings-release exhibit document could be identified.'
    };
  }

  const documents = [];
  for (const candidate of exhibitCandidates) {
    const url = documentUrl(ticker.cik, filing.accessionNumber, candidate.name);
    const document = await fetchText(url, options);
    if (!document.ok) {
      documents.push({
        name: candidate.name,
        type: candidate.type,
        source: candidate.source,
        description: candidate.description || '',
        exhibitType: candidate.exhibitType || '',
        priority: candidate.priority,
        url,
        status: 'document_unavailable',
        snippets: [],
        message: document.error
      });
      continue;
    }
    const snippets = guidanceSignalsFromText(document.body);
    documents.push({
      name: candidate.name,
      type: candidate.type,
      source: candidate.source,
      description: candidate.description || '',
      exhibitType: candidate.exhibitType || '',
      priority: candidate.priority,
      url,
      status: 'available',
      snippets
    });
  }
  const guidanceSignalCount = documents.reduce((sum, document) => sum + document.snippets.length, 0);
  return {
    key: `${row.symbol}:${row.reportDate}`,
    symbol: row.symbol,
    company: row.company,
    reportDate: row.reportDate,
    reportTiming: row.reportTiming,
    status: documents.some((document) => document.status === 'available') ? 'available' : 'document_unavailable',
    cik: ticker.cik,
    secCompanyTitle: ticker.title,
    filing,
    filingUrl: primaryUrl,
    filingDetailUrl: detailUrl,
    filingIndexUrl: filingIndex.url,
    documents,
    guidanceSignalCount
  };
}

function summarizeEvidenceRows(rows, targetCount, skippedCount) {
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return {
    targetCount,
    skippedNoActuals: skippedCount,
    available: byStatus.available || 0,
    guidanceSignalCount: rows.reduce((sum, row) => sum + (row.guidanceSignalCount || 0), 0),
    byStatus
  };
}

async function buildEarningsGuidanceEvidencePayload(week, options = {}) {
  const generatedAt = new Date(options.asOf || Date.now()).toISOString();
  const allRows = Array.isArray(week?.rows) ? week.rows : [];
  const targets = guidanceTargetRows(week, options);
  const payload = {
    schemaVersion: 1,
    generatedAt,
    source: 'sec_edgar',
    sourceUse: 'editorial_guidance_evidence',
    sourceArtifact: options.sourceArtifact || 'generated/earnings_week.json',
    range: week?.range || null,
    rows: [],
    summary: summarizeEvidenceRows([], targets.length, allRows.filter((row) => isDisplayEligibleEarningsRow(row) && !hasActuals(row)).length)
  };
  if (!targets.length) return payload;
  if (options.networkDisabled || process.env.DASHBOARD_TEST_NO_NETWORK === '1') {
    payload.rows = targets.map((row) => ({
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'network_disabled',
      documents: [],
      guidanceSignalCount: 0,
      message: 'SEC guidance evidence fetch disabled for this test run.'
    }));
    payload.summary = summarizeEvidenceRows(payload.rows, targets.length, payload.summary.skippedNoActuals);
    return payload;
  }

  let tickerMap;
  try {
    tickerMap = await loadTickerMap(options);
  } catch (error) {
    payload.rows = targets.map((row) => ({
      key: `${row.symbol}:${row.reportDate}`,
      symbol: row.symbol,
      company: row.company,
      reportDate: row.reportDate,
      status: 'ticker_map_unavailable',
      documents: [],
      guidanceSignalCount: 0,
      message: error.message
    }));
    payload.summary = summarizeEvidenceRows(payload.rows, targets.length, payload.summary.skippedNoActuals);
    return payload;
  }

  payload.rows = await mapConcurrent(targets, options.concurrency || DEFAULT_GUIDANCE_CONCURRENCY, async (row) => {
    try {
      return await buildRowEvidence(row, tickerMap, options);
    } catch (error) {
      return {
        key: `${row.symbol}:${row.reportDate}`,
        symbol: row.symbol,
        company: row.company,
        reportDate: row.reportDate,
        status: 'error',
        documents: [],
        guidanceSignalCount: 0,
        message: error.message
      };
    }
  });
  payload.summary = summarizeEvidenceRows(payload.rows, targets.length, payload.summary.skippedNoActuals);
  return payload;
}

function buildEarningsGuidanceEvidenceIndex(payload, outputPath = DEFAULT_OUTPUT) {
  const relativePath = path.relative(ROOT, outputPath).replace(/\\/g, '/');
  return {
    schemaVersion: 1,
    source: payload.source,
    sourceUse: payload.sourceUse,
    artifact: relativePath,
    generatedAt: payload.generatedAt,
    summary: payload.summary,
    rows: (payload.rows || []).map((row) => ({
      key: row.key,
      symbol: row.symbol,
      reportDate: row.reportDate,
      status: row.status,
      documents: Array.isArray(row.documents) ? row.documents.length : 0,
      guidanceSignalCount: row.guidanceSignalCount || 0,
      primaryUrl: row.documents?.find((document) => document.status === 'available')?.url || row.filingUrl || '',
      evidenceRef: `${relativePath}#${row.key}`
    }))
  };
}

async function writeEarningsGuidanceEvidence(week, outputPath = DEFAULT_OUTPUT, options = {}) {
  const payload = await buildEarningsGuidanceEvidencePayload(week, {
    ...options,
    sourceArtifact: options.sourceArtifact || 'generated/earnings_week.json'
  });
  atomicWriteJson(outputPath, payload);
  return {
    payload,
    index: buildEarningsGuidanceEvidenceIndex(payload, outputPath)
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRows: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') {
      args.input = path.resolve(process.cwd(), argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--output') {
      args.output = path.resolve(process.cwd(), argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--max-rows') {
      args.maxRows = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: node scripts/earnings_week_guidance.js [options]

Options:
  --input PATH       Earnings week JSON to read (default: generated/earnings_week.json)
  --output PATH      Evidence sidecar to write (default: generated/editorial/earnings_week_guidance.json)
  --timeout-ms N     Per-request SEC timeout (default: ${DEFAULT_TIMEOUT_MS})
  --max-rows N       Optional diagnostic row limit
`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const week = readJson(args.input);
  const { payload } = await writeEarningsGuidanceEvidence(week, args.output, {
    timeoutMs: args.timeoutMs,
    maxRows: args.maxRows
  });
  process.stdout.write(`Earnings guidance evidence written to ${args.output}\n`);
  process.stdout.write(`Rows: ${payload.rows.length}; available: ${payload.summary.available}; guidance signals: ${payload.summary.guidanceSignalCount}\n`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  buildEarningsGuidanceEvidenceIndex,
  chooseEarningsFiling,
  chooseExhibitDocuments,
  guidanceSignalsFromText,
  run,
  writeEarningsGuidanceEvidence
};
