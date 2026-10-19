import type { IntroStatus, JourneyClient, JourneyVisit, PackResult, PlayerJourney } from '../../shared/protocol.js';
import { clientVersionName } from '../../shared/constants.js';
import { defined, type FlowLogEvent } from './flow-log.js';

/**
 * Each player's way through the intro rooms, folded from the flow log's
 * events in the order they were written: all days together, since a visit
 * can cross midnight. What a journey says about the intro (outcome, pack
 * result, client) is read with the functions below.
 */

/** What the history keeps of a journey once the flow log is gone */
export interface JourneySummary {
  outcome: IntroStatus;
  /** The intro's pack result (journeyPack) and how long it took */
  pack?: PackResult;
  packWaitMs?: number;
  /** The client of the last room entered or passed over */
  protocol?: number;
  version?: string;
  brand?: string | null;
  marker?: boolean;
  supported?: boolean;
  /** The warning screen of the last compatibility visit */
  warning?: string;
  welcomeVisits: number;
  compatibilityVisits: number;
  /** How the last visit ended; absent while the player was still in the room */
  lastExit?: string;
  finishedAt?: number;
  reminders: number;
  /** /confirm choices, in order */
  confirms?: string[];
}

export function assembleJourneys(events: FlowLogEvent[]): Map<string, PlayerJourney> {
  const journeys = new Map<string, PlayerJourney>();
  /** The visit each player is in now */
  const inRoom = new Map<string, JourneyVisit>();

  const journey = (uuid: string) => {
    let j = journeys.get(uuid);
    if (!j) journeys.set(uuid, (j = { visits: [], skips: [], reminders: 0, confirms: [] }));
    return j;
  };
  const sameRoom = (v: JourneyVisit, room: string | undefined) => room === undefined || v.room === undefined || v.room === room;

  for (const e of events) {
    switch (e.event) {
      case 'start':
      case 'stop':
        // A clean stop logs every exit first; whoever is still in a room after a crash left unseen
        for (const v of inRoom.values()) v.exit = { how: 'unknown' };
        inRoom.clear();
        break;
      case 'enter': {
        const open = inRoom.get(e.uuid);
        if (open) open.exit = { how: 'unknown' };
        const visit: JourneyVisit = defined({ room: e.room, at: e.time, client: e.client, warning: e.warning, packs: [] });
        journey(e.uuid).visits.push(visit);
        inRoom.set(e.uuid, visit);
        break;
      }
      case 'skip':
        journey(e.uuid).skips.push(defined({ room: e.room, at: e.time, client: e.client, compatible: e.compatible }));
        break;
      case 'pack': {
        const visit = inRoom.get(e.uuid);
        if (visit && e.result !== undefined && sameRoom(visit, e.room)) visit.packs.push(defined({ result: e.result, waitMs: e.waitMs }));
        break;
      }
      case 'exit': {
        let visit = inRoom.get(e.uuid);
        inRoom.delete(e.uuid);
        if (!visit || !sameRoom(visit, e.room)) {
          // Entered unseen (a lost line): the exit still says which room the player was in
          if (visit) visit.exit = { how: 'unknown' };
          visit = defined({ room: e.room, at: e.time - (e.stayedMs ?? 0), client: {}, packs: [] });
          journey(e.uuid).visits.push(visit);
        }
        visit.exit = defined({ how: e.how ?? 'unknown', at: e.time, stayedMs: e.stayedMs });
        break;
      }
      case 'finish': {
        const j = journey(e.uuid);
        j.finish ??= defined({ at: e.time, first: e.first });
        break;
      }
      case 'reminder':
        journey(e.uuid).reminders++;
        break;
      case 'confirm':
        journey(e.uuid).confirms.push(defined({ at: e.time, choice: e.choice, inRoom: e.inRoom }));
        break;
    }
  }
  return journeys;
}

/** Finished, else the room of the last visit; other when there is none or the player got out another way */
export function journeyOutcome(j: PlayerJourney): IntroStatus {
  if (j.finish) return 'finished';
  const last = j.visits.at(-1);
  if (!last || last.exit?.how === 'left') return 'other';
  return last.room === 'welcome' || last.room === 'compatibility' ? last.room : 'other';
}

/** The flow log's final results, as Architect's results are named (pack-status.ts) */
const FINAL_RESULTS = new Map<string, PackResult>([
  ['loaded', 'loaded'],
  ['declined', 'declined'],
  ['failed_download', 'failed_download'],
  ['failed_reload', 'failed_reload'],
  ['invalid_url', 'failed_download'],
  ['timeout', 'no_result'],
]);

/** The intro's pack result: the last final one over all visits, else not_sent; undefined without one */
export function journeyPack(j: PlayerJourney): { result: PackResult; waitMs?: number } | undefined {
  let final: { result: PackResult; waitMs?: number } | undefined;
  let notSent: { result: PackResult; waitMs?: number } | undefined;
  for (const v of j.visits) {
    for (const p of v.packs) {
      const result = FINAL_RESULTS.get(p.result);
      if (result) final = defined({ result, waitMs: p.waitMs });
      else if (p.result === 'not_sent') notSent = defined({ result: 'not_sent' as const, waitMs: p.waitMs });
    }
  }
  return final ?? notSent;
}

/** The client of the last room entered or passed over */
export function journeyClient(j: PlayerJourney): JourneyClient | undefined {
  let last: { at: number; client: JourneyClient } | undefined;
  for (const x of [...j.visits, ...j.skips]) {
    if (Object.keys(x.client).length > 0 && (!last || x.at >= last.at)) last = x;
  }
  return last?.client;
}

/** The name Plan's protocols get (clientVersionName), else the version the log gives */
export function clientName(c: Pick<JourneyClient, 'protocol' | 'version'>): string | undefined {
  if (c.protocol !== undefined) return c.protocol > 0 ? clientVersionName(c.protocol) : undefined;
  return c.version;
}

export function summarizeJourney(j: PlayerJourney): JourneySummary {
  const pack = journeyPack(j);
  const client = journeyClient(j) ?? {};
  const last = j.visits.at(-1);
  const choices = j.confirms.flatMap((c) => (c.choice ? [c.choice] : []));
  return defined({
    outcome: journeyOutcome(j),
    pack: pack?.result,
    packWaitMs: pack?.waitMs,
    protocol: client.protocol,
    version: client.version,
    brand: client.brand,
    marker: client.marker,
    supported: client.supported,
    warning: [...j.visits].reverse().find((v) => v.room === 'compatibility')?.warning,
    welcomeVisits: j.visits.filter((v) => v.room === 'welcome').length,
    compatibilityVisits: j.visits.filter((v) => v.room === 'compatibility').length,
    lastExit: last?.exit?.how,
    finishedAt: j.finish?.at,
    reminders: j.reminders,
    confirms: choices.length > 0 ? choices : undefined,
  });
}
