import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FlowLogReader, parseLine, type FlowLogEvent } from './flow-log.js';
import { assembleJourneys, clientName, journeyClient, journeyOutcome, journeyPack, summarizeJourney } from './journey.js';
import type { PlayerJourney } from '../../shared/protocol.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const A = '4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b';
const B = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const t = (iso: string) => Date.parse(iso);

/** Events from log lines, as the reader gives them */
function events(...lines: object[]): FlowLogEvent[] {
  return lines.map((l) => {
    const e = parseLine(JSON.stringify(l));
    assert.equal(typeof e, 'object', JSON.stringify(l));
    return e as FlowLogEvent;
  });
}

const start = (time: string) => ({ time, event: 'start', plugin: '1.4.0', supportedVersions: ['26.2'] });
const stop = (time: string) => ({ time, event: 'stop' });
const vanilla1214 = { version: '1.21.4', protocol: 769, brand: 'vanilla', marker: false, supported: false };
const fabric262 = { version: '26.2', protocol: 776, brand: 'fabric', marker: true, supported: true };

/** The example in MCME-Introduction's docs/flow-log.md: a 1.21.4 client reads the warning and quits */
const EXAMPLE = [
  { time: '2026-10-18T18:02:11.204Z', event: 'enter', uuid: A, room: 'welcome', ...vanilla1214 },
  { time: '2026-10-18T18:02:14.731Z', event: 'pack', uuid: A, room: 'welcome', result: 'loaded', waitMs: 3527 },
  { time: '2026-10-18T18:02:39.950Z', event: 'exit', uuid: A, room: 'welcome', how: 'walked', stayedMs: 28746 },
  { time: '2026-10-18T18:02:39.951Z', event: 'enter', uuid: A, room: 'compatibility', ...vanilla1214, warning: 'version' },
  { time: '2026-10-18T18:02:40.003Z', event: 'pack', uuid: A, room: 'compatibility', result: 'loaded', waitMs: 52 },
  { time: '2026-10-18T18:03:52.018Z', event: 'exit', uuid: A, room: 'compatibility', how: 'quit', stayedMs: 72067 },
];

test('folds the contract example into one journey', () => {
  const journeys = assembleJourneys(events(...EXAMPLE));
  assert.deepEqual([...journeys.keys()], [A]);
  const j = journeys.get(A)!;
  const client = { version: '1.21.4', protocol: 769, brand: 'vanilla', marker: false, supported: false };
  assert.deepEqual(j, {
    visits: [
      {
        room: 'welcome', at: t('2026-10-18T18:02:11.204Z'), client,
        packs: [{ result: 'loaded', waitMs: 3527 }],
        exit: { how: 'walked', at: t('2026-10-18T18:02:39.950Z'), stayedMs: 28746 },
      },
      {
        room: 'compatibility', at: t('2026-10-18T18:02:39.951Z'), client, warning: 'version',
        packs: [{ result: 'loaded', waitMs: 52 }],
        exit: { how: 'quit', at: t('2026-10-18T18:03:52.018Z'), stayedMs: 72067 },
      },
    ],
    skips: [],
    reminders: 0,
    confirms: [],
  } satisfies PlayerJourney);
  assert.equal(journeyOutcome(j), 'compatibility');
  assert.deepEqual(journeyPack(j), { result: 'loaded', waitMs: 52 });
  assert.equal(clientName(journeyClient(j)!), '1.21.4');
});

test('keeps a visit that crosses UTC midnight whole', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-'));
  temps.push(root);
  const dir = path.join(root, 'flow');
  fs.mkdirSync(dir);
  const write = (day: string, ...lines: object[]) => fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.map((l) => JSON.stringify(l) + '\n').join(''));
  write('2026-10-17', start('2026-10-17T06:00:00Z'), { time: '2026-10-17T23:59:50Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 });
  write('2026-10-18',
    { time: '2026-10-18T00:00:05Z', event: 'pack', uuid: A, room: 'welcome', result: 'loaded', waitMs: 15000 },
    { time: '2026-10-18T00:00:30Z', event: 'exit', uuid: A, room: 'welcome', how: 'quit', stayedMs: 40000 });
  // 2026-10-17 is a closed day (cached), 2026-10-18 an open one (read by offset)
  const data = await new FlowLogReader(dir, path.join(root, 'cache')).read(t('2026-10-19T12:00:00Z'));
  const j = assembleJourneys(data!.events).get(A)!;
  assert.equal(j.visits.length, 1);
  assert.deepEqual(j.visits[0].packs, [{ result: 'loaded', waitMs: 15000 }]);
  assert.deepEqual(j.visits[0].exit, { how: 'quit', at: t('2026-10-18T00:00:30Z'), stayedMs: 40000 });
  assert.equal(journeyOutcome(j), 'welcome');
});

