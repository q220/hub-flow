import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FlowHistory } from './flow-history.js';
import type { JourneySummary } from './journey.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function historyIn(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-history-'));
  temps.push(dir);
  const file = path.join(dir, 'flow-history.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-19T08:00:00Z');

/** Written by the release before this one (FlowHistory at dbdffd4), for these four players */
const V1_FILE = '{"version":1,"players":{"0b7c2a58-1d2e-4f3a-9b8c-7d6e5f4a3b2c":{"firstJoined":1790668800000,"sessions":3,"firstSessionMs":412000,"reachedServer":true,"returned7d":true,"frozen":true},"5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716":{"firstJoined":1791619200000,"sessions":1,"reachedServer":false,"returned7d":false,"frozen":true},"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d":{"firstJoined":1792224000000,"sessions":1,"firstSessionMs":61000,"reachedServer":false},"1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9":{"firstJoined":1792137600000,"sessions":2}}}';
const V1_PLAYERS = JSON.parse(V1_FILE).players;

const summary = (outcome: JourneySummary['outcome'], extra: Partial<JourneySummary> = {}): JourneySummary => ({
  outcome, protocol: 776, version: '26.2', welcomeVisits: 1, compatibilityVisits: 0, lastExit: 'walked', reminders: 0, ...extra,
});

test('migrates a version 1 file in place, keeping the original beside it', () => {
  const file = historyIn(V1_FILE);
  const history = FlowHistory.load(file);
  assert.equal(history.size, 4);
  for (const [uuid, entry] of Object.entries(V1_PLAYERS)) assert.deepEqual(history.get(uuid), entry);
  // Nothing is written before a save, and nothing is set aside
  assert.equal(fs.readFileSync(file, 'utf-8'), V1_FILE);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flow-history.json']);

  // The first save writes version 2, even with nothing else changed
  assert.equal(history.save(), true);
  const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(written.version, 2);
  assert.deepEqual(written.players, V1_PLAYERS);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), 'flow-history.v1.json'), 'utf-8'), V1_FILE);
  assert.equal(history.save(), false);

  // And reads back
  const again = FlowHistory.load(file);
  assert.equal(again.size, 4);
  for (const [uuid, entry] of Object.entries(V1_PLAYERS)) assert.deepEqual(again.get(uuid), entry);
  assert.equal(again.save(), false);
});

test('a migrated history keeps working: new journeys next to the old fields', () => {
  const file = historyIn(V1_FILE);
  const history = FlowHistory.load(file);
  const uuid = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  history.recordJourney(uuid, 1792224000000, summary('finished'), NOW);
  history.save();
  const entry = FlowHistory.load(file).get(uuid);
  assert.deepEqual(entry, { ...V1_PLAYERS[uuid], journey: summary('finished') });
});

test('does not write over a history of a newer version', () => {
  const newer = '{"version":3,"players":{"0b7c2a58-1d2e-4f3a-9b8c-7d6e5f4a3b2c":{"firstJoined":1790668800000}}}';
  const file = historyIn(newer);
  const history = FlowHistory.load(file);
  assert.equal(history.size, 0);
  history.record('5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716', NOW - DAY, { sessions: 1 }, NOW);
  assert.equal(history.save(), false);
  assert.equal(fs.readFileSync(file, 'utf-8'), newer);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flow-history.json']);
});

test('sets an unreadable history aside and starts again', () => {
  const file = historyIn('{"version":1,"players":');
  const history = FlowHistory.load(file);
  assert.equal(history.size, 0);
  const names = fs.readdirSync(path.dirname(file));
  assert.equal(names.length, 1);
  assert.match(names[0], /^flow-history\.json\.unreadable-\d+$/);
});

