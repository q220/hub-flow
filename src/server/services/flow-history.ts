import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import type { JourneySummary } from './journey.js';

/**
 * What the server logs and the flow log said about each new player, kept
 * after they are gone (servers delete logs after about three months, the
 * intro plugin its flow log after 90 days). Hub visits, the first visit's
 * length, reaching another server and coming back within 7 days are
 * recorded while the logs cover a player, and frozen once they are final:
 * 8 days after the first join. The journey summary is recorded while the
 * flow log covers a player and frozen 8 days after the first join, apart
 * from the log fields. Unlike the caches, this cannot be rebuilt.
 *
 * Version 2 added the journey. A version 1 file is read as it is and
 * written as version 2 at the next save. A copy of it is kept beside it as
 * flow-history.v1.json, to put back by hand if this release is rolled back:
 * the release before reads only flow-history.json, and sets a version 2
 * file aside. That copy is never written over; a later migration keeps its
 * own as flow-history.v1-<time>.json. A file of a newer version is left
 * alone: neither used nor written over.
 */

export interface HistoryEntry {
  firstJoined: number;
  sessions?: number;
  firstSessionMs?: number;
  reachedServer?: boolean;
  returned7d?: boolean;
  frozen?: boolean;
  /** What the flow log said (version 2) */
  journey?: JourneySummary;
  journeyFrozen?: boolean;
}

/** The fields the logs give, as recorded */
export type LoggedFields = Pick<HistoryEntry, 'sessions' | 'firstSessionMs' | 'reachedServer' | 'returned7d'>;

const FILE_VERSION = 2;
const FREEZE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

export const historyFile = path.join(config.dataDir, 'flow-history.json');

/** The entry without its journey */
function logPart(e: HistoryEntry): HistoryEntry {
  const { journey, journeyFrozen, ...rest } = e;
  return rest;
}

/** The entry's journey alone, if any */
function journeyPart(e: HistoryEntry | undefined): Pick<HistoryEntry, 'journey' | 'journeyFrozen'> {
  if (!e?.journey) return {};
  return e.journeyFrozen ? { journey: e.journey, journeyFrozen: true } : { journey: e.journey };
}

export class FlowHistory {
  private changed: boolean;
  /** The version 1 file has been copied (a save can fail after the copy) */
  private v1Copied = false;

  private constructor(
    private readonly file: string,
    private readonly entries: Map<string, HistoryEntry>,
    /** The version of the file on disk */
    private fileVersion: number,
    /** A newer release's file: never written over */
    private readonly readOnly: boolean,
  ) {
    // A version 1 file is written as version 2 at the first save
    this.changed = !readOnly && fileVersion < FILE_VERSION;
  }

  static load(file = historyFile): FlowHistory {
    const entries = new Map<string, HistoryEntry>();
    if (!fs.existsSync(file)) return new FlowHistory(file, entries, FILE_VERSION, false);

    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!Number.isInteger(data?.version) || data.version < 1 || typeof data.players !== 'object' || data.players === null || Array.isArray(data.players)) {
        throw new Error(`unknown format ${data?.version}`);
      }
    } catch (e: any) {
      // Never write over a history we could not read: set it aside and start again
      const aside = `${file}.unreadable-${Date.now()}`;
      fs.renameSync(file, aside);
      console.warn(`  Flow history unreadable (${e.message}); moved to ${aside}`);
      return new FlowHistory(file, entries, FILE_VERSION, false);
    }
    if (data.version > FILE_VERSION) {
      console.warn(`  Flow history is version ${data.version}, from a newer release; it is left alone until that release runs again`);
      return new FlowHistory(file, entries, data.version, true);
    }
    // A version 1 entry is a version 2 entry without a journey
    for (const [uuid, entry] of Object.entries(data.players)) entries.set(uuid, entry as HistoryEntry);
    return new FlowHistory(file, entries, data.version, false);
  }

  get size(): number {
    return this.entries.size;
  }

  get(uuid: string): HistoryEntry | undefined {
    return this.entries.get(uuid);
  }

  /** Earliest first join with this field recorded */
  earliest(field: keyof LoggedFields | 'journey'): number | null {
    let min: number | null = null;
    for (const e of this.entries.values()) {
      if (e[field] !== undefined && (min === null || e.firstJoined < min)) min = e.firstJoined;
    }
    return min;
  }

  /** Record what the logs say about a player now; frozen log fields stay as they are */
  record(uuid: string, firstJoined: number, logged: LoggedFields, now: number): void {
    const prev = this.entries.get(uuid);
    if (prev?.frozen) return;
    const final = now - firstJoined >= FREEZE_AFTER_MS && logged.sessions !== undefined && logged.reachedServer !== undefined;
    this.put(uuid, { firstJoined, ...logged, ...(final ? { frozen: true } : {}), ...journeyPart(prev) });
  }

  /** Record what the flow log says about a player now; a frozen journey stays as it is */
  recordJourney(uuid: string, firstJoined: number, journey: JourneySummary, now: number): void {
    const prev = this.entries.get(uuid);
    if (prev?.journeyFrozen) return;
    const final = now - firstJoined >= FREEZE_AFTER_MS;
    this.put(uuid, { ...logPart(prev ?? { firstJoined }), journey, ...(final ? { journeyFrozen: true } : {}) });
  }

  private put(uuid: string, next: HistoryEntry): void {
    const prev = this.entries.get(uuid);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
      this.entries.set(uuid, next);
      this.changed = true;
    }
  }

  /** Write the file if anything changed since the last save */
  save(): boolean {
    if (this.readOnly || !this.changed) return false;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    if (this.fileVersion === 1 && !this.v1Copied && fs.existsSync(this.file)) {
      // To restore by hand on a rollback; an earlier copy may be the only one of a longer history
      const name = path.basename(this.file, '.json');
      try {
        fs.copyFileSync(this.file, path.join(dir, `${name}.v1.json`), fs.constants.COPYFILE_EXCL);
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        fs.copyFileSync(this.file, path.join(dir, `${name}.v1-${Date.now()}.json`), fs.constants.COPYFILE_EXCL);
      }
      this.v1Copied = true;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, players: Object.fromEntries(this.entries) }));
    fs.renameSync(tmp, this.file);
    this.fileVersion = FILE_VERSION;
    this.changed = false;
    return true;
  }
}