test('two starts without a stop close the visits still open as unknown', () => {
  const j = assembleJourneys(events(
    start('2026-10-18T06:00:00Z'),
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T07:00:01Z', event: 'enter', uuid: B, room: 'compatibility', ...vanilla1214, warning: 'version' },
    { time: '2026-10-18T07:00:02Z', event: 'exit', uuid: B, room: 'compatibility', how: 'quit', stayedMs: 1000 },
    // The server died here
    start('2026-10-18T07:30:00Z'),
    { time: '2026-10-18T07:31:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T07:31:05Z', event: 'pack', uuid: A, room: 'welcome', result: 'loaded', waitMs: 5000 },
  ));
  const a = j.get(A)!;
  assert.deepEqual(a.visits.map((v) => v.exit), [{ how: 'unknown' }, undefined]);
  // The pack after the restart belongs to the new visit only
  assert.deepEqual(a.visits.map((v) => v.packs.length), [0, 1]);
  assert.deepEqual(j.get(B)!.visits.map((v) => v.exit?.how), ['quit']);
});

test('a clean stop keeps the exits it logged', () => {
  const j = assembleJourneys(events(
    start('2026-10-18T06:00:00Z'),
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T08:00:00Z', event: 'exit', uuid: A, room: 'welcome', how: 'stopped', stayedMs: 3600000 },
    stop('2026-10-18T08:00:00.001Z'),
    start('2026-10-18T08:01:00Z'),
  ));
  assert.deepEqual(j.get(A)!.visits.map((v) => v.exit?.how), ['stopped']);
});

test('keeps an exit without a stayedMs', () => {
  const j = assembleJourneys(events(
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T07:05:00Z', event: 'exit', uuid: A, room: 'welcome', how: 'left' },
  )).get(A)!;
  assert.deepEqual(j.visits[0].exit, { how: 'left', at: t('2026-10-18T07:05:00Z') });
  assert.equal(journeyOutcome(j), 'other');
});

test('an exit with no visit open records where the player was', () => {
  const j = assembleJourneys(events(
    { time: '2026-10-18T07:05:00Z', event: 'exit', uuid: A, room: 'compatibility', how: 'quit', stayedMs: 60000 },
  )).get(A)!;
  assert.deepEqual(j.visits, [{ room: 'compatibility', at: t('2026-10-18T07:04:00Z'), client: {}, packs: [], exit: { how: 'quit', at: t('2026-10-18T07:05:00Z'), stayedMs: 60000 } }]);
  assert.equal(journeyOutcome(j), 'compatibility');
});

test('collects skips, the first finish, reminders and confirms', () => {
  const j = assembleJourneys(events(
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...vanilla1214 },
    { time: '2026-10-18T07:00:03Z', event: 'pack', uuid: A, room: 'welcome', result: 'loaded', waitMs: 3000 },
    { time: '2026-10-18T07:00:30Z', event: 'exit', uuid: A, room: 'welcome', how: 'walked', stayedMs: 30000 },
    { time: '2026-10-18T07:00:30.001Z', event: 'enter', uuid: A, room: 'compatibility', ...vanilla1214, warning: 'version' },
    { time: '2026-10-18T07:01:00Z', event: 'confirm', uuid: A, choice: 'ignore', inRoom: true },
    { time: '2026-10-18T07:01:00.500Z', event: 'exit', uuid: A, room: 'compatibility', how: 'confirmed', stayedMs: 30499 },
    { time: '2026-10-18T07:01:00.600Z', event: 'finish', uuid: A, first: true },
    { time: '2026-10-18T07:06:00Z', event: 'reminder', uuid: A, warning: 'version' },
    { time: '2026-10-18T07:11:00Z', event: 'reminder', uuid: A, warning: 'version' },
    // Back the next day with a fixed client: passed over both rooms, through again
    { time: '2026-10-19T09:00:00Z', event: 'skip', uuid: A, room: 'welcome', ...fabric262, compatible: true },
    { time: '2026-10-19T09:00:00Z', event: 'skip', uuid: A, room: 'compatibility', ...fabric262, compatible: true },
    { time: '2026-10-19T09:00:00.100Z', event: 'finish', uuid: A, first: false },
  )).get(A)!;
  assert.deepEqual(j.finish, { at: t('2026-10-18T07:01:00.600Z'), first: true });
  assert.equal(j.reminders, 2);
  assert.deepEqual(j.confirms, [{ at: t('2026-10-18T07:01:00Z'), choice: 'ignore', inRoom: true }]);
  assert.deepEqual(j.skips.map((s) => [s.room, s.compatible, s.client.protocol]), [['welcome', true, 776], ['compatibility', true, 776]]);
  assert.equal(journeyOutcome(j), 'finished');
  // The client of the last room entered or passed over
  assert.equal(clientName(journeyClient(j)!), '26.2');
});