test('starts empty without a file, and writes version 2', () => {
  const file = historyIn();
  const history = FlowHistory.load(file);
  assert.equal(history.save(), false);
  history.record('a', NOW - DAY, { sessions: 1 }, NOW);
  assert.equal(history.save(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { version: 2, players: { a: { firstJoined: NOW - DAY, sessions: 1 } } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flow-history.json']);
});

test('freezes the journey 8 days after the first join, apart from the log fields', () => {
  const history = FlowHistory.load(historyIn());
  const first = NOW - 3 * DAY;
  history.recordJourney('a', first, summary('welcome'), NOW);
  history.recordJourney('a', first, summary('finished'), NOW + DAY);
  assert.deepEqual(history.get('a'), { firstJoined: first, journey: summary('finished') });

  // Day 8: the journey freezes, the log fields do not (no proxy result yet)
  history.recordJourney('a', first, summary('finished', { reminders: 2 }), first + 8 * DAY);
  history.record('a', first, { sessions: 2 }, first + 8 * DAY);
  history.recordJourney('a', first, summary('compatibility'), first + 9 * DAY);
  assert.deepEqual(history.get('a'), { firstJoined: first, sessions: 2, journey: summary('finished', { reminders: 2 }), journeyFrozen: true });

  // The log fields freeze on their own, and keep the journey
  history.record('a', first, { sessions: 3, reachedServer: true }, first + 10 * DAY);
  history.record('a', first, { sessions: 4, reachedServer: true }, first + 11 * DAY);
  assert.deepEqual(history.get('a'), {
    firstJoined: first, sessions: 3, reachedServer: true, frozen: true, journey: summary('finished', { reminders: 2 }), journeyFrozen: true,
  });
});

test('a journey can still be recorded after the log fields froze', () => {
  const history = FlowHistory.load(historyIn());
  const first = NOW - 20 * DAY;
  history.record('a', first, { sessions: 1, reachedServer: false }, NOW);
  history.recordJourney('a', first, summary('welcome'), NOW);
  assert.deepEqual(history.get('a'), { firstJoined: first, sessions: 1, reachedServer: false, frozen: true, journey: summary('welcome'), journeyFrozen: true });
});

test('saves only when something changed', () => {
  const file = historyIn();
  const history = FlowHistory.load(file);
  history.recordJourney('a', NOW - DAY, summary('welcome'), NOW);
  assert.equal(history.save(), true);
  history.recordJourney('a', NOW - DAY, summary('welcome'), NOW + 1000);
  history.record('a', NOW - DAY, {}, NOW + 1000);
  assert.equal(history.save(), false);
});

test('the earliest first join with a journey', () => {
  const history = FlowHistory.load(historyIn(V1_FILE));
  assert.equal(history.earliest('journey'), null);
  history.recordJourney('b', NOW - 2 * DAY, summary('welcome'), NOW);
  history.recordJourney('c', NOW - 5 * DAY, summary('welcome'), NOW);
  assert.equal(history.earliest('journey'), NOW - 5 * DAY);
  assert.equal(history.earliest('sessions'), 1790668800000);
});

test('a migration never writes over an earlier copy of version 1', () => {
  // After a rollback the old release writes a fresh version 1 file; the copy from the first upgrade must survive
  const file = historyIn('{"version":1,"players":{}}');
  const dir = path.dirname(file);
  fs.writeFileSync(path.join(dir, 'flow-history.v1.json'), V1_FILE);
  const history = FlowHistory.load(file);
  assert.equal(history.save(), true);
  assert.equal(fs.readFileSync(path.join(dir, 'flow-history.v1.json'), 'utf-8'), V1_FILE);
  const copies = fs.readdirSync(dir).filter((n) => /^flow-history\.v1-\d+\.json$/.test(n));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf-8'), '{"version":1,"players":{}}');
});

test('a save that fails after the copy leaves the version 1 file as it was', () => {
  const file = historyIn(V1_FILE);
  const dir = path.dirname(file);
  const history = FlowHistory.load(file);
  history.record('a', NOW - DAY, { sessions: 1 }, NOW);
  fs.mkdirSync(`${file}.tmp`); // the write of the new file fails
  assert.throws(() => history.save());
  assert.equal(fs.readFileSync(file, 'utf-8'), V1_FILE);
  assert.equal(fs.readFileSync(path.join(dir, 'flow-history.v1.json'), 'utf-8'), V1_FILE);

  // The next save works, and keeps no second copy
  fs.rmdirSync(`${file}.tmp`);
  assert.equal(history.save(), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).version, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['flow-history.json', 'flow-history.v1.json']);
});

test('leaves a newer version alone whatever its shape', () => {
  for (const newer of [
    '{"version":3,"players":[["0b7c2a58-1d2e-4f3a-9b8c-7d6e5f4a3b2c",{"firstJoined":1790668800000}]]}',
    '{"version":3,"entries":{"0b7c2a58-1d2e-4f3a-9b8c-7d6e5f4a3b2c":{}}}',
  ]) {
    const file = historyIn(newer);
    const history = FlowHistory.load(file);
    assert.equal(history.size, 0);
    history.record('a', NOW - DAY, { sessions: 1 }, NOW);
    assert.equal(history.save(), false);
    assert.equal(fs.readFileSync(file, 'utf-8'), newer);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flow-history.json']);
  }
});
