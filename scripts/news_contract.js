const SCHEDULED_WINDOW_NAMES = new Set(['morning', 'afternoon']);

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
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) {
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

function chicagoIsoDate(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
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
      throw new Error('Scheduled baseline refresh requires --morning or --afternoon to record the completed window.');
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
  applyScheduledNewsBaseline,
  canonicalStoryUrl,
  dashboardNewsItems,
  markNewsItemsNewSinceBaseline,
  normalizeStoryTitle,
  sanitizeNewsBaseline,
  sortedDashboardNewsIds,
  storyIdentity
};
