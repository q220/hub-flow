import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FlowLogReader, flowLogDir } from './flow-log.js';

const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-log-'));
  temps.push(dir);
  return dir;
}

/** A flow folder and a cache folder of their own */
function setup() {
  const root = tempDir();
  const dir = path.join(root, 'flow');
  fs.mkdirSync(dir);
  return { dir, cacheDir: path.join(root, 'cache'), reader: new FlowLogReader(dir, path.join(root, 'cache')) };
}

const UUID = '4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b';
const OTHER = '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
/** 2026-10-19 12:00 UTC: 2026-10-19 is today, 2026-10-18 yesterday, older days are closed */
const NOW = Date.parse('2026-10-19T12:00:00Z');

/** The example in MCME-Introduction's docs/flow-log.md */
const EXAMPLE = [
  '{"time":"2026-10-18T18:02:11.204Z","event":"enter","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"welcome","version":"1.21.4","protocol":769,"brand":"vanilla","marker":false,"supported":false}',
  '{"time":"2026-10-18T18:02:14.731Z","event":"pack","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"welcome","result":"loaded","waitMs":3527}',
  '{"time":"2026-10-18T18:02:39.950Z","event":"exit","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"welcome","how":"walked","stayedMs":28746}',
  '{"time":"2026-10-18T18:02:39.951Z","event":"enter","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"compatibility","version":"1.21.4","protocol":769,"brand":"vanilla","marker":false,"supported":false,"warning":"version"}',
  '{"time":"2026-10-18T18:02:40.003Z","event":"pack","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"compatibility","result":"loaded","waitMs":52}',
  '{"time":"2026-10-18T18:03:52.018Z","event":"exit","uuid":"4b6f1c2e-9a3d-4e5f-8a7b-6c5d4e3f2a1b","room":"compatibility","how":"quit","stayedMs":72067}',
];

const START = (time: string) => JSON.stringify({ time, event: 'start', plugin: '1.4.0', supportedVersions: ['26.2'] });
const line = (o: object) => JSON.stringify(o);
const write = (dir: string, day: string, lines: string[], end = '\n') => fs.writeFileSync(path.join(dir, `${day}.jsonl`), lines.join('\n') + end);

test('reads the contract example', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-18', EXAMPLE);
  const data = await reader.read(NOW);
  assert.ok(data);
  assert.equal(data.badLines, 0);
  assert.deepEqual(data.events, [
    { time: Date.parse('2026-10-18T18:02:11.204Z'), event: 'enter', uuid: UUID, room: 'welcome', client: { version: '1.21.4', protocol: 769, brand: 'vanilla', marker: false, supported: false } },
    { time: Date.parse('2026-10-18T18:02:14.731Z'), event: 'pack', uuid: UUID, room: 'welcome', result: 'loaded', waitMs: 3527 },
    { time: Date.parse('2026-10-18T18:02:39.950Z'), event: 'exit', uuid: UUID, room: 'welcome', how: 'walked', stayedMs: 28746 },
    { time: Date.parse('2026-10-18T18:02:39.951Z'), event: 'enter', uuid: UUID, room: 'compatibility', client: { version: '1.21.4', protocol: 769, brand: 'vanilla', marker: false, supported: false }, warning: 'version' },
    { time: Date.parse('2026-10-18T18:02:40.003Z'), event: 'pack', uuid: UUID, room: 'compatibility', result: 'loaded', waitMs: 52 },
    { time: Date.parse('2026-10-18T18:03:52.018Z'), event: 'exit', uuid: UUID, room: 'compatibility', how: 'quit', stayedMs: 72067 },
  ]);
});

