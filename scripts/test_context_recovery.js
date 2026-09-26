#!/usr/bin/env node
'use strict';

// Test-only recovery fixture recorder. Usage:
//   node scripts/test_context_recovery.js read ROOT RELATIVE_PATH
//   node scripts/test_context_recovery.js poll ROOT SESSION_ID
//   node scripts/test_context_recovery.js save ROOT JSON_PAYLOAD
//   node scripts/test_context_recovery.js verify ROOT
//   node scripts/test_context_recovery.js setup NEW_ROOT compaction|model-switch|interruption
//   node scripts/test_context_recovery.js selftest
// save replaces the entire fixture handoff with JSON_PAYLOAD; it does not merge a patch.
// Replay each fresh fixture through read/poll/save, then verify. Keep the checker-only
// expectation.json and initial-handoff.json out of the resumed agent's context.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HANDOFF = 'generated/editorial/dashboard-data.json';
const INVENTORY = 'generated/news_candidates.json';
const PRIVATE = new Set(['expectation.json', 'initial-handoff.json', 'audit.jsonl']);

function fixturePath(root, relative, forWrite = false) {
  assert.equal(typeof relative, 'string');
  assert(relative && !path.isAbsolute(relative), 'fixture path must be relative');
  const parts = relative.split('/');
  assert(parts.every((part) => part && part !== '.' && part !== '..'), 'fixture path traversal');
  const base = fs.realpathSync(root);
  const target = path.resolve(base, ...parts);
  assert(target.startsWith(`${base}${path.sep}`), 'fixture path escapes root');
  if (forWrite) {
    const parent = fs.realpathSync(path.dirname(target));
    assert(parent === base || parent.startsWith(`${base}${path.sep}`), 'fixture parent escapes root');
    if (fs.existsSync(target)) assert.equal(fs.realpathSync(target), target, 'fixture symlink');
  } else {
    assert(fs.realpathSync(target).startsWith(`${base}${path.sep}`), 'fixture symlink escapes root');
  }
  return target;
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(fixturePath(root, relative), 'utf8'));
}

function audit(root, event) {
  fs.appendFileSync(fixturePath(root, 'audit.jsonl', true), `${JSON.stringify(event)}\n`);
}

function recordRead(root, relative) {
  assert(!PRIVATE.has(relative), 'private checker file cannot be read');
  const contents = fs.readFileSync(fixturePath(root, relative), 'utf8');
  audit(root, { action: 'read', path: relative });
  process.stdout.write(contents);
}

function recordPoll(root, sessionId) {
  const state = readJson(root, 'command-state.json');
  assert.equal(sessionId, state.sessionId, 'wrong command session');
  assert(Object.hasOwn(state, 'terminalResult'), 'terminal result unavailable');
  audit(root, { action: 'poll', sessionId });
  process.stdout.write(`${JSON.stringify(state.terminalResult)}\n`);
}

