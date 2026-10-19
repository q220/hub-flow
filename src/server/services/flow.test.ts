import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FlowPlayer, PackInfo, PlayerRecord } from '../../shared/protocol.js';
import { FlowModel, type FlowSources } from './flow.js';
import { FlowHistory } from './flow-history.js';
import { parseLine, type FlowLogEvent } from './flow-log.js';
import { assembleJourneys, loadFlowLog, summarizeJourney, type JourneySummary } from './journey.js';
import type { IntroData } from './intro-progress.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function historyFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-model-'));
  temps.push(dir);
  return path.join(dir, 'flow-history.json');
}

const t = (iso: string) => Date.parse(iso);
const NOW = t('2026-10-19T12:00:00Z');
const COVERAGE = t('2026-10-10T06:00:00Z');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = {
  quitCompat: uuid(1), finishNotListed: uuid(2), listedNoFinish: uuid(3), roomDiffers: uuid(4),
  noJourney: uuid(5), beforeCoverage: uuid(6), history: uuid(7), historyFinishedLater: uuid(8), oldCovered: uuid(9),
};

const WELCOME = { x: 5, y: 5, z: 5 };
const COMPAT = { x: 25, y: 5, z: 5 };
const ELSEWHERE = { x: 100, y: 64, z: 100 };

function player(id: string, firstJoined: string, at: { x: number; y: number; z: number }): PlayerRecord {
  return { uuid: id, name: `p${id.slice(-2)}`, ...at, dimension: 'minecraft:overworld', lastModified: NOW, firstJoined: t(firstJoined), lastOnline: NOW };
}

const vanilla1214 = { version: '1.21.4', protocol: 769, brand: 'vanilla', marker: false, supported: false };
const fabric262 = { version: '26.2', protocol: 776, brand: 'fabric', marker: true, supported: true };

function events(...lines: object[]): FlowLogEvent[] {
  return lines.map((l) => parseLine(JSON.stringify(l)) as FlowLogEvent);
}

const LOG = events(
  { time: '2026-10-10T06:00:00Z', event: 'start', plugin: '1.4.0', supportedVersions: ['26.2'] },
  { time: '2026-10-10T07:00:00Z', event: 'enter', uuid: P.oldCovered, room: 'welcome', ...fabric262 },
  { time: '2026-10-10T07:00:30Z', event: 'skip', uuid: P.oldCovered, room: 'compatibility', ...fabric262, compatible: true },
  { time: '2026-10-10T07:00:30.500Z', event: 'exit', uuid: P.oldCovered, room: 'welcome', how: 'walked', stayedMs: 30500 },
  { time: '2026-10-10T07:00:30.600Z', event: 'finish', uuid: P.oldCovered, first: true },
  // Joined before the flow log, back in the rooms after it started
  { time: '2026-10-12T07:00:00Z', event: 'enter', uuid: P.beforeCoverage, room: 'welcome', ...fabric262 },
  // Read the warning and quit
  { time: '2026-10-15T18:02:11Z', event: 'enter', uuid: P.quitCompat, room: 'welcome', ...vanilla1214 },
  { time: '2026-10-15T18:02:14Z', event: 'pack', uuid: P.quitCompat, room: 'welcome', result: 'loaded', waitMs: 3000 },
  { time: '2026-10-15T18:02:39Z', event: 'exit', uuid: P.quitCompat, room: 'welcome', how: 'walked', stayedMs: 28000 },
  { time: '2026-10-15T18:02:40Z', event: 'enter', uuid: P.quitCompat, room: 'compatibility', ...vanilla1214, warning: 'version' },
  { time: '2026-10-15T18:02:41Z', event: 'pack', uuid: P.quitCompat, room: 'compatibility', result: 'loaded', waitMs: 50 },
  { time: '2026-10-15T18:03:52Z', event: 'exit', uuid: P.quitCompat, room: 'compatibility', how: 'quit', stayedMs: 72000 },
  // Finished with a failed pack, but the list does not have them
  { time: '2026-10-16T10:00:00Z', event: 'enter', uuid: P.finishNotListed, room: 'welcome', ...fabric262 },
  { time: '2026-10-16T10:00:09Z', event: 'pack', uuid: P.finishNotListed, room: 'welcome', result: 'failed_download', waitMs: 9000 },
  { time: '2026-10-16T10:01:00Z', event: 'skip', uuid: P.finishNotListed, room: 'compatibility', ...fabric262, compatible: true },
  { time: '2026-10-16T10:01:00.500Z', event: 'exit', uuid: P.finishNotListed, room: 'welcome', how: 'walked', stayedMs: 60500 },
  { time: '2026-10-16T10:01:00.600Z', event: 'finish', uuid: P.finishNotListed, first: true },
  // On the list, but the log saw them quit in the welcome room
  { time: '2026-10-17T10:00:00Z', event: 'enter', uuid: P.listedNoFinish, room: 'welcome', ...fabric262 },
  { time: '2026-10-17T10:00:03Z', event: 'pack', uuid: P.listedNoFinish, room: 'welcome', result: 'loaded', waitMs: 3000 },
  { time: '2026-10-17T10:05:00Z', event: 'exit', uuid: P.listedNoFinish, room: 'welcome', how: 'quit', stayedMs: 300000 },
  // In the welcome room by the log, elsewhere by position
  { time: '2026-10-17T11:00:00Z', event: 'enter', uuid: P.roomDiffers, room: 'welcome', ...fabric262 },
);