test('reads the server and other player events', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-18', [
    START('2026-10-18T06:00:00Z'),
    line({ time: '2026-10-18T06:01:00.100Z', event: 'skip', uuid: UUID, room: 'compatibility', version: '26.2', protocol: 776, brand: null, marker: true, supported: true, compatible: true }),
    line({ time: '2026-10-18T06:01:00.200Z', event: 'finish', uuid: UUID, first: true }),
    line({ time: '2026-10-18T06:05:00Z', event: 'reminder', uuid: OTHER, warning: 'modded' }),
    line({ time: '2026-10-18T06:06:00Z', event: 'confirm', uuid: OTHER, choice: 'optifine', inRoom: false }),
    line({ time: '2026-10-18T07:00:00Z', event: 'stop' }),
  ]);
  const data = await reader.read(NOW);
  assert.ok(data);
  assert.deepEqual(data.events, [
    { time: Date.parse('2026-10-18T06:00:00Z'), event: 'start', plugin: '1.4.0', supportedVersions: ['26.2'] },
    { time: Date.parse('2026-10-18T06:01:00.100Z'), event: 'skip', uuid: UUID, room: 'compatibility', client: { version: '26.2', protocol: 776, brand: null, marker: true, supported: true }, compatible: true },
    { time: Date.parse('2026-10-18T06:01:00.200Z'), event: 'finish', uuid: UUID, first: true },
    { time: Date.parse('2026-10-18T06:05:00Z'), event: 'reminder', uuid: OTHER, warning: 'modded' },
    { time: Date.parse('2026-10-18T06:06:00Z'), event: 'confirm', uuid: OTHER, choice: 'optifine', inRoom: false },
    { time: Date.parse('2026-10-18T07:00:00Z'), event: 'stop' },
  ]);
  assert.equal(data.coverageStart, Date.parse('2026-10-18T06:00:00Z'));
});

test('a missing folder is no flow log; an empty one has no coverage yet', async () => {
  const root = tempDir();
  assert.equal(await new FlowLogReader(path.join(root, 'flow'), path.join(root, 'cache')).read(NOW), null);
  const { reader } = setup();
  assert.deepEqual(await reader.read(NOW), { events: [], coverageStart: null, badLines: 0, days: 0 });
});

test('coverage starts at the first start event', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-17', [EXAMPLE[0], START('2026-10-17T05:00:00Z'), START('2026-10-17T09:00:00Z')]);
  write(dir, '2026-10-18', [START('2026-10-18T05:00:00Z')]);
  const data = await reader.read(NOW);
  assert.equal(data?.coverageStart, Date.parse('2026-10-17T05:00:00Z'));
});

test('skips an incomplete last line silently, on a closed day and on today', async () => {
  const { dir, reader } = setup();
  const truncated = EXAMPLE[2].slice(0, 40);
  write(dir, '2026-10-10', EXAMPLE.slice(0, 2).concat(truncated), '');
  write(dir, '2026-10-19', EXAMPLE.slice(3, 5).concat(truncated), '');
  const data = await reader.read(NOW);
  assert.equal(data?.badLines, 0);
  assert.deepEqual(data?.events.map((e) => e.event), ['enter', 'pack', 'enter', 'pack']);
});

test('a last line without its line feed still counts when it is whole', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-10', EXAMPLE.slice(0, 3), '');
  const data = await reader.read(NOW);
  assert.deepEqual(data?.events.map((e) => e.event), ['enter', 'pack', 'exit']);
});

test('counts and skips a bad line in the middle', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-10', [EXAMPLE[0], '{"time":"2026-10-10T18:02:12Z","event":"pack",', EXAMPLE[1], 'not json at all', EXAMPLE[2]]);
  write(dir, '2026-10-19', [EXAMPLE[3], '[1,2,3]', EXAMPLE[4]]);
  const data = await reader.read(NOW);
  assert.equal(data?.badLines, 3);
  assert.deepEqual(data?.events.map((e) => e.event), ['enter', 'pack', 'exit', 'enter', 'pack']);
});

test('needs a time, an event, and a uuid on player events', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-10', [
    line({ event: 'finish', uuid: UUID, first: true }),
    line({ time: 'yesterday', event: 'finish', uuid: UUID, first: true }),
    line({ time: 1760800000000, event: 'finish', uuid: UUID, first: true }),
    line({ time: '2026-10-10T10:00:00Z', uuid: UUID }),
    line({ time: '2026-10-10T10:00:00Z', event: 7, uuid: UUID }),
    line({ time: '2026-10-10T10:00:00Z', event: 'finish', first: true }),
    line({ time: '2026-10-10T10:00:00Z', event: 'reminder', uuid: '', warning: 'version' }),
    line({ time: '2026-10-10T10:00:01Z', event: 'stop' }),
  ]);
  const data = await reader.read(NOW);
  assert.equal(data?.badLines, 7);
  assert.deepEqual(data?.events, [{ time: Date.parse('2026-10-10T10:00:01Z'), event: 'stop' }]);
});

