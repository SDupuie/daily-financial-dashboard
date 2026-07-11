const { isIsoDate } = require('./calendar_contract');

// Treasury skips weekends and holidays, so validate broad comparison windows rather than exact offsets.
const REQUIRED_YIELD_CURVE_COMPARISONS = [
  { label: '1M ago', minDays: 20, maxDays: 45 },
  { label: '6M ago', minDays: 150, maxDays: 215 }
];

function isFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function isoDayGap(laterDate, earlierDate) {
  if (!isIsoDate(laterDate) || !isIsoDate(earlierDate)) return null;
  const later = Date.parse(`${laterDate}T00:00:00Z`);
  const earlier = Date.parse(`${earlierDate}T00:00:00Z`);
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return null;
  return Math.round((later - earlier) / 86400000);
}

function yieldCurvePointsKey(points) {
  // Duplicate comparison curves can render as one line even when their labels differ.
  return JSON.stringify(points.map((point) => [
    String(point?.label || ''),
    Number(point?.years),
    Number(point?.value)
  ]));
}

function validateYieldCurvePointSet(errors, label, fieldName, points, referencePoints = null) {
  if (points.length < 2) {
    errors.push(`${label}.${fieldName} must contain a Treasury curve.`);
  }
  if (referencePoints && points.length !== referencePoints.length) {
    errors.push(`${label}.${fieldName} must match the current Treasury curve maturity count.`);
  }
  for (const [pointIndex, pointRaw] of points.entries()) {
    const point = pointRaw && typeof pointRaw === 'object' ? pointRaw : {};
    const referencePoint = referencePoints?.[pointIndex];
    if (typeof point.label !== 'string' || point.label.trim() === '') {
      errors.push(`${label}.${fieldName}[${pointIndex}].label must be populated.`);
    }
    if (referencePoint && point.label !== referencePoint.label) {
      errors.push(`${label}.${fieldName}[${pointIndex}].label must match current curve maturity ${referencePoint.label}.`);
    }
    if (!isFiniteNumber(point.years) || Number(point.years) <= 0) {
      errors.push(`${label}.${fieldName}[${pointIndex}].years must be positive.`);
    }
    if (!isFiniteNumber(point.value)) {
      errors.push(`${label}.${fieldName}[${pointIndex}].value must be numeric.`);
    }
  }
}

function validateYieldCurveComparisons(errors, label, item, curvePoints) {
  const comparisonCurves = Array.isArray(item.comparisonCurves) ? item.comparisonCurves : [];
  if (!Array.isArray(item.comparisonCurves)) {
    errors.push(`${label}.comparisonCurves must include 1M ago and 6M ago Treasury curves.`);
  }
  // The renderer assumes these labels exist and that each comparison shares the current curve maturity order.
  const seenDates = new Map();
  const seenPointSets = new Map();
  for (const expected of REQUIRED_YIELD_CURVE_COMPARISONS) {
    const comparisonIndex = comparisonCurves.findIndex((comparison) => comparison?.label === expected.label);
    if (comparisonIndex < 0) {
      errors.push(`${label}.comparisonCurves must include ${expected.label}.`);
      continue;
    }
    const comparison = comparisonCurves[comparisonIndex];
    if (!isIsoDate(comparison.date)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be an ISO date.`);
    } else {
      if (seenDates.has(comparison.date)) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be distinct from ${seenDates.get(comparison.date)}.`);
      }
      seenDates.set(comparison.date, expected.label);
      const ageDays = isoDayGap(item.curveDate, comparison.date);
      if (ageDays === null || ageDays < expected.minDays || ageDays > expected.maxDays) {
        errors.push(`${label}.comparisonCurves[${comparisonIndex}].date must be ${expected.label} relative to curveDate.`);
      }
    }
    const points = Array.isArray(comparison.points) ? comparison.points : [];
    validateYieldCurvePointSet(errors, label, `comparisonCurves[${comparisonIndex}].points`, points, curvePoints);
    const pointKey = yieldCurvePointsKey(points);
    if (seenPointSets.has(pointKey)) {
      errors.push(`${label}.comparisonCurves[${comparisonIndex}].points must be distinct from ${seenPointSets.get(pointKey)}.`);
    }
    seenPointSets.set(pointKey, expected.label);
  }
}

module.exports = {
  REQUIRED_YIELD_CURVE_COMPARISONS,
  validateYieldCurvePointSet,
  validateYieldCurveComparisons
};