test("the intro's pack result: the last final one, else the last", () => {
  const pack = (...results: (string | [string, string])[]) => {
    const lines: object[] = [];
    let s = 0;
    for (const r of results) {
      const [room, result] = Array.isArray(r) ? r : ['welcome', r];
      lines.push({ time: new Date(t('2026-10-18T07:00:00Z') + s++ * 1000).toISOString(), event: 'pack', uuid: A, room, result, waitMs: s });
    }
    return journeyPack(assembleJourneys(events(
      { time: '2026-10-18T06:59:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
      ...lines,
    )).get(A)!)?.result;
  };
  assert.equal(pack('not_sent', 'loaded'), 'loaded');
  assert.equal(pack('failed_download', 'not_sent'), 'failed_download');
  assert.equal(pack('not_sent'), 'not_sent');
  assert.equal(pack('declined'), 'declined');
  assert.equal(pack('failed_reload'), 'failed_reload');
  assert.equal(pack('invalid_url'), 'failed_download');
  assert.equal(pack('timeout'), 'no_result');
  assert.equal(pack('loaded', 'exploded'), 'loaded');
  assert.equal(pack('exploded'), undefined);
  // A pack event for a room the player is not in belongs to no visit
  assert.equal(pack(['compatibility', 'failed_download']), undefined);
  assert.equal(pack(), undefined);

  // Over visits: failed on the first try, loaded when they came back
  const j = assembleJourneys(events(
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T07:00:09Z', event: 'pack', uuid: A, room: 'welcome', result: 'failed_download', waitMs: 9000 },
    { time: '2026-10-18T07:01:00Z', event: 'exit', uuid: A, room: 'welcome', how: 'quit', stayedMs: 60000 },
    { time: '2026-10-18T08:00:00Z', event: 'enter', uuid: A, room: 'welcome', ...fabric262 },
    { time: '2026-10-18T08:00:04Z', event: 'pack', uuid: A, room: 'welcome', result: 'loaded', waitMs: 4000 },
  )).get(A)!;
  assert.deepEqual(journeyPack(j), { result: 'loaded', waitMs: 4000 });
});

test('the outcome: finished, the room of the last visit, or other', () => {
  const outcome = (...lines: object[]) => journeyOutcome(assembleJourneys(events(...lines)).get(A)!);
  // Still in the room
  assert.equal(outcome({ time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'welcome' }), 'welcome');
  // Only reminders: never put in a room
  assert.equal(outcome({ time: '2026-10-18T07:00:00Z', event: 'reminder', uuid: A, warning: 'modded' }), 'other');
  // A room hub-flow does not know
  assert.equal(outcome({ time: '2026-10-18T07:00:00Z', event: 'enter', uuid: A, room: 'lobby' }), 'other');
  // Passed over both rooms, but no finish logged
  assert.equal(outcome({ time: '2026-10-18T07:00:00Z', event: 'skip', uuid: A, room: 'welcome', compatible: true }), 'other');
});

test('client names follow the protocol, as for Plan, else the version the log gives', () => {
  assert.equal(clientName({ version: '26.1-26.1.2', protocol: 775 }), '26.1–26.1.2');
  assert.equal(clientName({ version: '26.2' }), '26.2');
  assert.equal(clientName({ version: 'UNKNOWN', protocol: -1 }), undefined);
  assert.equal(clientName({}), undefined);
});

test('summarizes a journey for the history', () => {
  const quit = assembleJourneys(events(...EXAMPLE, { time: '2026-10-18T18:10:00Z', event: 'reminder', uuid: A, warning: 'version' })).get(A)!;
  assert.deepEqual(summarizeJourney(quit), {
    outcome: 'compatibility', pack: 'loaded', packWaitMs: 52,
    protocol: 769, version: '1.21.4', brand: 'vanilla', marker: false, supported: false, warning: 'version',
    welcomeVisits: 1, compatibilityVisits: 1, lastExit: 'quit', reminders: 1,
  });

  const through = assembleJourneys(events(
    { time: '2026-10-18T07:00:00Z', event: 'enter', uuid: B, room: 'welcome', ...fabric262, brand: null },
    { time: '2026-10-18T07:00:30Z', event: 'skip', uuid: B, room: 'compatibility', ...fabric262, brand: null, compatible: true },
    { time: '2026-10-18T07:00:30.500Z', event: 'exit', uuid: B, room: 'welcome', how: 'walked', stayedMs: 30500 },
    { time: '2026-10-18T07:00:30.600Z', event: 'finish', uuid: B, first: true },
    { time: '2026-10-18T07:00:40Z', event: 'confirm', uuid: B, choice: 'reset', inRoom: false },
  )).get(B)!;
  assert.deepEqual(summarizeJourney(through), {
    outcome: 'finished',
    protocol: 776, version: '26.2', brand: null, marker: true, supported: true,
    welcomeVisits: 1, compatibilityVisits: 0, lastExit: 'walked', finishedAt: t('2026-10-18T07:00:30.600Z'), reminders: 0, confirms: ['reset'],
  });
});