test('ignores unknown events and unknown fields, and tolerates missing optional ones', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-10', [
    line({ time: '2026-10-10T10:00:00Z', event: 'teleport', uuid: UUID, to: 'spawn' }),
    line({ time: '2026-10-10T10:00:00Z', event: 'heartbeat' }),
    line({ time: '2026-10-10T10:00:01Z', event: 'enter', uuid: UUID, room: 'welcome', version: '26.2', protocol: 776, brand: 'fabric', marker: true, supported: true, locale: 'nl_be', ping: 41 }),
    line({ time: '2026-10-10T10:00:02Z', event: 'pack', uuid: UUID, room: 'welcome', result: 'loaded' }),
    line({ time: '2026-10-10T10:00:03Z', event: 'exit', uuid: UUID, room: 'welcome', how: 'walked' }),
    line({ time: '2026-10-10T10:00:04Z', event: 'finish', uuid: UUID }),
    line({ time: '2026-10-10T10:00:05Z', event: 'enter', uuid: OTHER, room: 'welcome', protocol: '776', marker: 'yes' }),
  ]);
  const data = await reader.read(NOW);
  assert.equal(data?.badLines, 0);
  assert.deepEqual(data?.events, [
    { time: Date.parse('2026-10-10T10:00:01Z'), event: 'enter', uuid: UUID, room: 'welcome', client: { version: '26.2', protocol: 776, brand: 'fabric', marker: true, supported: true } },
    { time: Date.parse('2026-10-10T10:00:02Z'), event: 'pack', uuid: UUID, room: 'welcome', result: 'loaded' },
    { time: Date.parse('2026-10-10T10:00:03Z'), event: 'exit', uuid: UUID, room: 'welcome', how: 'walked' },
    { time: Date.parse('2026-10-10T10:00:04Z'), event: 'finish', uuid: UUID },
    { time: Date.parse('2026-10-10T10:00:05Z'), event: 'enter', uuid: OTHER, room: 'welcome', client: {} },
  ]);
});

test('reads only files named YYYY-MM-DD.jsonl, in day order', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-12', [START('2026-10-12T06:00:00Z')]);
  write(dir, '2026-10-11', [START('2026-10-11T06:00:00Z')]);
  fs.writeFileSync(path.join(dir, '2026-10-11.jsonl.bak'), START('2026-10-01T06:00:00Z') + '\n');
  fs.writeFileSync(path.join(dir, '2026-10-1.jsonl'), START('2026-10-01T06:00:00Z') + '\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), START('2026-10-01T06:00:00Z') + '\n');
  fs.mkdirSync(path.join(dir, '2026-10-05.jsonl'));
  const data = await reader.read(NOW);
  assert.equal(data?.days, 2);
  assert.deepEqual(data?.events.map((e) => e.time), [Date.parse('2026-10-11T06:00:00Z'), Date.parse('2026-10-12T06:00:00Z')]);
});

test('keeps the events of a visit that crosses UTC midnight in order', async () => {
  const { dir, reader } = setup();
  write(dir, '2026-10-17', [
    line({ time: '2026-10-17T23:59:50Z', event: 'enter', uuid: UUID, room: 'welcome' }),
  ]);
  write(dir, '2026-10-18', [
    line({ time: '2026-10-18T00:00:05Z', event: 'pack', uuid: UUID, room: 'welcome', result: 'loaded', waitMs: 15000 }),
    line({ time: '2026-10-18T00:00:30Z', event: 'exit', uuid: UUID, room: 'welcome', how: 'quit', stayedMs: 40000 }),
  ]);
  const data = await reader.read(NOW);
  assert.deepEqual(data?.events.map((e) => e.event), ['enter', 'pack', 'exit']);
});

test('caches closed days and reads them again only when their size changes', async () => {
  const { dir, cacheDir, reader } = setup();
  write(dir, '2026-10-10', [EXAMPLE[0]]);
  await reader.read(NOW);
  const cached = fs.readdirSync(cacheDir, { recursive: true }).map(String);
  assert.ok(cached.some((f) => f.endsWith('2026-10-10.jsonl.json')), `no cache file in ${cached.join(', ')}`);

  // Same size, other content: the cache answers, also for a new reader (a restart)
  const changed = EXAMPLE[0].replace('"welcome"', '"WELCOME"');
  write(dir, '2026-10-10', [changed]);
  const again = await new FlowLogReader(dir, cacheDir).read(NOW);
  assert.equal((again?.events[0] as { room?: string }).room, 'welcome');

  // Another size: read again
  write(dir, '2026-10-10', [changed, EXAMPLE[1]]);
  const fresh = await new FlowLogReader(dir, cacheDir).read(NOW);
  assert.deepEqual(fresh?.events.map((e) => (e as { room?: string }).room), ['WELCOME', 'welcome']);
});

