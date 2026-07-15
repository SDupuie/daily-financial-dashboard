const SCHEDULED_WINDOW_NAMES = new Set(['morning', 'afternoon']);
const { isIsoDate, isIsoDateTime } = require('./calendar_contract');

const NEWS_COVERAGE_REASON = 'insufficient_qualifying_fresh_coverage';
const NEWS_COVERAGE_POLICIES = Object.freeze({
  stories: Object.freeze({ label: 'stories', minimum: 9, maximum: 9 }),
  cryptoNotes: Object.freeze({ label: 'crypto.notes', minimum: 4, maximum: 6 }),
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

function sharedFuturesReferenceDate(futures) {
  return sharedFuturesDate(futures, 'referenceDate');
}

function sharedFuturesSessionDate(futures) {
  return sharedFuturesDate(futures, 'sessionDate');
}

function futuresStoryPublicationWindow(sectionTitle, editionId, now, futures) {
  const runAt = isIsoDateTime(editionId) ? new Date(editionId) : now;
  const sessionDate = sharedFuturesSessionDate(futures);
  const [year, month, day] = sessionDate.split('-').map(Number);
  const eastern = sessionDate ? { year, month, day } : zonedDateParts(runAt, 'America/New_York');
  if (sectionTitle === 'Pre-Market Futures') {
    const referenceDate = sharedFuturesReferenceDate(futures);
    if (!referenceDate) return null;
    const [year, month, day] = referenceDate.split('-').map(Number);
    return {
      start: zonedDateTime({ year, month, day, hour: 16, minute: 0 }, 'America/New_York'),
      end: runAt,
      description: 'the fetched prior U.S. regular-session close and the dashboard run time'
    };
  }
  if (sectionTitle === 'Session Futures') {
    const start = zonedDateTime({ ...eastern, hour: 9, minute: 30 }, 'America/New_York');
    const marketClose = zonedDateTime({ ...eastern, hour: 16, minute: 0 }, 'America/New_York');
    return {
      start,
      end: new Date(Math.min(runAt.getTime(), marketClose.getTime())),
      description: 'the current U.S. regular-session open and the earlier of the regular-session close or dashboard run time'
    };
  }
  return null;
}

function newsCoverageState(count, policy, now) {
  if (count >= policy.minimum) return { status: 'complete' };
  return {
    status: 'partial',
    reason: NEWS_COVERAGE_REASON,
    checkedAt: now.toISOString()
  };
}

function applyNewsCoverageState(data, { now = new Date() } = {}) {
  const storiesCount = Array.isArray(data?.stories) ? data.stories.length : 0;
  data.storiesCoverage = newsCoverageState(storiesCount, NEWS_COVERAGE_POLICIES.stories, now);
  if (data?.crypto && typeof data.crypto === 'object' && !Array.isArray(data.crypto)) {
    const cryptoCount = Array.isArray(data.crypto.notes) ? data.crypto.notes.length : 0;
    data.crypto.notesCoverage = newsCoverageState(cryptoCount, NEWS_COVERAGE_POLICIES.cryptoNotes, now);
  }
  if (data?.futuresModule && typeof data.futuresModule === 'object' && !Array.isArray(data.futuresModule)) {
    const futuresCount = Array.isArray(data.futuresModule.stories) ? data.futuresModule.stories.length : 0;
    data.futuresModule.storiesCoverage = newsCoverageState(futuresCount, NEWS_COVERAGE_POLICIES.futuresStories, now);
  }
}

function validateNewsCoverageState(coverage, count, policy, { allowIncomplete = false } = {}) {
  const errors = [];
  const coverageLabel = policy.label === 'stories' ? 'storiesCoverage' : `${policy.label}Coverage`;
  if (count > policy.maximum) {
    errors.push(`${policy.label} must contain no more than ${policy.maximum} qualifying fresh ${policy.maximum === 1 ? 'item' : 'items'}.`);
  }
  if (coverage === undefined) {
    if (!allowIncomplete && count < policy.minimum) {
      errors.push(`${coverageLabel} must record updater-derived partial coverage when ${policy.label} is below its target.`);
    }
    return errors;
  }
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    errors.push(`${coverageLabel} must record complete or partial coverage.`);
    return errors;
  }
  if (coverage.status === 'complete') {
    if (count < policy.minimum || count > policy.maximum) {
      errors.push(`${coverageLabel}.status can be complete only when ${policy.label} contains ${policy.minimum === policy.maximum ? policy.minimum : `${policy.minimum}-${policy.maximum}`} qualifying fresh items.`);
    }
    if (coverage.reason !== undefined || coverage.checkedAt !== undefined) {
      errors.push(`${coverageLabel} complete state must not retain partial-coverage reason or checkedAt fields.`);
    }
    return errors;
  }
  if (coverage.status !== 'partial') {
    errors.push(`${coverageLabel}.status must be complete or partial.`);
    return errors;
  }
  if (count >= policy.minimum) {
    errors.push(`${coverageLabel}.status must be complete once ${policy.label} reaches its target minimum of ${policy.minimum}.`);
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

function sanitizeNewsBaseline(value) {
  const baseline = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    lastScheduledUpdateAt: typeof baseline.lastScheduledUpdateAt === 'string'
      ? baseline.lastScheduledUpdateAt
      : null,
    lastScheduledWindow: typeof baseline.lastScheduledWindow === 'string'
      ? baseline.lastScheduledWindow
      : null,
    previousScheduledStoryIds: [...arrayStringSet(baseline.previousScheduledStoryIds)].sort(),
    currentScheduledStoryIds: [...arrayStringSet(baseline.currentScheduledStoryIds)].sort()
  };
}

function comparisonStoryIdsForManualRun(baseline) {
  const previous = arrayStringSet(baseline.previousScheduledStoryIds);
  return previous.size ? previous : arrayStringSet(baseline.currentScheduledStoryIds);
}

function markNewsItemsNewSinceBaseline(items, comparisonIds) {
  const hasComparison = comparisonIds.size > 0;
  return (Array.isArray(items) ? items : []).map((story) => {
    const next = story && typeof story === 'object' ? { ...story } : {};
    const id = storyIdentity(next);
    if (hasComparison && id && !comparisonIds.has(id)) {
      next.isNewSinceScheduledUpdate = true;
    } else {
      delete next.isNewSinceScheduledUpdate;
    }
    return next;
  });
}

function markStoriesNewSinceBaseline(data, comparisonIds) {
  data.stories = markNewsItemsNewSinceBaseline(data.stories, comparisonIds);
  if (data.crypto && typeof data.crypto === 'object' && !Array.isArray(data.crypto)) {
    data.crypto = {
      ...data.crypto,
      notes: markNewsItemsNewSinceBaseline(data.crypto.notes, comparisonIds)
    };
  }
}

function applyScheduledNewsBaseline(data, previousData, { scheduled = false, scheduledWindow = '', now = new Date() } = {}) {
  const previousBaseline = sanitizeNewsBaseline(previousData?.newsBaseline ?? data.newsBaseline);
  // Manual runs can highlight stories that are new since the last scheduled run,
  // but only scheduled runs advance the baseline used by tomorrow's comparison.
  const comparisonIds = scheduled
    ? arrayStringSet(previousBaseline.currentScheduledStoryIds)
    : comparisonStoryIdsForManualRun(previousBaseline);

  markStoriesNewSinceBaseline(data, comparisonIds);

  if (scheduled) {
    if (!SCHEDULED_WINDOW_NAMES.has(scheduledWindow)) {
      throw new Error('Scheduled finalization requires --morning or --afternoon to record the completed window.');
    }
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
  canonicalStoryUrl,
  dashboardNewsItems,
  futuresStoryPublicationWindow,
  markNewsItemsNewSinceBaseline,
  normalizeStoryTitle,
  sanitizeNewsBaseline,
  sortedDashboardNewsIds,
  storyIdentity,
  sharedFuturesReferenceDate,
  sharedFuturesSessionDate,
  validateNewsCoverageState
};