function recordSave(root, jsonText) {
  const payload = JSON.parse(jsonText);
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'handoff must be an object');
  fs.writeFileSync(fixturePath(root, HANDOFF, true), `${JSON.stringify(payload, null, 2)}\n`);
  audit(root, { action: 'save', payload });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function setupFixture(root, scenario) {
  assert(['compaction', 'model-switch', 'interruption'].includes(scenario), 'unknown recovery scenario');
  assert(!fs.existsSync(root), 'fixture root already exists');
  fs.mkdirSync(root, { recursive: true });
  const put = (relative, value) => {
    const file = fixturePath(root, relative, true);
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const sourceRoot = path.resolve(__dirname, '..');
  for (const relative of ['AGENTS.md', 'README.md', 'docs/editorial.md']) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    put(relative, fs.readFileSync(path.join(sourceRoot, relative), 'utf8'));
  }
  const preparedAt = '2026-07-10T21:03:00.000Z';
  const inventory = { generatedAt: preparedAt, generalCandidates: [
    { url: 'https://example.test/funding', title: 'National funding report', source: 'Wire',
      article: { excerpt: 'The national funding report repeats previously reviewed figures.' } },
    { url: 'https://example.test/zoning', title: 'Single-town zoning permit report', source: 'Local Ledger',
      article: { excerpt: 'A single town issued a zoning permit; the report gives no national market implication.' } },
    { url: 'https://example.test/employment', title: 'National employment report', source: 'Wire',
      article: { excerpt: 'National employment figures remain pending deep review.' } }
  ], futuresCandidates: [], cryptoCandidates: [] };
  fs.mkdirSync(path.join(root, 'generated/editorial'), { recursive: true });
  put(INVENTORY, inventory);
  const handoff = {
    opening: { text: 'Preserve saved Opening copy.' },
    tape: { text: 'Preserve saved Tape copy.' },
    editorialReview: {
      preparedAt,
      newsSelection: { stories: [], futures: [], crypto: [] },
      reviewEvidence: {
        inventoryGeneratedAt: preparedAt,
        metadataScanComplete: true,
        deepReviews: [{ ref: 'generalCandidates[0]', decision: 'not_selected',
          evidence: 'The national funding report repeats figures already covered and adds no new catalyst.' }]
      }
    }
  };
  if (scenario === 'compaction') {
    handoff.editorialReview.resumeNotes = `2026-07-10 afternoon scheduled; preparedAt ${preparedAt}; next generalCandidates[0] (lagging note)`;
  } else if (scenario === 'interruption') {
    handoff.editorialReview.resumeNotes = `2026-07-10 afternoon scheduled; preparedAt ${preparedAt}; next generalCandidates[1]; active session recovery-42`;
  }
  put('initial-handoff.json', handoff);
  put(HANDOFF, handoff);
  put('saved-command-results.json', {
    runDate: '2026-07-10', edition: 'afternoon', mode: 'scheduled', preparedAt,
    prepare: scenario === 'interruption' ? { state: 'preparing', sessionId: 'recovery-42' }
      : { exitCode: 0, stdout: 'Preparation status: candidate ready\nEditorial workspace prepared fixture' },
    metadata: 'All three General candidates inspected; Futures and Crypto empty.',
    savedEvidence: 'generalCandidates[0] reviewed and saved',
    nextAction: 'Deep-review generalCandidates[1], then continue to generalCandidates[2].'
  });
  put('working-tree.txt', 'Dirty generated/editorial/dashboard-data.json contains saved user work. Preserve it and the News inventory.\n');
  put('command-state.json', { sessionId: 'recovery-42', terminalResult: {
    exitCode: 0, stdout: 'Preparation status: candidate ready\nEditorial workspace prepared fixture', stderr: ''
  } });
  put('audit.jsonl', '');
  const protectedHashes = {};
  for (const relative of ['AGENTS.md', 'README.md', 'docs/editorial.md', INVENTORY,
    'saved-command-results.json', 'working-tree.txt', 'command-state.json']) {
    protectedHashes[relative] = sha256(fixturePath(root, relative));
  }
  put('expectation.json', {
    nextRef: 'generalCandidates[1]', evidenceToken: 'zoning', nextRefAfter: 'generalCandidates[2]',
    runDate: '2026-07-10', requiredSession: scenario === 'interruption' ? 'recovery-42' : null,
    protectedHashes
  });
  return { root, scenario, preparedAt };
}

