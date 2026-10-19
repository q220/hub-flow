import fs from 'fs';
import path from 'path';
import type { JourneyClient } from '../../shared/protocol.js';
import { config } from '../config.js';
import { introDir } from './intro-progress.js';

/**
 * MCME-Introduction's flow log (since 1.4.0): one JSON object per line for
 * each step a player takes through the intro rooms, in flow/YYYY-MM-DD.jsonl
 * by UTC day, kept 90 days. The plugin's docs/flow-log.md is the contract;
 * unknown events and fields are ignored, as it asks.
 *
 * Days before yesterday no longer change, so each is read once and cached.
 * Today's and yesterday's files are read on from where the last read
 * stopped: the plugin may still append to yesterday's just after midnight.
 */

export type FlowLogEvent =
  | { time: number; event: 'start'; plugin?: string; supportedVersions?: string[] }
  | { time: number; event: 'stop' }
  | { time: number; event: 'enter'; uuid: string; room?: string; client: JourneyClient; warning?: string }
  | { time: number; event: 'skip'; uuid: string; room?: string; client: JourneyClient; compatible?: boolean }
  | { time: number; event: 'pack'; uuid: string; room?: string; result?: string; waitMs?: number }
  | { time: number; event: 'exit'; uuid: string; room?: string; how?: string; stayedMs?: number }
  | { time: number; event: 'finish'; uuid: string; first?: boolean }
  | { time: number; event: 'reminder'; uuid: string; warning?: string }
  | { time: number; event: 'confirm'; uuid: string; choice?: string; inRoom?: boolean };

export interface FlowLogData {
  /** Every known event, in the order written: days in order, lines in order */
  events: FlowLogEvent[];
  /** Time of the first `start` in the files still kept: players who joined since are covered */
  coverageStart: number | null;
  /** Lines that are not JSON, or lack a time, an event or a player; an incomplete last line is not counted */
  badLines: number;
  /** Day files read */
  days: number;
}

/** Change whenever parsing changes, so cached days are read again */
const PARSER_KEY = 'flow-log-v1';
const DAY_FILE = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const LF = 0x0a;

/** INTRO_FLOW_DIR, else flow/ in the plugin folder (INTRO_DIR) */
export function flowLogDir(worldPath: string): string {
  return process.env.INTRO_FLOW_DIR || path.join(introDir(worldPath), 'flow');
}

interface DayPart {
  events: FlowLogEvent[];
  badLines: number;
}

/** A closed day as cached: `size` tells whether the file is still the one read */
interface CachedDay extends DayPart {
  size: number;
}

/** An open day: how far it has been read */
interface OpenDay extends DayPart {
  offset: number;
}

export class FlowLogReader {
  private readonly open = new Map<string, OpenDay>();

  constructor(
    private readonly dir: string,
    private readonly cacheDir = path.join(config.cacheDir, 'flow-log', PARSER_KEY),
  ) {}