test('drops the cache of a day the plugin deleted', async () => {
  const { dir, cacheDir, reader } = setup();
  write(dir, '2026-10-10', [EXAMPLE[0]]);
  write(dir, '2026-10-11', [EXAMPLE[1]]);
  await reader.read(NOW);
  fs.rmSync(path.join(dir, '2026-10-10.jsonl'));
  const data = await reader.read(NOW);
  assert.deepEqual(data?.events.map((e) => e.event), ['pack']);
  const cached = fs.readdirSync(cacheDir, { recursive: true }).map(String);
  assert.ok(!cached.some((f) => f.endsWith('2026-10-10.jsonl.json')));
});

test("reads only new complete lines of today's and yesterday's files", async () => {
  const { dir, cacheDir, reader } = setup();
  const today = path.join(dir, '2026-10-19.jsonl');
  const yesterday = path.join(dir, '2026-10-18.jsonl');
  fs.writeFileSync(yesterday, EXAMPLE[0] + '\n');
  fs.writeFileSync(today, EXAMPLE[3] + '\n' + EXAMPLE[4].slice(0, 30));
  const first = await reader.read(NOW);
  assert.deepEqual(first?.events.map((e) => e.event), ['enter', 'enter']);
  assert.equal(first?.badLines, 0);

  // Lines already read are not read again: overwrite them in place (same bytes, other content)
  for (const file of [yesterday, today]) {
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from('X'), 0, 1, 0);
    fs.closeSync(fd);
  }
  // The incomplete line is completed, and more is appended
  fs.appendFileSync(today, EXAMPLE[4].slice(30) + '\n' + EXAMPLE[5] + '\n');
  fs.appendFileSync(yesterday, EXAMPLE[1] + '\n');
  const second = await reader.read(NOW);
  assert.equal(second?.badLines, 0);
  assert.deepEqual(second?.events.map((e) => e.event), ['enter', 'pack', 'enter', 'pack', 'exit']);
  // Open days are not cached
  assert.ok(!fs.existsSync(cacheDir) || !fs.readdirSync(cacheDir, { recursive: true }).map(String).some((f) => f.endsWith('.jsonl.json')));
});

test('reads a file again from the start when it shrank', async () => {
  const { dir, reader } = setup();
  const today = path.join(dir, '2026-10-19.jsonl');
  fs.writeFileSync(today, EXAMPLE.slice(0, 3).join('\n') + '\n');
  assert.equal((await reader.read(NOW))?.events.length, 3);
  fs.writeFileSync(today, EXAMPLE[3] + '\n');
  assert.deepEqual((await reader.read(NOW))?.events.map((e) => (e as { room?: string }).room), ['compatibility']);
});

test('a day that closes is read whole once more, then from the cache', async () => {
  const { dir, cacheDir, reader } = setup();
  const day = path.join(dir, '2026-10-18.jsonl');
  fs.writeFileSync(day, EXAMPLE[0] + '\n' + EXAMPLE[1].slice(0, 20));
  assert.equal((await reader.read(NOW))?.events.length, 1);
  // Two days later 2026-10-18 is closed; its incomplete last line never finished
  const later = NOW + 2 * 24 * 60 * 60 * 1000;
  const data = await reader.read(later);
  assert.equal(data?.events.length, 1);
  assert.equal(data?.badLines, 0);
  assert.ok(fs.readdirSync(cacheDir, { recursive: true }).map(String).some((f) => f.endsWith('2026-10-18.jsonl.json')));
});

test('INTRO_FLOW_DIR, else flow/ in INTRO_DIR, else in the plugin folder next to the world', () => {
  const saved = { flow: process.env.INTRO_FLOW_DIR, intro: process.env.INTRO_DIR };
  try {
    delete process.env.INTRO_FLOW_DIR;
    delete process.env.INTRO_DIR;
    const world = path.resolve('srv', 'hub', 'world');
    assert.equal(flowLogDir(world), path.join(path.resolve('srv', 'hub'), 'plugins', 'MCME-Introduction', 'flow'));
    process.env.INTRO_DIR = path.resolve('intro');
    assert.equal(flowLogDir(world), path.join(path.resolve('intro'), 'flow'));
    process.env.INTRO_FLOW_DIR = path.resolve('elsewhere');
    assert.equal(flowLogDir(world), path.resolve('elsewhere'));
  } finally {
    for (const [key, value] of [['INTRO_FLOW_DIR', saved.flow], ['INTRO_DIR', saved.intro]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
