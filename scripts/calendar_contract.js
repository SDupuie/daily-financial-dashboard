// Calendar rules shared by generated dashboard sections. Keep these UTC-only
// so a local timezone or DST transition cannot move an ISO calendar date.
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
  isoFromDate
};