const intro: IntroData = {
  finished: new Set([P.listedNoFinish, P.beforeCoverage, P.historyFinishedLater, P.oldCovered]),
  welcomeRoom: { minX: 0, maxX: 10, minY: 0, maxY: 10, minZ: 0, maxZ: 10 },
  compatibilityRoom: { minX: 20, maxX: 30, minY: 0, maxY: 10, minZ: 0, maxZ: 10 },
  dimensions: new Set(['minecraft:overworld']),
};

const packInfo = (result: PackInfo['result']): PackInfo => ({ pack: 'Human', version: 'v4.0.8', variant: 'Human-Vanilla', result });

const summary = (extra: Partial<JourneySummary>): JourneySummary => ({ outcome: 'welcome', welcomeVisits: 1, compatibilityVisits: 0, reminders: 0, ...extra });

function sources(over: Partial<FlowSources> = {}): FlowSources {
  const history = FlowHistory.load(historyFile());
  history.recordJourney(P.history, t('2026-09-01T10:00:00Z'), summary({ outcome: 'compatibility', pack: 'failed_reload', protocol: 769, version: '1.21.4', compatibilityVisits: 1 }), NOW);
  history.recordJourney(P.historyFinishedLater, t('2026-09-02T10:00:00Z'), summary({ outcome: 'welcome', protocol: 776 }), NOW);
  return {
    players: [
      player(P.quitCompat, '2026-10-15T18:02:10Z', COMPAT),
      player(P.finishNotListed, '2026-10-16T09:59:59Z', ELSEWHERE),
      player(P.listedNoFinish, '2026-10-17T09:59:59Z', ELSEWHERE),
      player(P.roomDiffers, '2026-10-17T10:59:59Z', ELSEWHERE),
      player(P.noJourney, '2026-10-18T10:00:00Z', WELCOME),
      player(P.beforeCoverage, '2026-10-05T06:59:59Z', ELSEWHERE),
      player(P.history, '2026-09-01T10:00:00Z', ELSEWHERE),
      player(P.historyFinishedLater, '2026-09-02T10:00:00Z', WELCOME),
      player(P.oldCovered, '2026-10-10T06:59:59Z', ELSEWHERE),
    ],
    intro,
    packs: new Map([
      [P.quitCompat, packInfo('loaded')],
      [P.finishNotListed, packInfo('loaded')],
      [P.noJourney, packInfo('declined')],
      [P.beforeCoverage, packInfo('loaded')],
    ]),
    sessions: null,
    activity: null,
    clients: new Map([[P.quitCompat, 776], [P.noJourney, 776]]),
    history,
    releases: null,
    serverVersion: '26.2',
    events: [],
    flowLog: { coverageStart: COVERAGE, badLines: 2, complete: true, journeys: assembleJourneys(LOG) },
    ...over,
  };
}

function byUuid(model: FlowModel): Map<string, FlowPlayer> {
  return new Map(model.playersPage(0, Infinity, undefined, 500, 0).players.map((p) => [p.uuid, p]));
}

test('covered players get their intro from their journey', () => {
  const players = byUuid(new FlowModel(sources(), NOW));

  const quit = players.get(P.quitCompat)!;
  assert.equal(quit.outcomeFrom, 'log');
  assert.equal(quit.outcome, 'compatibility');
  assert.equal(quit.introPack, 'loaded');
  assert.equal(quit.clientVersion, '1.21.4', 'the intro client, not Plan\'s latest 26.2');
  assert.deepEqual(quit.pack, packInfo('loaded'), 'Architect\'s latest pack stays as it is');
  assert.equal(quit.journey?.visits.length, 2);
  assert.deepEqual(quit.disagreements, ['client']);

  const finished = players.get(P.finishNotListed)!;
  assert.equal(finished.outcome, 'finished');
  assert.equal(finished.introPack, 'failed_download');
  assert.equal(finished.clientVersion, '26.2');
  assert.deepEqual(finished.disagreements, ['finish-not-listed', 'pack']);

  const listed = players.get(P.listedNoFinish)!;
  assert.equal(listed.outcome, 'welcome');
  assert.deepEqual(listed.disagreements, ['listed-not-finished']);

  const room = players.get(P.roomDiffers)!;
  assert.equal(room.outcome, 'welcome');
  assert.equal(room.introPack, undefined);
  assert.deepEqual(room.disagreements, ['room']);

  const agrees = players.get(P.oldCovered)!;
  assert.equal(agrees.outcome, 'finished');
  assert.equal(agrees.disagreements, undefined);
});