  /** Everything in the log now, or null when its folder is missing */
  async read(now = Date.now()): Promise<FlowLogData | null> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      this.open.clear();
      return null;
    }
    const yesterday = new Date(now - DAY_MS).toISOString().slice(0, 10);
    const days = names.filter((n) => DAY_FILE.test(n)).sort();

    const events: FlowLogEvent[] = [];
    let badLines = 0;
    let read = 0;
    const closed = new Set<string>();
    for (const name of days) {
      const file = path.join(this.dir, name);
      let part: DayPart;
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) continue;
        if (name.slice(0, 10) < yesterday) {
          part = await this.closedDay(name, file, stat.size);
          closed.add(name);
          this.open.delete(name);
        } else {
          part = await this.openDay(name, file);
        }
      } catch {
        continue; // deleted while being read: the plugin drops days older than 90
      }
      read++;
      for (const e of part.events) events.push(e);
      badLines += part.badLines;
    }
    for (const name of [...this.open.keys()]) {
      if (!days.includes(name)) this.open.delete(name);
    }
    this.pruneCache(closed);

    const start = events.find((e) => e.event === 'start');
    return { events, coverageStart: start?.time ?? null, badLines, days: read };
  }

  private async closedDay(name: string, file: string, size: number): Promise<CachedDay> {
    const cacheFile = path.join(this.cacheDir, `${name}.json`);
    try {
      const cached: CachedDay = JSON.parse(await fs.promises.readFile(cacheFile, 'utf-8'));
      if (cached.size === size && Array.isArray(cached.events)) return cached;
    } catch {
      // Not cached yet
    }
    const buf = await fs.promises.readFile(file);
    const day: CachedDay = { size: buf.length, events: [], badLines: 0 };
    const end = buf.lastIndexOf(LF) + 1;
    parseLines(buf.subarray(0, end).toString('utf-8'), day);
    // A last line without its line feed was cut off mid-write, unless it parses
    const last = parseLine(buf.subarray(end).toString('utf-8'));
    if (typeof last === 'object') day.events.push(last);
    else if (last === 'invalid') day.badLines++;
    try {
      await fs.promises.mkdir(this.cacheDir, { recursive: true });
      await fs.promises.writeFile(cacheFile, JSON.stringify(day));
    } catch (e: any) {
      console.warn(`  Flow log: could not cache ${name}: ${e.code || e.message}`);
    }
    return day;
  }

  /** Reads on from the last complete line read; from the start again if the file shrank */
  private async openDay(name: string, file: string): Promise<OpenDay> {
    let day = this.open.get(name);
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (!day || size < day.offset) this.open.set(name, (day = { offset: 0, events: [], badLines: 0 }));
      if (size > day.offset) {
        const buf = Buffer.alloc(size - day.offset);
        const { bytesRead } = await handle.read(buf, 0, buf.length, day.offset);
        // Only whole lines: the last one may still be being written
        const end = buf.subarray(0, bytesRead).lastIndexOf(LF) + 1;
        parseLines(buf.subarray(0, end).toString('utf-8'), day);
        day.offset += end;
      }
    } finally {
      await handle.close();
    }
    return day;
  }

  /** Cached days the plugin has since deleted */
  private pruneCache(closed: Set<string>): void {
    let cached: string[];
    try {
      cached = fs.readdirSync(this.cacheDir);
    } catch {
      return;
    }
    for (const f of cached) {
      if (f.endsWith('.jsonl.json') && !closed.has(f.slice(0, -'.json'.length))) {
        try {
          fs.rmSync(path.join(this.cacheDir, f), { force: true });
        } catch {
          // Tried again at the next refresh
        }
      }
    }
  }
}

/** Whole lines (a split on line feeds); every line that is not an event or an unknown one is bad */
function parseLines(text: string, into: DayPart): void {
  for (const line of text.split('\n')) {
    const e = parseLine(line);
    if (typeof e === 'object') into.events.push(e);
    else if (e === 'unparseable' || e === 'invalid') into.badLines++;
  }
}

type LineResult = FlowLogEvent | 'empty' | 'unknown' | 'unparseable' | 'invalid';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The object without its undefined fields, so events compare and cache alike */
export function defined<T extends object>(o: T): T {
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] === undefined) delete o[key];
  }
  return o;
}

function client(o: Record<string, unknown>): JourneyClient {
  return defined({
    version: str(o.version),
    protocol: num(o.protocol),
    brand: o.brand === null ? null : str(o.brand),
    marker: bool(o.marker),
    supported: bool(o.supported),
  });
}

export function parseLine(line: string): LineResult {
  if (line.trim() === '') return 'empty';
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return 'unparseable';
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const o = raw as Record<string, unknown>;
  const time = typeof o.time === 'string' ? Date.parse(o.time) : NaN;
  if (!Number.isFinite(time) || typeof o.event !== 'string') return 'invalid';

  switch (o.event) {
    case 'start':
      return defined({
        time, event: 'start' as const, plugin: str(o.plugin),
        supportedVersions: Array.isArray(o.supportedVersions) ? o.supportedVersions.filter((v): v is string => typeof v === 'string') : undefined,
      });
    case 'stop':
      return { time, event: 'stop' };
    case 'enter': case 'skip': case 'pack': case 'exit': case 'finish': case 'reminder': case 'confirm':
      break;
    default:
      return 'unknown';
  }

  // Player events: lower case, as player files name them
  if (typeof o.uuid !== 'string' || o.uuid === '') return 'invalid';
  const uuid = o.uuid.toLowerCase();
  switch (o.event) {
    case 'enter':
      return defined({ time, event: 'enter' as const, uuid, room: str(o.room), client: client(o), warning: str(o.warning) });
    case 'skip':
      return defined({ time, event: 'skip' as const, uuid, room: str(o.room), client: client(o), compatible: bool(o.compatible) });
    case 'pack':
      return defined({ time, event: 'pack' as const, uuid, room: str(o.room), result: str(o.result), waitMs: num(o.waitMs) });
    case 'exit':
      return defined({ time, event: 'exit' as const, uuid, room: str(o.room), how: str(o.how), stayedMs: num(o.stayedMs) });
    case 'finish':
      return defined({ time, event: 'finish' as const, uuid, first: bool(o.first) });
    case 'reminder':
      return defined({ time, event: 'reminder' as const, uuid, warning: str(o.warning) });
    default:
      return defined({ time, event: 'confirm' as const, uuid, choice: str(o.choice), inRoom: bool(o.inRoom) });
  }
}
