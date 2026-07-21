const SCHEDULED_WINDOW_NAMES = new Set(['morning', 'afternoon']);
const { isIsoDate, isIsoDateTime } = require('./calendar_contract');

const NEWS_COVERAGE_REASON = 'insufficient_qualifying_fresh_coverage';
const NEWS_COVERAGE_POLICIES = Object.freeze({
  stories: Object.freeze({ label: 'stories', minimum: 9, maximum: 9 }),
  cryptoNotes: Object.freeze({ label: 'crypto.notes', minimum: 6, maximum: 6 }),
  futuresStories: Object.freeze({ label: 'futuresModule.stories', minimum: 3, maximum: 3 })
});
const MONDAY_MORNING_NEWS_START_MINUTES = 7 * 60 + 45;
const MONDAY_MORNING_NEWS_END_MINUTES = 9 * 60;

function chicagoDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  const hour = Number(part('hour'));
  const minute = Number(part('minute'));
  return {
    weekday: part('weekday'),
    isoDate: `${part('year')}-${part('month')}-${part('day')}`,
    clockMinutes: Number.isFinite(hour) && Number.isFinite(minute) ? (hour % 24) * 60 + minute : null
  };
}

function chicagoIsoDate(date) {
  return chicagoDateParts(date).isoDate;
}

function allowedNewsDates(now = new Date()) {
  const current = chicagoDateParts(now);
  const allowed = new Set([current.isoDate, chicagoIsoDate(new Date(now.getTime() - 86400000))]);
  if (current.weekday === 'Mon'
    && current.clockMinutes >= MONDAY_MORNING_NEWS_START_MINUTES
    && current.clockMinutes <= MONDAY_MORNING_NEWS_END_MINUTES) {
    allowed.add(chicagoIsoDate(new Date(now.getTime() - 2 * 86400000)));
  }
  return allowed;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour') % 24, minute: part('minute'), second: part('second') };
}

function zonedDateTime({ year, month, day, hour, minute }, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetParts = zonedDateParts(new Date(utcGuess), timeZone);
  const observedAsUtc = Date.UTC(offsetParts.year, offsetParts.month - 1, offsetParts.day, offsetParts.hour, offsetParts.minute, offsetParts.second);
  return new Date(utcGuess - (observedAsUtc - utcGuess));
}

function sharedFuturesDate(futures, field) {
  const dates = (Array.isArray(futures) ? futures : [])
    .filter((future) => future?.availability?.status !== 'unavailable')
    .map((future) => String(future?.raw?.[field] || '').trim());
  if (!dates.length || dates.some((date) => !isIsoDate(date))) return '';
  return new Set(dates).size === 1 ? dates[0] : '';
}

function sharedFuturesSessionDate(futures) {
  return sharedFuturesDate(futures, 'sessionDate');
}

function addIsoDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoDateRange(startDate, endDate) {
  if (!isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) return [];
  const dates = [];
  for (let date = startDate; date <= endDate; date = addIsoDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function futuresStoryPublicationWindow(sectionTitle, editionId, now, futures) {
  const runAt = isIsoDateTime(editionId) ? new Date(editionId) : now;
  if (sectionTitle === 'Pre-Market Futures') {
    const runDate = chicagoDateParts(runAt).isoDate;
    const startDate = addIsoDays(runDate, -1);
    const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
    const start = zonedDateTime({ year: startYear, month: startMonth, day: startDay, hour: 17, minute: 0 }, 'America/Chicago');
    const [endYear, endMonth, endDay] = runDate.split('-').map(Number);
    const cashOpen = zonedDateTime({ year: endYear, month: endMonth, day: endDay, hour: 8, minute: 30 }, 'America/Chicago');
    const end = new Date(Math.min(runAt.getTime(), cashOpen.getTime()));
    const endDate = chicagoIsoDate(end);
    return {
      startDate,
      endDate,
      dates: isoDateRange(startDate, endDate),
      start,
      end,
      description: 'the overnight futures open and the earlier of dashboard run time or the cash open'
    };
  }
  if (sectionTitle === 'Session Futures') {
    const sessionDate = sharedFuturesSessionDate(futures);
    if (!sessionDate) return null;
    const [year, month, day] = sessionDate.split('-').map(Number);
    // The displayed futures rows own sessionDate; a late Apply should not reshape
    // story eligibility from wall-clock or edition timestamps.
    return {
      sessionDate,
      startDate: sessionDate,
      endDate: sessionDate,
      dates: [sessionDate],
      start: zonedDateTime({ year, month, day, hour: 9, minute: 30 }, 'America/New_York'),
      end: zonedDateTime({ year, month, day, hour: 16, minute: 0 }, 'America/New_York'),
      description: 'the displayed U.S. regular-session futures window'
    };
  }
  return null;
}

function candidateInFuturesPublicationWindow(candidate, futuresWindow) {
  if (!futuresWindow) return false;
  const publishedAt = Date.parse(candidate?.publishedAt);
  return candidate?.publishedAtVerified === true
    && Number.isFinite(publishedAt)
    && publishedAt >= futuresWindow.start.getTime()
    && publishedAt <= futuresWindow.end.getTime();
}

function newsCoverageState(count, policy, now) {
  // Complete coverage is represented by absence; persist only partial coverage
  // so generated JSON does not carry a redundant "all clear" object.
  if (count >= policy.minimum) return undefined;
  return {
    status: 'partial',
    reason: NEWS_COVERAGE_REASON,
    checkedAt: now.toISOString()
  };
}

function applyNewsCoverageState(data, { now = new Date() } = {}) {
  const storiesCount = Array.isArray(data?.stories) ? data.stories.length : 0;
  const storiesCoverage = newsCoverageState(storiesCount, NEWS_COVERAGE_POLICIES.stories, now);
  if (storiesCoverage) data.storiesCoverage = storiesCoverage;
  else delete data.storiesCoverage;
  if (data?.crypto && typeof data.crypto === 'object' && !Array.isArray(data.crypto)) {
    const cryptoCount = Array.isArray(data.crypto.notes) ? data.crypto.notes.length : 0;
    const notesCoverage = newsCoverageState(cryptoCount, NEWS_COVERAGE_POLICIES.cryptoNotes, now);
    if (notesCoverage) data.crypto.notesCoverage = notesCoverage;
    else delete data.crypto.notesCoverage;
  }
  if (data?.futuresModule && typeof data.futuresModule === 'object' && !Array.isArray(data.futuresModule)) {
    const futuresCount = Array.isArray(data.futuresModule.stories) ? data.futuresModule.stories.length : 0;
    const futuresCoverage = newsCoverageState(futuresCount, NEWS_COVERAGE_POLICIES.futuresStories, now);
    if (futuresCoverage) data.futuresModule.storiesCoverage = futuresCoverage;
    else delete data.futuresModule.storiesCoverage;
  }
}

function validateNewsCoverageState(coverage, count, policy, { allowIncomplete = false } = {}) {
  const errors = [];
  const coverageLabel = policy.label === 'stories' ? 'storiesCoverage' : `${policy.label}Coverage`;
  if (coverage === undefined) {
    if (!allowIncomplete && count < policy.minimum) {
      errors.push(`${coverageLabel} must record updater-derived partial coverage when ${policy.label} is below its target.`);
    }
    return errors;
  }
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    errors.push(`${coverageLabel} must be a recognized coverage state when present.`);
    return errors;
  }
  if (coverage.status === 'complete') {
    if (count < policy.minimum) {
      errors.push(`${coverageLabel}.status can be complete only when ${policy.label} contains at least ${policy.minimum} item${policy.minimum === 1 ? '' : 's'}.`);
    }
    if (coverage.reason !== undefined || coverage.checkedAt !== undefined) {
      errors.push(`${coverageLabel} complete state must not retain partial-coverage reason or checkedAt fields.`);
    }
    return errors;
  }
  if (coverage.status !== 'partial') {
    errors.push(`${coverageLabel}.status must be partial or a recognized complete marker.`);
    return errors;
  }
  if (count >= policy.minimum) {
    errors.push(`${coverageLabel}.status must not stay partial once ${policy.label} reaches its target minimum of ${policy.minimum}.`);
  }
  if (coverage.reason !== NEWS_COVERAGE_REASON) {
    errors.push(`${coverageLabel}.reason must be ${NEWS_COVERAGE_REASON} when coverage is partial.`);
  }
  if (!isIsoDateTime(coverage.checkedAt)) {
    errors.push(`${coverageLabel}.checkedAt must be an offset-bearing ISO timestamp when coverage is partial.`);
  }
  return errors;
}

function normalizeStoryTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function canonicalStoryUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|\.tsrc$|tsrc$|mod$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function storyIdentity(story) {
  const url = canonicalStoryUrl(story?.url);
  if (url) return `url:${url}`;
  const title = normalizeStoryTitle(story?.title);
  return title ? `title:${title}` : '';
}

function storyIdentitySet(stories) {
  return new Set(
    (Array.isArray(stories) ? stories : [])
      .map(storyIdentity)
      .filter(Boolean)
  );
}

function dashboardNewsItems(data) {
  return [
    ...(Array.isArray(data?.stories) ? data.stories : []),
    ...(Array.isArray(data?.crypto?.notes) ? data.crypto.notes : [])
  ];
}

function sortedDashboardNewsIds(data) {
  return [...storyIdentitySet(dashboardNewsItems(data))].sort();
}

function arrayStringSet(value) {
  return new Set((Array.isArray(value) ? value : []).filter((item) => typeof item === 'string' && item));
}

function validScheduledWindowMarker(value) {
  if (value === null || value === undefined) return true;
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2}):(morning|afternoon)$/);
  return Boolean(match && isIsoDate(match[1]));
}