test('players before the coverage, or without a journey, are inferred as before', () => {
  const players = byUuid(new FlowModel(sources(), NOW));

  const before = players.get(P.beforeCoverage)!;
  assert.equal(before.outcomeFrom, 'inferred');
  assert.equal(before.outcome, 'finished');
  assert.equal(before.journey, undefined, 'events before the coverage start are not a whole journey');
  assert.equal(before.introPack, 'loaded');

  const none = players.get(P.noJourney)!;
  assert.equal(none.outcomeFrom, 'inferred');
  assert.equal(none.outcome, 'welcome');
  assert.equal(none.introPack, 'declined');
  assert.equal(none.clientVersion, '26.2');
});

test('players whose part of the log is gone get their intro from the history', () => {
  const players = byUuid(new FlowModel(sources(), NOW));

  const kept = players.get(P.history)!;
  assert.equal(kept.outcomeFrom, 'history');
  assert.equal(kept.outcome, 'compatibility');
  assert.equal(kept.introPack, 'failed_reload');
  assert.equal(kept.clientVersion, '1.21.4');
  assert.equal(kept.journey, undefined);

  // Finished later than the journey was frozen: the list knows
  assert.equal(players.get(P.historyFinishedLater)!.outcome, 'finished');
});

test('the counts take the intro from the journey, and the check counts disagreements', () => {
  const r = new FlowModel(sources(), NOW).query(t('2026-08-01T00:00:00Z'), NOW + 1);
  assert.deepEqual(
    { finished: r.totals.finished, welcome: r.totals.welcome, compatibility: r.totals.compatibility, other: r.totals.other },
    { finished: 4, welcome: 3, compatibility: 2, other: 0 },
  );
  assert.deepEqual(
    { known: r.totals.packKnown, loaded: r.totals.packLoaded, failed: r.totals.packFailed, declined: r.totals.packDeclined },
    { known: 6, loaded: 3, failed: 2, declined: 1 },
  );
  assert.equal(r.byPackResult.find((g) => g.result === 'failed_download')?.players, 1);
  // A release's players count with its own result: the intro's may have been another pack
  assert.deepEqual(r.byPack.map((g) => [g.players, g.packLoaded, g.packFailed, g.packDeclined]), [[4, 3, 0, 1]]);
  assert.equal(r.byClient.find((g) => g.version === '1.21.4')?.players, 2);
  assert.equal(r.sources.flowLog, true);
  assert.equal(r.sources.flowLogFrom, t('2026-09-01T10:00:00Z'), 'the history reaches further back than the log');
  assert.deepEqual(r.journeys, {
    coverageStart: COVERAGE, badLines: 2, complete: true,
    covered: 6, withJourney: 5, fromHistory: 2,
    disagreements: 3, finishNotListed: 1, listedNotFinished: 1, roomDiffers: 1,
    clientDiffers: 1, packDiffers: 1,
  });

  // A range holds only its own players
  const lastDays = new FlowModel(sources(), NOW).query(t('2026-10-17T00:00:00Z'), NOW + 1);
  assert.equal(lastDays.journeys?.covered, 3);
  assert.equal(lastDays.journeys?.disagreements, 2);
});

test('the outcome filter follows the journey', () => {
  const finished = new FlowModel(sources(), NOW).playersPage(0, Infinity, 'finished', 500, 0).players.map((p) => p.uuid).sort();
  assert.deepEqual(finished, [P.finishNotListed, P.beforeCoverage, P.historyFinishedLater, P.oldCovered].sort());
});

test('records journey summaries in the history, frozen 8 days after the first join', () => {
  const src = sources();
  const model = new FlowModel(src, NOW);
  model.recordHistory(src.history!);
  const quit = src.history!.get(P.quitCompat)!;
  assert.deepEqual(quit.journey, summarizeJourney(src.flowLog!.journeys.get(P.quitCompat)!));
  assert.equal(quit.journeyFrozen, undefined);
  assert.equal(src.history!.get(P.oldCovered)!.journeyFrozen, true);
  assert.equal(src.history!.get(P.noJourney), undefined);
  assert.equal(src.history!.get(P.beforeCoverage), undefined);
});