function verifyFixture(root) {
  const expected = readJson(root, 'expectation.json');
  const initial = readJson(root, 'initial-handoff.json');
  const final = readJson(root, HANDOFF);
  const inventory = readJson(root, INVENTORY);
  const events = fs.readFileSync(fixturePath(root, 'audit.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert(events.length, 'missing audit events');
  assert(events.every((event) => ['read', 'poll', 'save'].includes(event.action)), 'invalid audit action');
  const saves = events.flatMap((event, index) => event.action === 'save' ? [index] : []);
  assert.equal(saves.length, 1, 'exactly one save required');
  const saveIndex = saves[0];
  assert.deepEqual(events[saveIndex].payload, final, 'recorded payload differs from saved handoff');

  const ordered = ['AGENTS.md', 'README.md', 'docs/editorial.md'];
  for (const [index, relative] of ordered.entries()) {
    assert.equal(events[index]?.action, 'read', `${relative} must be read in recovery order before other actions`);
    assert.equal(events[index]?.path, relative, `${relative} must be read in recovery order before other actions`);
    assert(index < saveIndex, `${relative} must be read before save`);
  }
  const handoffIndex = events.findIndex((event) => event.action === 'read' && event.path === HANDOFF);
  assert(handoffIndex >= ordered.length && handoffIndex < saveIndex, 'handoff must be read before save');
  assert(!events.slice(0, handoffIndex).some((event) => event.action === 'poll'
    || (event.action === 'read' && [INVENTORY, 'saved-command-results.json', 'command-state.json'].includes(event.path))),
  'handoff must be read before inventory and command reconciliation');
  for (const relative of [INVENTORY, 'saved-command-results.json', 'working-tree.txt']) {
    assert(events.some((event, index) => index < saveIndex && event.action === 'read' && event.path === relative),
      `${relative} must be read before save`);
  }
  if (expected.requiredSession) {
    const state = readJson(root, 'command-state.json');
    assert.equal(state.sessionId, expected.requiredSession, 'wrong required session in command state');
    assert.equal(state.terminalResult?.exitCode, 0, 'required Prepare terminal result must succeed');
    assert(state.terminalResult.stdout.includes('Preparation status: candidate ready')
      && state.terminalResult.stdout.includes('Editorial workspace prepared '), 'required Prepare markers missing');
    assert(events.some((event, index) => index < saveIndex && event.action === 'poll'
      && event.sessionId === expected.requiredSession), 'required session must be polled before save');
  }
  for (const event of events) {
    if (event.action === 'read') {
      assert.equal(typeof event.path, 'string', 'read path missing');
      assert(!PRIVATE.has(event.path), 'private checker file read');
    }
    if (event.action === 'poll') assert.equal(typeof event.sessionId, 'string', 'poll session missing');
  }
  for (const [relative, digest] of Object.entries(expected.protectedHashes)) {
    assert(!PRIVATE.has(relative) && relative !== HANDOFF, 'invalid protected file');
    assert.equal(sha256(fixturePath(root, relative)), digest, `${relative} changed`);
  }

  const preparedAt = initial.editorialReview.preparedAt;
  assert.equal(inventory.generatedAt, preparedAt, 'inventory identity differs from handoff');
  assert.equal(initial.editorialReview.reviewEvidence.inventoryGeneratedAt, preparedAt,
    'initial evidence identity differs from handoff');
  assert.equal(final.editorialReview.preparedAt, preparedAt, 'preparedAt changed');
  assert.equal(final.editorialReview.reviewEvidence.inventoryGeneratedAt, preparedAt,
    'final evidence identity differs from handoff');

  const beforeReviews = initial.editorialReview.reviewEvidence.deepReviews;
  const afterReviews = final.editorialReview.reviewEvidence.deepReviews;
  assert(Array.isArray(beforeReviews) && Array.isArray(afterReviews), 'deepReviews must be arrays');
  assert.equal(afterReviews.length, beforeReviews.length + 1, 'append exactly one deep review');
  assert.deepEqual(afterReviews.slice(0, -1), beforeReviews, 'previous deep reviews changed');
  const added = afterReviews.at(-1);
  assert.equal(added.ref, expected.nextRef, 'wrong next candidate reference');
  assert.equal(added.decision, 'not_selected', 'wrong review decision');
  assert.equal(typeof added.evidence, 'string', 'review evidence missing');
  assert(added.evidence.trim().length >= 30, 'review evidence too short');
  assert(added.evidence.toLowerCase().includes(expected.evidenceToken.toLowerCase()),
    'review evidence does not identify the candidate');
  assert.equal(new Set(afterReviews.map((review) => review.ref)).size, afterReviews.length,
    'duplicate review reference');

  const notes = final.editorialReview.resumeNotes;
  assert.equal(typeof notes, 'string', 'resume notes missing');
  for (const token of [expected.runDate, 'afternoon', 'scheduled', preparedAt, expected.nextRefAfter]) {
    assert(notes.toLowerCase().includes(String(token).toLowerCase()), `resume notes omit ${token}`);
  }
  const normalized = structuredClone(final);
  if (Object.hasOwn(initial.editorialReview, 'resumeNotes')) {
    normalized.editorialReview.resumeNotes = initial.editorialReview.resumeNotes;
  } else {
    delete normalized.editorialReview.resumeNotes;
  }
  normalized.editorialReview.reviewEvidence.deepReviews = beforeReviews;
  assert.deepEqual(normalized, initial, 'handoff fields other than notes and appended review changed');
  return { checkedEvents: events.length, nextRef: expected.nextRef };
}

function runSelfTests() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'context-recovery-'));
  const root = path.join(parent, 'fixture');
  try {
    setupFixture(root, 'interruption');
    const put = (relative, value) => fs.writeFileSync(path.join(root, relative),
      typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
    const initial = readJson(root, 'initial-handoff.json');
    const preparedAt = initial.editorialReview.preparedAt;
    const final = structuredClone(initial);
    final.editorialReview.resumeNotes = `2026-07-10 afternoon scheduled preparedAt ${preparedAt}; next generalCandidates[2]`;
    final.editorialReview.reviewEvidence.deepReviews.push({ ref: 'generalCandidates[1]',
      decision: 'not_selected', evidence: 'The single-town zoning permit has no national market implication.' });
    put(HANDOFF, final);
    const validEvents = ['AGENTS.md', 'README.md', 'docs/editorial.md', HANDOFF, INVENTORY,
      'saved-command-results.json', 'working-tree.txt'].map((relative) => ({ action: 'read', path: relative }));
    validEvents.push({ action: 'poll', sessionId: 'recovery-42' }, { action: 'save', payload: final });
    const trace = (events) => put('audit.jsonl', `${events.map(JSON.stringify).join('\n')}\n`);
    trace(validEvents);
    verifyFixture(root);
    const rejects = (events, message) => {
      trace(events);
      assert.throws(() => verifyFixture(root), message);
    };
    for (const relative of ['AGENTS.md', 'README.md', 'docs/editorial.md', HANDOFF, INVENTORY,
      'saved-command-results.json', 'working-tree.txt']) {
      rejects(validEvents.filter((event) => !(event.action === 'read' && event.path === relative)),
        /must be read/);
    }
    rejects([validEvents[1], validEvents[0], ...validEvents.slice(2)], /AGENTS|README/);
    rejects([validEvents[0], validEvents[2], validEvents[1], ...validEvents.slice(3)], /README|editorial/);
    rejects([validEvents[4], ...validEvents.slice(0, 4), ...validEvents.slice(5)], /AGENTS/);
    rejects([validEvents[7], ...validEvents.slice(0, 7), validEvents[8]], /AGENTS/);
    rejects([...validEvents.slice(0, 3), validEvents[4], validEvents[3], ...validEvents.slice(5)], /before inventory/);
    rejects([...validEvents.slice(0, 3), validEvents[7], ...validEvents.slice(3, 7), validEvents[8]], /before inventory/);
    rejects(validEvents.filter((event) => event.action !== 'poll'), /polled/);
    rejects([...validEvents, validEvents.at(-1)], /one save/);
    rejects([...validEvents.slice(0, -1), { action: 'edit' }, validEvents.at(-1)], /invalid audit/);
    trace(validEvents);
    const badFinal = (edit, message) => {
      const copy = structuredClone(final);
      edit(copy);
      put(HANDOFF, copy);
      trace([...validEvents.slice(0, -1), { action: 'save', payload: copy }]);
      assert.throws(() => verifyFixture(root), message);
    };
    badFinal((copy) => { copy.editorialReview.newsSelection.stories = ['changed']; }, /handoff fields/);
    badFinal((copy) => { copy.opening.text = 'Overwritten saved copy'; }, /handoff fields/);
    badFinal((copy) => { copy.editorialReview.reviewEvidence.deepReviews[0].evidence = 'changed'; }, /previous deep reviews/);
    badFinal((copy) => { copy.editorialReview.reviewEvidence.deepReviews[1].ref = 'generalCandidates[0]'; }, /wrong next candidate|duplicate/);
    badFinal((copy) => { copy.editorialReview.reviewEvidence.deepReviews[1].ref = 'generalCandidates[2]'; }, /wrong next candidate/);
    badFinal((copy) => { copy.editorialReview.reviewEvidence.inventoryGeneratedAt = 'stale'; }, /final evidence identity/);
    put(HANDOFF, final);
    trace(validEvents);
    const originalInventory = fs.readFileSync(path.join(root, INVENTORY));
    put(INVENTORY, { ...readJson(root, INVENTORY), generatedAt: 'stale' });
    assert.throws(() => verifyFixture(root), /changed|inventory identity/);
    fs.writeFileSync(path.join(root, INVENTORY), originalInventory);
    const originalCommand = fs.readFileSync(path.join(root, 'saved-command-results.json'));
    put('saved-command-results.json', '{}');
    assert.throws(() => verifyFixture(root), /changed/);
    fs.writeFileSync(path.join(root, 'saved-command-results.json'), originalCommand);
    const originalState = fs.readFileSync(path.join(root, 'command-state.json'));
    put('command-state.json', { sessionId: 'recovery-42', terminalResult: { exitCode: 1,
      markers: ['news inventory written'] } });
    assert.throws(() => verifyFixture(root), /changed|terminal result/);
    put('command-state.json', { sessionId: 'recovery-42', terminalResult: { exitCode: 0,
      stdout: 'Preparation status: candidate ready' } });
    assert.throws(() => verifyFixture(root), /markers missing/);
    fs.writeFileSync(path.join(root, 'command-state.json'), originalState);
    verifyFixture(root);
    for (const scenario of ['compaction', 'model-switch']) {
      const caseRoot = path.join(parent, scenario);
      setupFixture(caseRoot, scenario);
      const caseInitial = readJson(caseRoot, 'initial-handoff.json');
      const caseFinal = structuredClone(caseInitial);
      caseFinal.editorialReview.resumeNotes =
        `2026-07-10 afternoon scheduled preparedAt ${preparedAt}; next generalCandidates[2]`;
      caseFinal.editorialReview.reviewEvidence.deepReviews.push({ ref: 'generalCandidates[1]',
        decision: 'not_selected', evidence: 'The local zoning permit lacks any national market implication.' });
      fs.writeFileSync(path.join(caseRoot, HANDOFF), `${JSON.stringify(caseFinal)}\n`);
      fs.writeFileSync(path.join(caseRoot, 'audit.jsonl'), `${[
        ...validEvents.filter((event) => event.action === 'read'),
        { action: 'save', payload: caseFinal }
      ].map(JSON.stringify).join('\n')}\n`);
      verifyFixture(caseRoot);
    }
    process.stdout.write('context recovery selftest passed\n');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const [command, root, argument] = process.argv.slice(2);
    if (command === 'read') recordRead(root, argument);
    else if (command === 'poll') recordPoll(root, argument);
    else if (command === 'save') recordSave(root, argument);
    else if (command === 'verify') process.stdout.write(`${JSON.stringify(verifyFixture(root))}\n`);
    else if (command === 'setup') process.stdout.write(`${JSON.stringify(setupFixture(root, argument))}\n`);
    else if (command === 'selftest') runSelfTests();
    else throw new Error('usage: read|poll|save|verify|setup ROOT [ARG], or selftest');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { verifyFixture, runSelfTests };
