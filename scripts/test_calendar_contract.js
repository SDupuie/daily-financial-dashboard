#!/usr/bin/env node

const assert = require('assert/strict');
const {
  addDays,
  compareIsoDate,
  displayDatesForRange,
  isIsoDate,
  isIsoDateTime,
  isIsoTime,
  isSupportedFiveTradingDayRange
} = require('./calendar_contract');

assert.equal(isIsoDate('2026-02-28'), true);
assert.equal(isIsoDate('2026-02-30'), false);
assert.equal(isIsoDateTime('2026-07-10T15:45:00-05:00'), true);
assert.equal(isIsoDateTime('2026-07-10T25:45:00Z'), false);
assert.equal(isIsoDateTime('2026-07-10'), false);
assert.equal(isIsoTime('08:30'), true);
assert.equal(isIsoTime('99:99'), false);
assert.equal(addDays('2026-07-10', 3), '2026-07-13');
assert.equal(compareIsoDate('2026-07-10', '2026-07-13') < 0, true);
assert.equal(isSupportedFiveTradingDayRange('2026-07-13', '2026-07-17'), true);
assert.equal(isSupportedFiveTradingDayRange('2026-07-10', '2026-07-16'), true);
assert.equal(isSupportedFiveTradingDayRange('2026-07-11', '2026-07-17'), false);
assert.deepEqual(displayDatesForRange('2026-07-10', '2026-07-16'), [
  '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16'
]);

console.log('Calendar contract tests passed.');
