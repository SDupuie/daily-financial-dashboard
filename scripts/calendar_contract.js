// Calendar rules shared by generated dashboard sections. ISO-date helpers stay
// UTC-only; zoned helpers require an explicit IANA zone so host locale never
// decides which instant a dashboard contract means.
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  // Generated timestamps must carry an offset; accepting a timezone-free value
  // would let the host machine silently decide which calendar instant it means.
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/);
  if (!match || !isIsoDate(match[1])) return false;
  const [, , hour, minute, second = '0', , offsetHour = '0', offsetMinute = '0'] = match;
  return Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && Number(offsetHour) <= 23
    && Number(offsetMinute) <= 59
    && !Number.isNaN(Date.parse(value));
}

function isIsoTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour <= 23 && minute <= 59;
}

function zonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value || 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') % 24,
    minute: part('minute'),
    second: part('second')
  };
}

function validDateTimeParts(parts) {
  if (!Number.isInteger(parts.year) || parts.year < 1000 || parts.year > 9999
    || !Number.isInteger(parts.month) || parts.month < 1 || parts.month > 12
    || !Number.isInteger(parts.day) || parts.day < 1 || parts.day > 31
    || !Number.isInteger(parts.hour) || parts.hour < 0 || parts.hour > 23
    || !Number.isInteger(parts.minute) || parts.minute < 0 || parts.minute > 59
    || !Number.isInteger(parts.second) || parts.second < 0 || parts.second > 59) return false;
  // Date.UTC rolls impossible calendar dates forward; compare every component
  // back to the input so structured provider timestamps can fail closed.
  const probe = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  return probe.getUTCFullYear() === parts.year
    && probe.getUTCMonth() === parts.month - 1
    && probe.getUTCDate() === parts.day
    && probe.getUTCHours() === parts.hour
    && probe.getUTCMinutes() === parts.minute
    && probe.getUTCSeconds() === parts.second;
}

function sameDateTimeParts(left, right) {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  // This converts one wall-clock reading into UTC. DST-sensitive callers should
  // round-trip with zonedDateParts/sameDateTimeParts when nonexistent local
  // times must be rejected rather than shifted.
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const observed = zonedDateParts(new Date(guess), timeZone);
  const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
  return new Date(guess - (observedAsUtc - guess));
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

function isSupportedFiveTradingDayRange(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return false;
  const weekday = dateFromIso(from).getUTCDay();
  // The Friday bridge intentionally skips the weekend: Friday remains visible
  // until Monday morning while next week's Monday-Thursday is pre-published.
  return (weekday === 1 && addDays(from, 4) === to)
    || (weekday === 5 && addDays(from, 6) === to);
}

function displayDatesForRange(from, to) {
  if (!isSupportedFiveTradingDayRange(from, to)) return [];
  if (dateFromIso(from).getUTCDay() === 1) {
    return Array.from({ length: 5 }, (_item, index) => addDays(from, index));
  }
  return [from, ...[3, 4, 5, 6].map((offset) => addDays(from, offset))];
}

module.exports = {
  addDays,
  compareIsoDate,
  dateFromIso,
  displayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isIsoTime,
  isSupportedFiveTradingDayRange,
  isoFromDate,
  sameDateTimeParts,
  validDateTimeParts,
  zonedDateParts,
  zonedTimeToUtc
};