function validBaselineArray(value) {
  if (!Array.isArray(value)) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

function validNewsBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.lastScheduledUpdateAt !== null
    && value.lastScheduledUpdateAt !== undefined
    && !isIsoDateTime(value.lastScheduledUpdateAt)) return false;
  if (!validScheduledWindowMarker(value.lastScheduledWindow)) return false;
  return validBaselineArray(value.previousScheduledStoryIds)
    && validBaselineArray(value.currentScheduledStoryIds);
}

function sanitizeNewsBaseline(value) {
  const baseline = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    lastScheduledUpdateAt: isIsoDateTime(baseline.lastScheduledUpdateAt)
      ? baseline.lastScheduledUpdateAt
      : null,
    lastScheduledWindow: typeof baseline.lastScheduledWindow === 'string' && validScheduledWindowMarker(baseline.lastScheduledWindow)
      ? baseline.lastScheduledWindow
      : null,
    previousScheduledStoryIds: [...arrayStringSet(baseline.previousScheduledStoryIds)].sort(),
    currentScheduledStoryIds: [...arrayStringSet(baseline.currentScheduledStoryIds)].sort()
  };
}

function applyScheduledNewsBaseline(data, previousData, { scheduled = false, scheduledWindow = '', now = new Date() } = {}) {
  // The baseline stores comparison identities only. Renderers derive the visible
  // "New" badge so individual story rows stay source-shaped.
  const rawBaseline = previousData?.newsBaseline ?? data.newsBaseline;
  const previousBaseline = validNewsBaseline(rawBaseline)
    ? sanitizeNewsBaseline(rawBaseline)
    : sanitizeNewsBaseline(null);
  if (scheduled) {
    if (!SCHEDULED_WINDOW_NAMES.has(scheduledWindow)) {
      throw new Error('Scheduled finalization requires a staged Morning Edition or Afternoon Edition dashboard.');
    }
    // Scheduled runs advance the comparison window; manual/on-demand applies
    // retain the prior baseline so ad hoc repairs do not churn New badges.
    data.newsBaseline = {
      lastScheduledUpdateAt: now.toISOString(),
      lastScheduledWindow: `${chicagoIsoDate(now)}:${scheduledWindow}`,
      previousScheduledStoryIds: [...arrayStringSet(previousBaseline.currentScheduledStoryIds)].sort(),
      currentScheduledStoryIds: sortedDashboardNewsIds(data)
    };
    return;
  }

  data.newsBaseline = previousBaseline;
}

module.exports = {
  NEWS_COVERAGE_POLICIES,
  NEWS_COVERAGE_REASON,
  allowedNewsDates,
  applyNewsCoverageState,
  applyScheduledNewsBaseline,
  candidateInFuturesPublicationWindow,
  canonicalStoryUrl,
  dashboardNewsItems,
  futuresStoryPublicationWindow,
  normalizeStoryTitle,
  sanitizeNewsBaseline,
  sortedDashboardNewsIds,
  storyIdentity,
  sharedFuturesSessionDate,
  validateNewsCoverageState
};