test('without the flow log everything is inferred as before', () => {
  const r = new FlowModel(sources({ flowLog: null, history: null }), NOW);
  const q = r.query(t('2026-08-01T00:00:00Z'), NOW + 1);
  assert.equal(q.sources.flowLog, false);
  assert.equal(q.sources.flowLogFrom, null);
  assert.equal(q.journeys, null);
  const players = byUuid(r);
  for (const p of players.values()) {
    assert.equal(p.outcomeFrom, 'inferred');
    assert.equal(p.journey, undefined);
    assert.equal(p.disagreements, undefined);
  }
  assert.equal(players.get(P.finishNotListed)!.outcome, 'other');
  assert.equal(players.get(P.quitCompat)!.clientVersion, '26.2');
  assert.deepEqual(
    { finished: q.totals.finished, welcome: q.totals.welcome, compatibility: q.totals.compatibility, other: q.totals.other },
    { finished: 4, welcome: 1, compatibility: 1, other: 3 },
  );
  assert.equal(q.totals.packKnown, 4);
});

test('a flow log without a start yet covers nobody', () => {
  const players = byUuid(new FlowModel(sources({ flowLog: { coverageStart: null, badLines: 0, complete: true, journeys: assembleJourneys(LOG) } }), NOW));
  assert.equal(players.get(P.quitCompat)!.outcomeFrom, 'inferred');
  assert.equal(players.get(P.history)!.outcomeFrom, 'history');
});

/** n new players in the last 14 days with a finish in the log, `unlisted` of them missing from the list, and 20 listed before */
function finishersModel(n: number, unlisted: number): FlowModel {
  const players: PlayerRecord[] = [];
  const lines: object[] = [];
  const finished = new Set<string>();
  for (let i = 0; i < n + 20; i++) {
    const id = uuid(1000 + i);
    const joined = new Date(i < n ? NOW - (1 + i % 12) * 24 * 60 * 60 * 1000 : NOW - (20 + i % 30) * 24 * 60 * 60 * 1000);
    players.push(player(id, joined.toISOString(), ELSEWHERE));
    lines.push({ time: new Date(joined.getTime() + 1000).toISOString(), event: 'enter', uuid: id, room: 'welcome', ...fabric262 });
    lines.push({ time: new Date(joined.getTime() + 2000).toISOString(), event: 'finish', uuid: id, first: true });
    if (i >= unlisted) finished.add(id);
  }
  lines.sort((a, b) => (a as { time: string }).time.localeCompare((b as { time: string }).time));
  return new FlowModel(sources({
    players, intro: { ...intro, finished }, packs: null, clients: null, history: null,
    flowLog: { coverageStart: t('2026-06-01T00:00:00Z'), badLines: 0, complete: true, journeys: assembleJourneys(events(...lines)) },
  }), NOW);
}

test('a signal when the log has finishers the finished list lacks', () => {
  const signal = (m: FlowModel) => m.signalsReport().signals.find((s) => s.id === 'finish-not-listed');
  const raised = signal(finishersModel(20, 5));
  assert.equal(raised?.level, 'warning');
  assert.match(raised!.title, /^5 new players finished the intro/);
  assert.equal(signal(finishersModel(20, 4)), undefined, 'fewer than 5');
  assert.equal(signal(finishersModel(200, 5)), undefined, 'under 3% of the finishers');
});

test('an incomplete read of the flow log records no journeys in the history', () => {
  const src = sources();
  src.flowLog!.complete = false;
  const model = new FlowModel(src, NOW);
  assert.equal(byUuid(model).get(P.quitCompat)!.outcomeFrom, 'log', 'the page still shows what was read');
  assert.equal(model.query(t('2026-08-01T00:00:00Z'), NOW + 1).journeys?.complete, false);
  model.recordHistory(src.history!);
  assert.equal(src.history!.get(P.quitCompat), undefined);
  assert.equal(src.history!.get(P.oldCovered), undefined);
});

test('a reader that throws leaves the refresh without a flow log', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    assert.equal(await loadFlowLog({ read: async () => { throw Object.assign(new Error('boom'), { code: 'EMFILE' }); } }), null);
    assert.equal(warn.mock.callCount(), 1);
  } finally {
    warn.mock.restore();
  }
  const log = await loadFlowLog({ read: async () => ({ events: LOG, coverageStart: COVERAGE, badLines: 1, days: 1, complete: true }) });
  assert.equal(log?.journeys.get(P.quitCompat)?.visits.length, 2);
  assert.equal(log?.badLines, 1);
});
