import fs from 'fs';
import path from 'path';
import type {
  ClientGroup, EventImpact, FlowBucket, FlowCounts, FlowEvent, FlowPlayer, FlowResponse, FlowSignal, FlowSignalsResponse, IntroStatus,
  JourneyCheck, JourneyDisagreement, NewRelease, PackGroup, PackHealthRow, PackInfo, PackResult, PackResultGroup, PlayerJourney,
  PlayerRecord, ReleaseCheck, SessionStats, VersionPackResults,
} from '../../shared/protocol.js';
import { clientVersionName } from '../../shared/constants.js';
import { DEFAULT_HUB_DATE } from '../../shared/protocol.js';
import { introStatus, type IntroData } from './intro-progress.js';
import type { SessionData } from './hub-sessions.js';
import type { ProxyActivity } from './proxy-activity.js';
import type { FlowHistory, HistoryEntry, LoggedFields } from './flow-history.js';
import { releaseKey, type ReleaseLog } from './release-log.js';
import { clientName, journeyClient, journeyOutcome, journeyPack, summarizeJourney, type JourneySummary } from './journey.js';

const DAY = 24 * 60 * 60 * 1000;
const RETURN_WINDOW_MS = 7 * DAY;
/** The hub's name on the proxy; any other server counts as moving on */
const HUB_SERVER = process.env.HUB_SERVER_NAME || 'hub';

/** Ranges up to this long are bucketed by day, longer ones by week */
const DAILY_MAX_MS = 35 * DAY;
/** Signals compare the last 14 days with the 8 weeks before */
const SIGNAL_WINDOW_MS = 14 * DAY;
const SIGNAL_BASELINE_MS = 56 * DAY;
/** Fewer new players than this in the window and rates are too noisy to judge */
const SIGNAL_MIN_PLAYERS = 15;
/** A pack release needs this many players before its failure rate is judged */
const PACK_MIN_PLAYERS = 20;
const PACK_FAIL_RATE = 0.3;
/** The fast check: new players' pack results over the last day, and releases the tool saw appear */
const FAST_WINDOW_MS = DAY;
const NEW_RELEASE_MS = 7 * DAY;
/** How long a new release's results stay among the signals while it is not failing */
const RELEASE_NOTE_MS = 3 * DAY;
/** A game version fails when this many of its players tried the pack (loaded or failed) and this share failed */
const FAST_MIN_TRIED = 8;
const FAST_FAIL_RATE = 0.6;
/** Markers compare the 7 days before with the 7 days after */
const EVENT_WINDOW_MS = 7 * DAY;

const OUTCOMES: IntroStatus[] = ['finished', 'welcome', 'compatibility', 'other'];

export interface FlowSources {
  players: PlayerRecord[];
  intro: IntroData | null;
  packs: Map<string, PackInfo> | null;
  sessions: SessionData | null;
  activity: ProxyActivity | null;
  /** Client protocol by UUID (Plan) */
  clients: Map<string, number> | null;
  /** What the logs said before they were deleted */
  history: FlowHistory | null;
  /** When each pack release first appeared */
  releases: ReleaseLog | null;
  serverVersion: string;
  events: FlowEvent[];
  /** MCME-Introduction's flow log: each player's way through the rooms */
  flowLog: FlowLogSource | null;
}

export interface FlowLogSource {
  /** Players who first joined since are covered; null before the first `start` */
  coverageStart: number | null;
  badLines: number;
  journeys: Map<string, PlayerJourney>;
}

/** Dated changes to mark on the charts: FLOW_EVENTS_FILE, else events.json in the working directory */
export function loadFlowEvents(): FlowEvent[] {
  const file = process.env.FLOW_EVENTS_FILE || path.resolve('events.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return (Array.isArray(data) ? data : [])
      .filter((e) => typeof e?.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(e.date) && typeof e.label === 'string')
      .map((e) => ({ date: e.date, label: e.label }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function emptyCounts(): FlowCounts {
  return {
    players: 0, finished: 0, welcome: 0, compatibility: 0, other: 0,
    activityKnown: 0, reachedServer: 0, finishedMovedOn: 0, returnEligible: 0, returned7d: 0,
    packKnown: 0, packLoaded: 0, packFailed: 0, packDeclined: 0,
  };
}

/** `packResult`: the intro's (introPack), unless counting a release's own players */
function add(c: FlowCounts, p: FlowPlayer, packResult = p.introPack): void {
  c.players++;
  c[p.outcome]++;
  if (p.reachedServer !== undefined) {
    c.activityKnown++;
    if (p.reachedServer) {
      c.reachedServer++;
      if (p.outcome === 'finished') c.finishedMovedOn++;
    }
  }
  if (p.returned7d !== undefined) {
    c.returnEligible++;
    if (p.returned7d) c.returned7d++;
  }
  if (packResult) {
    c.packKnown++;
    if (packResult === 'loaded') c.packLoaded++;
    else if (isFailure(packResult)) c.packFailed++;
    else if (packResult === 'declined') c.packDeclined++;
  }
}

/** Disagreements that are about the outcome; the others are often right */
const OUTCOME_DISAGREEMENTS = new Set<JourneyDisagreement>(['finish-not-listed', 'listed-not-finished', 'room']);

function isFailure(r: PackResult): boolean {
  return r === 'failed_reload' || r === 'failed_download';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function startOfWeek(t: number): number {
  const d = new Date(startOfDay(t));
  const sinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday).getTime();
}

function nextBucket(t: number, bucket: 'day' | 'week'): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (bucket === 'day' ? 1 : 7)).getTime();
}

/** Natural order for release tags: v4.0.5 > v4.0 > v3.9 > v3.5.29 */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa.at(i) ?? 0) - (pb.at(i) ?? 0);
    if (diff) return diff;
  }
  return 0;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
const tried = (r: { loaded: number; failed: number }) => r.loaded + r.failed;
const failing = (r: { loaded: number; failed: number }) => tried(r) >= FAST_MIN_TRIED && r.failed / tried(r) >= FAST_FAIL_RATE;
const releaseName = (r: { variant: string; version: string }) => `${r.variant} ${r.version}`;
/** Signal ids reach the admin dashboard, which takes [\w.:-] only */
const signalId = (...parts: string[]) => parts.map((p) => p.replace(/[^\w.-]/g, '_')).join(':').slice(0, 80);
const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

function emptyVersion(version: string, matchesServer: boolean): VersionPackResults {
  return { version, matchesServer, players: 0, loaded: 0, failed: 0, declined: 0 };
}

function addResult(v: { players: number; loaded: number; failed: number; declined: number }, result: PackResult | undefined): void {
  v.players++;
  if (result === 'loaded') v.loaded++;
  else if (result && isFailure(result)) v.failed++;
  else if (result === 'declined') v.declined++;
}

/** "26.3: 12 of 14 failed" per game version with results */
function versionSummary(byClient: VersionPackResults[], word: 'failed' | 'loaded'): string {
  return byClient
    .filter((v) => tried(v) > 0)
    .map((v) => `${v.version}: ${(word === 'failed' ? v.failed : v.loaded).toLocaleString('en-US')} of ${tried(v).toLocaleString('en-US')} ${word}`)
    .join(', ');
}
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export class FlowModel {
  /** New players since the hub intro opened, newest first */
  private readonly flowPlayers: FlowPlayer[];
  private readonly packHealthRows: PackHealthRow[];
  private readonly fastCheck: ReleaseCheck;
  /** What the current logs say about each covered player, to keep in the history */
  private readonly fromLogs = new Map<string, { firstJoined: number; logged: LoggedFields }>();
  /** The same for the flow log */
  private readonly fromJourneys = new Map<string, { firstJoined: number; summary: JourneySummary }>();

  constructor(private readonly src: FlowSources, readonly generatedAt = Date.now()) {
    this.flowPlayers = src.players
      .filter((p) => p.firstJoined !== undefined && p.firstJoined >= DEFAULT_HUB_DATE)
      .map((p) => this.toFlowPlayer(p))
      .sort((a, b) => b.firstJoined - a.firstJoined);
    this.packHealthRows = this.buildPackHealth();
    this.fastCheck = this.buildReleaseCheck();
  }

  private toFlowPlayer(p: PlayerRecord): FlowPlayer {
    const firstJoined = p.firstJoined!;
    const pack = this.src.packs?.get(p.uuid);
    const fp: FlowPlayer = {
      uuid: p.uuid,
      name: p.name,
      firstJoined,
      lastOnline: p.lastOnline,
      outcome: this.src.intro ? introStatus(this.src.intro, p) : 'other',
      outcomeFrom: 'inferred',
      pack,
      introPack: pack?.result,
      clientVersion: this.clientVersion(p.uuid),
      x: p.x,
      y: p.y,
      z: p.z,
      dimension: p.dimension,
    };
    const logged: LoggedFields = {};
    const s = this.src.sessions;
    if (s && firstJoined >= s.coverageStart) {
      const sessions = s.byUuid.get(p.uuid) ?? [];
      logged.sessions = sessions.length;
      const first = sessions.at(0);
      if (first?.end) logged.firstSessionMs = first.end - first.start;
    }
    const a = this.src.activity;
    if (a && p.name && firstJoined >= a.coverageStart) {
      const act = a.byName.get(p.name.toLowerCase());
      // A minute of slack: the proxy logs the hub connection just before Paper records the first join
      logged.reachedServer = act?.servers.some(([t, server]) => t >= firstJoined - 60_000 && server !== HUB_SERVER) ?? false;
      if (this.generatedAt - firstJoined >= RETURN_WINDOW_MS) {
        const firstDay = startOfDay(firstJoined);
        logged.returned7d = act?.connects.some((t) => startOfDay(t) > firstDay && t < firstJoined + RETURN_WINDOW_MS) ?? false;
      }
    }
    Object.assign(fp, logged);
    if (Object.keys(logged).length > 0) this.fromLogs.set(p.uuid, { firstJoined, logged });

    // Joined before the oldest log still kept: what the logs said while they covered the player
    const kept = this.src.history?.get(p.uuid);
    if (kept) {
      fp.sessions ??= kept.sessions;
      fp.firstSessionMs ??= kept.firstSessionMs;
      fp.reachedServer ??= kept.reachedServer;
      fp.returned7d ??= kept.returned7d;
    }
    this.applyJourney(fp, kept);
    return fp;
  }

  /**
   * The intro from the flow log for players it covers (joined since its
   * first start), else from the history once their part of the log is gone.
   * The finished list and the position stay for everyone before.
   */
  private applyJourney(fp: FlowPlayer, kept: HistoryEntry | undefined): void {
    const start = this.src.flowLog?.coverageStart ?? null;
    const journey = start !== null && fp.firstJoined >= start ? this.src.flowLog!.journeys.get(fp.uuid) : undefined;
    if (journey) {
      const outcome = journeyOutcome(journey);
      const pack = journeyPack(journey);
      const c = journeyClient(journey);
      const client = c && clientName(c);
      const disagreements = this.disagreements(fp, outcome, pack, client);
      fp.outcome = outcome;
      fp.outcomeFrom = 'log';
      if (pack) fp.introPack = pack;
      if (client) fp.clientVersion = client;
      fp.journey = journey;
      if (disagreements.length > 0) fp.disagreements = disagreements;
      this.fromJourneys.set(fp.uuid, { firstJoined: fp.firstJoined, summary: summarizeJourney(journey) });
    } else if (kept?.journey) {
      const s = kept.journey;
      // Frozen 8 days after the first join: the list knows who finished later
      fp.outcome = this.src.intro?.finished.has(fp.uuid) ? 'finished' : s.outcome;
      fp.outcomeFrom = 'history';
      if (s.pack) fp.introPack = s.pack;
      const client = clientName(s);
      if (client) fp.clientVersion = client;
    }
  }

  /** Where the journey and what the older sources say (still in fp) disagree */
  private disagreements(fp: FlowPlayer, outcome: IntroStatus, pack: PackResult | undefined, client: string | undefined): JourneyDisagreement[] {
    const out: JourneyDisagreement[] = [];
    if (this.src.intro) {
      const listed = this.src.intro.finished.has(fp.uuid);
      if (outcome === 'finished' && !listed) out.push('finish-not-listed');
      else if (outcome !== 'finished' && listed) out.push('listed-not-finished');
      else if (outcome !== fp.outcome) out.push('room');
    }
    if (client && fp.clientVersion && client !== fp.clientVersion) out.push('client');
    if (pack && fp.pack && pack !== fp.pack.result) out.push('pack');
    return out;
  }

  /** Keep what the current logs say, so it outlives them */
  recordHistory(history: FlowHistory): void {
    for (const [uuid, { firstJoined, logged }] of this.fromLogs) history.record(uuid, firstJoined, logged, this.generatedAt);
    for (const [uuid, { firstJoined, summary }] of this.fromJourneys) history.recordJourney(uuid, firstJoined, summary, this.generatedAt);
  }

  /** How the journeys compare with the older inference, for these players */
  private journeyCheck(players: FlowPlayer[]): JourneyCheck | null {
    const log = this.src.flowLog;
    if (!log) return null;
    const c: JourneyCheck = {
      coverageStart: log.coverageStart, badLines: log.badLines,
      covered: 0, withJourney: 0, fromHistory: 0,
      disagreements: 0, finishNotListed: 0, listedNotFinished: 0, roomDiffers: 0, clientDiffers: 0, packDiffers: 0,
    };
    const field: Record<JourneyDisagreement, 'finishNotListed' | 'listedNotFinished' | 'roomDiffers' | 'clientDiffers' | 'packDiffers'> = {
      'finish-not-listed': 'finishNotListed', 'listed-not-finished': 'listedNotFinished', room: 'roomDiffers', client: 'clientDiffers', pack: 'packDiffers',
    };
    for (const p of players) {
      if (log.coverageStart !== null && p.firstJoined >= log.coverageStart) c.covered++;
      if (p.outcomeFrom === 'log') c.withJourney++;
      else if (p.outcomeFrom === 'history') c.fromHistory++;
      for (const d of p.disagreements ?? []) c[field[d]]++;
      if (p.disagreements?.some((d) => OUTCOME_DISAGREEMENTS.has(d))) c.disagreements++;
    }
    return c;
  }

  /** The earliest first join for which a log-derived field is known, from the logs or the history */
  private knownFrom(coverageStart: number | undefined, field: keyof LoggedFields | 'journey'): number | null {
    const kept = this.src.history?.earliest(field) ?? null;
    if (coverageStart === undefined) return kept;
    return kept === null ? coverageStart : Math.min(coverageStart, kept);
  }

  private clientVersion(uuid: string): string | undefined {
    const protocol = this.src.clients?.get(uuid);
    return protocol === undefined ? undefined : clientVersionName(protocol);
  }

  private inRange(from: number, to: number): FlowPlayer[] {
    return this.flowPlayers.filter((p) => p.firstJoined >= from && p.firstJoined < to);
  }

  private counts(players: FlowPlayer[]): FlowCounts {
    const c = emptyCounts();
    for (const p of players) add(c, p);
    return c;
  }

  query(from: number, to: number): FlowResponse {
    from = Math.max(from, DEFAULT_HUB_DATE);
    const players = this.inRange(from, to);
    const bucket = to - from <= DAILY_MAX_MS ? 'day' : 'week';
    const bucketStart = bucket === 'day' ? startOfDay : startOfWeek;

    const series: FlowBucket[] = [];
    for (let t = bucketStart(from); t < to; t = nextBucket(t, bucket)) series.push({ start: t, ...emptyCounts() });
    const byStart = new Map(series.map((b) => [b.start, b]));
    for (const p of players) {
      const b = byStart.get(bucketStart(p.firstJoined));
      if (b) add(b, p);
    }

    const prevFrom = from - (to - from);
    const previous = from > DEFAULT_HUB_DATE ? { from: Math.max(prevFrom, DEFAULT_HUB_DATE), to: from } : null;

    const byResult = new Map<string, PackResultGroup>();
    const byPack = new Map<string, PackGroup>();
    const byClient = new Map<string, ClientGroup>();
    for (const p of players) {
      if (this.src.clients || this.src.flowLog) {
        const version = p.clientVersion ?? 'Unknown';
        let cg = byClient.get(version);
        if (!cg) byClient.set(version, (cg = { version, matchesServer: version === this.src.serverVersion, ...emptyCounts() }));
        add(cg, p);
      }
      const result = p.introPack ?? 'unknown';
      let r = byResult.get(result);
      if (!r) byResult.set(result, (r = { result, ...emptyCounts() }));
      add(r, p);
      if (p.pack?.pack) {
        const key = `${p.pack.pack}\0${p.pack.version}\0${p.pack.variant}`;
        let g = byPack.get(key);
        if (!g) byPack.set(key, (g = { pack: p.pack.pack, version: p.pack.version, variant: p.pack.variant, ...emptyCounts() }));
        // The release's own result: the intro's may belong to another pack
        add(g, p, p.pack.result);
      }
    }

    const sessions: SessionStats[] = OUTCOMES.map((outcome) => {
      const group = players.filter((p) => p.outcome === outcome && p.sessions !== undefined);
      return {
        outcome,
        players: group.length,
        medianSessions: median(group.map((p) => p.sessions!)),
        multiSession: group.filter((p) => p.sessions! >= 2).length,
        medianFirstSessionMs: median(group.flatMap((p) => (p.firstSessionMs !== undefined ? [p.firstSessionMs] : []))),
      };
    });

    const fromDate = new Date(from), toDate = new Date(to);
    const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const signalTo = this.generatedAt;
    const signalFrom = signalTo - SIGNAL_WINDOW_MS;

    return {
      generatedAt: this.generatedAt,
      sources: {
        intro: this.src.intro !== null,
        packs: this.src.packs !== null,
        clients: this.src.clients !== null,
        sessionsFrom: this.knownFrom(this.src.sessions?.coverageStart, 'sessions'),
        activityFrom: this.knownFrom(this.src.activity?.coverageStart, 'reachedServer'),
        flowLog: this.src.flowLog !== null,
        flowLogFrom: this.knownFrom(this.src.flowLog?.coverageStart ?? undefined, 'journey'),
      },
      journeys: this.journeyCheck(players),
      serverVersion: this.src.serverVersion,
      range: { from, to, bucket },
      previous,
      totals: this.counts(players),
      previousTotals: previous ? this.counts(this.inRange(previous.from, previous.to)) : null,
      series,
      byPackResult: [...byResult.values()].sort((a, b) => b.players - a.players),
      byClient: [...byClient.values()].sort((a, b) => b.players - a.players),
      byPack: [...byPack.values()].sort((a, b) => b.players - a.players),
      sessions,
      events: this.src.events.filter((e) => e.date >= isoDay(fromDate) && e.date <= isoDay(toDate)),
      signals: this.signals(),
      signalWindow: { from: signalFrom, to: signalTo, baselineFrom: signalFrom - SIGNAL_BASELINE_MS },
      packHealth: this.packHealthRows,
      releaseCheck: this.fastCheck,
      eventImpacts: this.eventImpacts(),
    };
  }

  /** Each marker's 7 days before against the 7 days after, newest first */
  private eventImpacts(): EventImpact[] {
    return this.src.events.map((e) => {
      const [y, m, d] = e.date.split('-').map(Number);
      const at = new Date(y, m - 1, d).getTime();
      const beforeFrom = Math.max(at - EVENT_WINDOW_MS, DEFAULT_HUB_DATE);
      const afterTo = Math.max(at, Math.min(at + EVENT_WINDOW_MS, this.generatedAt));
      const opened = at > DEFAULT_HUB_DATE;
      return {
        date: e.date,
        label: e.label,
        before: opened ? this.counts(this.inRange(beforeFrom, at)) : null,
        after: this.counts(this.inRange(at, afterTo)),
        beforeDays: opened ? (at - beforeFrom) / DAY : 0,
        afterDays: (afterTo - at) / DAY,
      };
    }).reverse();
  }

  /**
   * Where players gave up after the intro: new players since `cutoff` who
   * finished it but never reached another server, at their last hub position.
   * Null without proxy logs, which say who moved on.
   */
  gaveUpPositions(dimension: string, cutoff: number): { x: number; z: number }[] | null {
    if (!this.src.activity) return null;
    return this.flowPlayers
      .filter((p) => p.firstJoined >= cutoff && p.dimension === dimension && p.outcome === 'finished' && p.reachedServer === false)
      .map((p) => ({ x: p.x, z: p.z }));
  }

  /** The current signals alone: what an alert watcher needs */
  signalsReport(): FlowSignalsResponse {
    const from = this.generatedAt - SIGNAL_WINDOW_MS;
    const { intro, packs, clients, sessions, activity } = this.src;
    return {
      generatedAt: this.generatedAt,
      window: { from, to: this.generatedAt, baselineFrom: from - SIGNAL_BASELINE_MS },
      complete: [intro, packs, clients, sessions, activity].every((source) => source !== null),
      signals: this.signals(),
    };
  }

  playersPage(from: number, to: number, outcome: IntroStatus | undefined, limit: number, offset: number) {
    const all = this.inRange(Math.max(from, DEFAULT_HUB_DATE), to).filter((p) => !outcome || p.outcome === outcome);
    return { total: all.length, players: all.slice(offset, offset + limit) };
  }

  private buildPackHealth(): PackHealthRow[] {
    if (!this.src.packs) return [];
    const recent = new Set(
      this.inRange(this.generatedAt - SIGNAL_WINDOW_MS, Infinity)
        .flatMap((p) => (p.pack?.pack ? [`${p.pack.pack}\0${p.pack.version}\0${p.pack.variant}`] : [])),
    );
    const rows = new Map<string, PackHealthRow>();
    for (const info of this.src.packs.values()) {
      if (!info.pack || !info.version) continue;
      const key = `${info.pack}\0${info.version}\0${info.variant}`;
      let r = rows.get(key);
      if (!r) {
        rows.set(key, (r = {
          pack: info.pack, version: info.version, variant: info.variant,
          players: 0, loaded: 0, failed: 0, declined: 0, current: recent.has(key),
          firstSeen: this.src.releases?.firstSeen(info) ?? null,
        }));
      }
      r.players++;
      if (info.result === 'loaded') r.loaded++;
      else if (isFailure(info.result)) r.failed++;
      else if (info.result === 'declined') r.declined++;
    }
    return [...rows.values()]
      .filter((r) => r.players >= 8)
      .sort((a, b) => a.pack.localeCompare(b.pack) || compareVersions(b.version, a.version) || a.variant.localeCompare(b.variant));
  }

  private versionOf(uuid: string): string {
    return this.clientVersion(uuid) ?? 'Unknown';
  }

  /** New players' pack results over the last day, and every player's results for releases that just appeared */
  private buildReleaseCheck(): ReleaseCheck {
    const serverVersion = this.src.serverVersion;
    const sortVersions = (a: VersionPackResults, b: VersionPackResults) => b.players - a.players;

    const from = this.generatedAt - FAST_WINDOW_MS;
    const recent = this.inRange(from, this.generatedAt + 1);
    const groups = new Map<string, VersionPackResults & { releaseCounts: Map<string, number> }>();
    for (const p of recent) {
      const version = p.clientVersion ?? 'Unknown';
      let g = groups.get(version);
      if (!g) groups.set(version, (g = { ...emptyVersion(version, version === serverVersion), finished: 0, releaseCounts: new Map() }));
      addResult(g, p.introPack);
      if (p.outcome === 'finished') g.finished!++;
      if (p.pack?.pack) {
        const name = releaseName(p.pack);
        g.releaseCounts.set(name, (g.releaseCounts.get(name) ?? 0) + 1);
      }
    }
    const last24h = [...groups.values()].map(({ releaseCounts, ...g }) => ({
      ...g,
      releases: [...releaseCounts].sort((a, b) => b[1] - a[1]).map(([name]) => name),
    })).sort(sortVersions);

    const newReleases: NewRelease[] = [];
    const log = this.src.releases;
    if (log && this.src.packs) {
      const byKey = new Map<string, NewRelease & { versions: Map<string, VersionPackResults> }>();
      for (const [uuid, info] of this.src.packs) {
        if (!info.pack || !info.version) continue;
        const seen = log.firstSeen(info);
        if (seen === null || seen === undefined || this.generatedAt - seen > NEW_RELEASE_MS) continue;
        const key = releaseKey(info);
        let r = byKey.get(key);
        if (!r) {
          byKey.set(key, (r = {
            pack: info.pack, version: info.version, variant: info.variant, firstSeen: seen,
            players: 0, loaded: 0, failed: 0, declined: 0, byClient: [], versions: new Map(),
          }));
        }
        addResult(r, info.result);
        const version = this.versionOf(uuid);
        let v = r.versions.get(version);
        if (!v) r.versions.set(version, (v = emptyVersion(version, version === serverVersion)));
        addResult(v, info.result);
      }
      for (const { versions, ...r } of byKey.values()) newReleases.push({ ...r, byClient: [...versions.values()].sort(sortVersions) });
      newReleases.sort((a, b) => b.firstSeen - a.firstSeen);
    }

    return {
      trackingSince: log?.since ?? null,
      last24h: { from, to: this.generatedAt, players: recent.length, byClient: last24h },
      newReleases,
    };
  }

  /** The fast check's signals: game versions whose pack fails today, and how new releases do */
  private fastSignals(): FlowSignal[] {
    const out: FlowSignal[] = [];
    const { last24h, newReleases } = this.fastCheck;
    const serverVersion = this.src.serverVersion;
    const own = last24h.byClient.find((v) => v.version === serverVersion);

    if (this.src.packs) {
      for (const v of last24h.byClient.filter(failing)) {
        const compare = own && v !== own && tried(own) > 0
          ? ` On ${serverVersion}, the server's version, it failed for ${own.failed.toLocaleString('en-US')} of ${tried(own).toLocaleString('en-US')}.`
          : '';
        out.push({
          id: signalId('pack-24h', v.version),
          level: 'critical',
          title: `Resource pack failed to load for ${v.failed.toLocaleString('en-US')} of ${tried(v).toLocaleString('en-US')} new ${v.version} players in the last 24 hours`,
          detail: `Counting new players who accepted the pack and reported a result.${v.releases?.length ? ` They got ${v.releases.slice(0, 3).join(', ')}.` : ''}${compare}`,
        });
      }
    }

    const everyPlayer = 'every player whose latest pack it is, not only new players';
    // Notes on releases that are not failing: one per pack version, its variants together
    const notes = new Map<string, { pack: string; version: string; firstSeen: number; variants: string[]; versions: Map<string, VersionPackResults> }>();
    for (const r of newReleases) {
      const bad = r.byClient.filter(failing);
      if (bad.length > 0) {
        out.push({
          id: signalId('release', r.pack, r.variant, r.version),
          level: 'critical',
          title: `New pack release ${releaseName(r)} fails to load for ${bad.map((v) => v.version).join(' and ')} players`,
          detail: `First seen ${WHEN.format(r.firstSeen)}; ${everyPlayer}: ${versionSummary(r.byClient, 'failed')}.`,
        });
        continue;
      }
      if (this.generatedAt - r.firstSeen > RELEASE_NOTE_MS || tried(r) === 0) continue;
      const key = `${r.pack}\0${r.version}`;
      let note = notes.get(key);
      if (!note) notes.set(key, (note = { pack: r.pack, version: r.version, firstSeen: r.firstSeen, variants: [], versions: new Map() }));
      note.firstSeen = Math.min(note.firstSeen, r.firstSeen);
      note.variants.push(r.variant);
      for (const v of r.byClient) {
        let sum = note.versions.get(v.version);
        if (!sum) note.versions.set(v.version, (sum = emptyVersion(v.version, v.matchesServer)));
        sum.players += v.players;
        sum.loaded += v.loaded;
        sum.failed += v.failed;
        sum.declined += v.declined;
      }
    }
    for (const n of notes.values()) {
      const byClient = [...n.versions.values()].sort((a, b) => b.players - a.players);
      const total = byClient.reduce((t, v) => t + tried(v), 0);
      const settled = total >= 10 && byClient.every((v) => tried(v) < 5 || v.failed / tried(v) < 0.25);
      const name = `${n.pack} ${n.version}`;
      out.push({
        id: signalId('release-new', n.pack, n.version),
        level: settled ? 'good' : 'info',
        title: settled ? `New pack release ${name} loads` : `New pack release ${name}: first results`,
        detail: `First seen ${WHEN.format(n.firstSeen)}, ${n.variants.length === 1 ? 'variant' : 'variants'} ${n.variants.sort().join(', ')}; ${everyPlayer}: ${versionSummary(byClient, 'loaded')}.`,
      });
    }
    return out;
  }

  /** What changed in the last 14 days against the 8 weeks before */
  private signals(): FlowSignal[] {
    const to = this.generatedAt;
    const from = to - SIGNAL_WINDOW_MS;
    const recentPlayers = this.inRange(from, to + 1);
    const recent = this.counts(recentPlayers);
    const base = this.counts(this.inRange(Math.max(from - SIGNAL_BASELINE_MS, DEFAULT_HUB_DATE), from));
    const out: FlowSignal[] = this.fastSignals();
    const order = { critical: 0, warning: 1, info: 2, good: 3 };

    if (recent.players < SIGNAL_MIN_PLAYERS || base.players < SIGNAL_MIN_PLAYERS) {
      out.push({
        id: 'not-enough-data',
        level: 'info',
        title: 'Not enough new players to judge',
        detail: `${plural(recent.players, 'new player')} in the last 14 days and ${base.players.toLocaleString('en-US')} in the 8 weeks before; signals need at least ${SIGNAL_MIN_PLAYERS} in each.`,
      });
      return out.sort((a, b) => order[a.level] - order[b.level]);
    }

    const rate = (c: FlowCounts, k: keyof FlowCounts) => c[k] / c.players;
    /** Signed change in percentage points, recent minus baseline */
    const change = (k: keyof FlowCounts) => (rate(recent, k) - rate(base, k)) * 100;
    const level = (pts: number, warn: number, crit: number): FlowSignal['level'] | null =>
      pts >= crit ? 'critical' : pts >= warn ? 'warning' : null;

    // Intro completion
    const completionDrop = -change('finished');
    const completionLevel = level(completionDrop, 10, 25);
    if (completionLevel) {
      const notFinished = recentPlayers.filter((p) => p.outcome !== 'finished');
      const failedPack = notFinished.filter((p) => p.introPack && isFailure(p.introPack)).length;
      const why = failedPack >= notFinished.length * 0.4
        ? ` ${plural(failedPack, 'player')} of the ${notFinished.length.toLocaleString('en-US')} who did not finish had a resource pack that failed to load.`
        : '';
      out.push({
        id: 'completion',
        level: completionLevel,
        title: `Intro completion dropped to ${pct(recent.finished, recent.players)}%`,
        detail: `${recent.finished.toLocaleString('en-US')} of ${plural(recent.players, 'new player')} finished in the last 14 days, against ${pct(base.finished, base.players)}% in the 8 weeks before.${why}`,
      });
    }

    const stuck = (k: 'welcome' | 'compatibility', where: string, warn: number, crit: number) => {
      const lvl = level(change(k), warn, crit);
      if (lvl) {
        out.push({
          id: `stuck-${k}`,
          level: lvl,
          title: `${pct(recent[k], recent.players)}% of new players stop at the ${where}`,
          detail: `${recent[k].toLocaleString('en-US')} of ${recent.players.toLocaleString('en-US')} in the last 14 days, against ${pct(base[k], base.players)}% in the 8 weeks before.${k === 'welcome' ? ' The intro only shows players how to move on once their resource pack has loaded.' : ''}`,
        });
      }
    };
    stuck('welcome', 'welcome screen', 10, 25);
    stuck('compatibility', 'compatibility check', 5, 15);

    // Resource pack results of new players
    if (recent.packKnown >= SIGNAL_MIN_PLAYERS && base.packKnown >= SIGNAL_MIN_PLAYERS) {
      const failRecent = recent.packFailed / recent.packKnown, failBase = base.packFailed / base.packKnown;
      const failLevel = level((failRecent - failBase) * 100, 10, 25);
      if (failLevel) {
        out.push({
          id: 'pack-failed',
          level: failLevel,
          title: `Resource pack failed to load for ${Math.round(failRecent * 100)}% of new players`,
          detail: `${recent.packFailed.toLocaleString('en-US')} of ${recent.packKnown.toLocaleString('en-US')} in the last 14 days, against ${Math.round(failBase * 100)}% in the 8 weeks before.`,
        });
      }
      const declRecent = recent.packDeclined / recent.packKnown, declBase = base.packDeclined / base.packKnown;
      const declLevel = level((declRecent - declBase) * 100, 10, 25);
      if (declLevel) {
        out.push({
          id: 'pack-declined',
          level: declLevel,
          title: `${Math.round(declRecent * 100)}% of new players declined the resource pack`,
          detail: `${recent.packDeclined.toLocaleString('en-US')} of ${recent.packKnown.toLocaleString('en-US')} in the last 14 days, against ${Math.round(declBase * 100)}% in the 8 weeks before.`,
        });
      }
    }

    // Client versions other than the server's that do much worse in the intro
    if (this.src.clients) {
      const byVersion = new Map<string, FlowPlayer[]>();
      for (const p of recentPlayers) {
        if (!p.clientVersion) continue;
        let list = byVersion.get(p.clientVersion);
        if (!list) byVersion.set(p.clientVersion, (list = []));
        list.push(p);
      }
      const finishedShare = (ps: FlowPlayer[]) => ps.filter((p) => p.outcome === 'finished').length / ps.length;
      const own = byVersion.get(this.src.serverVersion) ?? [];
      const ref = own.length >= 10 ? finishedShare(own) : base.finished / base.players;
      const refText = own.length >= 10
        ? `Players on ${this.src.serverVersion}, the server's version, finished ${Math.round(ref * 100)}%.`
        : `New players in the 8 weeks before finished ${Math.round(ref * 100)}%.`;
      for (const [version, ps] of [...byVersion].sort((a, b) => b[1].length - a[1].length)) {
        if (version === this.src.serverVersion || ps.length < SIGNAL_MIN_PLAYERS) continue;
        const share = ps.length / recent.players;
        const rate = finishedShare(ps);
        if (share < 0.1 || (ref - rate) * 100 < 25) continue;
        const known = ps.filter((p) => p.introPack).length;
        const failed = ps.filter((p) => p.introPack && isFailure(p.introPack)).length;
        out.push({
          id: `client-version:${version}`,
          level: share >= 0.25 ? 'critical' : 'warning',
          title: `${Math.round(share * 100)}% of new players join on ${version}, and ${Math.round(rate * 100)}% of them finish the intro`,
          detail: `${ps.length.toLocaleString('en-US')} of ${plural(recent.players, 'new player')} in the last 14 days used ${version}. ${refText}`
            + (known > 0 && failed / known >= 0.5 ? ` The resource pack failed to load for ${failed.toLocaleString('en-US')} of their ${known.toLocaleString('en-US')}.` : ''),
        });
      }
    }

    // Releases new players got in the window that failed for many of them. Only
    // new players of the window count: all-time records keep the failures of
    // players who never came back, so a fixed release would stay flagged
    const releases = new Map<string, { variant: string; version: string; players: number; failed: number }>();
    for (const p of recentPlayers) {
      if (!p.pack?.pack) continue;
      const key = releaseKey(p.pack);
      let r = releases.get(key);
      if (!r) releases.set(key, (r = { variant: p.pack.variant, version: p.pack.version, players: 0, failed: 0 }));
      r.players++;
      if (isFailure(p.pack.result)) r.failed++;
    }
    const failingReleases = [...releases.values()]
      .filter((r) => r.players >= PACK_MIN_PLAYERS && r.failed / r.players >= PACK_FAIL_RATE)
      .sort((a, b) => b.failed / b.players - a.failed / a.players);
    if (failingReleases.length > 0) {
      const rates = failingReleases.map((r) => `${releaseName(r)}: ${r.failed.toLocaleString('en-US')} of ${r.players.toLocaleString('en-US')} (${pct(r.failed, r.players)}%)`);
      out.push({
        id: 'pack-releases',
        level: 'critical',
        title: failingReleases.length === 1
          ? `${releaseName(failingReleases[0])} fails to load for ${pct(failingReleases[0].failed, failingReleases[0].players)}% of new players`
          : `${failingReleases.length} pack releases fail to load for many new players`,
        detail: `New players in the last 14 days who got the release and reported a failed load: ${rates.join('; ')}.`,
      });
    }

    // Left both rooms without being recorded as finished
    if (recent.other >= 5 && recent.other / recent.players >= 0.03) {
      out.push({
        id: 'not-recorded',
        level: 'warning',
        title: `${plural(recent.other, 'new player')} left the intro rooms without being recorded as finished`,
        detail: 'They are not on finishedPlayerList.uid and their last position is outside both rooms. Check whether the intro chain still records finishers.',
      });
    }

    // Finished by the flow log, which records the finish before the list is written
    const logFinishers = recentPlayers.filter((p) => p.outcomeFrom === 'log' && p.outcome === 'finished');
    const unlisted = logFinishers.filter((p) => p.disagreements?.includes('finish-not-listed')).length;
    if (unlisted >= 5 && unlisted / logFinishers.length >= 0.03) {
      out.push({
        id: 'finish-not-listed',
        level: 'warning',
        title: `${plural(unlisted, 'new player')} finished the intro but are not on the finished list`,
        detail: `${unlisted.toLocaleString('en-US')} of the ${logFinishers.length.toLocaleString('en-US')} who finished in the last 14 days by the flow log are not on finishedPlayerList.uid, so they would get the intro again. Check whether the intro chain still records finishers.`,
      });
    }

    // After the intro: moving on to another server
    const finishedRecent = recentPlayers.filter((p) => p.outcome === 'finished' && p.reachedServer !== undefined);
    const finishedBase = this.inRange(Math.max(from - SIGNAL_BASELINE_MS, DEFAULT_HUB_DATE), from)
      .filter((p) => p.outcome === 'finished' && p.reachedServer !== undefined);
    if (finishedRecent.length >= SIGNAL_MIN_PLAYERS && finishedBase.length >= SIGNAL_MIN_PLAYERS) {
      const moved = (ps: FlowPlayer[]) => ps.filter((p) => p.reachedServer).length;
      const rRate = moved(finishedRecent) / finishedRecent.length, bRate = moved(finishedBase) / finishedBase.length;
      const lvl = level((bRate - rRate) * 100, 10, 25);
      if (lvl) {
        out.push({
          id: 'not-moved-on',
          level: lvl,
          title: `Only ${Math.round(rRate * 100)}% of players who finished the intro reached another server`,
          detail: `${moved(finishedRecent).toLocaleString('en-US')} of ${finishedRecent.length.toLocaleString('en-US')} in the last 14 days, against ${Math.round(bRate * 100)}% in the 8 weeks before.`,
        });
      }
    }

    // Coming back: players need 7 days to have had the chance, so this compares older cohorts
    const cohort = (a: number, b: number) => this.inRange(a, b).filter((p) => p.returned7d !== undefined);
    const backRecent = cohort(to - SIGNAL_WINDOW_MS - RETURN_WINDOW_MS, to - RETURN_WINDOW_MS);
    const backBase = cohort(Math.max(to - SIGNAL_WINDOW_MS - RETURN_WINDOW_MS - SIGNAL_BASELINE_MS, DEFAULT_HUB_DATE), to - SIGNAL_WINDOW_MS - RETURN_WINDOW_MS);
    if (backRecent.length >= SIGNAL_MIN_PLAYERS && backBase.length >= SIGNAL_MIN_PLAYERS) {
      const back = (ps: FlowPlayer[]) => ps.filter((p) => p.returned7d).length;
      const rRate = back(backRecent) / backRecent.length, bRate = back(backBase) / backBase.length;
      const lvl = level((bRate - rRate) * 100, 10, 25);
      if (lvl) {
        out.push({
          id: 'returns',
          level: lvl,
          title: `${Math.round(rRate * 100)}% of new players came back within a week`,
          detail: `${back(backRecent).toLocaleString('en-US')} of ${backRecent.length.toLocaleString('en-US')} who first joined 7 to 21 days ago, against ${Math.round(bRate * 100)}% for the 8 weeks before them.`,
        });
      }
    }

    // Arrivals per day
    const perDay = (c: FlowCounts, ms: number) => c.players / (ms / DAY);
    const baseMs = from - Math.max(from - SIGNAL_BASELINE_MS, DEFAULT_HUB_DATE);
    const volumeChange = perDay(recent, SIGNAL_WINDOW_MS) / perDay(base, baseMs) - 1;
    if (volumeChange <= -0.4) {
      out.push({
        id: 'volume',
        level: 'warning',
        title: `New players down ${Math.round(-volumeChange * 100)}%`,
        detail: `${perDay(recent, SIGNAL_WINDOW_MS).toFixed(0)} a day in the last 14 days, against ${perDay(base, baseMs).toFixed(0)} a day in the 8 weeks before.`,
      });
    }

    // How often stuck players retried
    const stuckSessions = recentPlayers.filter((p) => p.outcome !== 'finished' && p.sessions !== undefined).map((p) => p.sessions!);
    const retried = stuckSessions.filter((n) => n >= 2).length;
    if (stuckSessions.length >= 10 && retried / stuckSessions.length >= 0.3) {
      out.push({
        id: 'retries',
        level: 'info',
        title: `${pct(retried, stuckSessions.length)}% of players who did not finish tried again`,
        detail: `${retried.toLocaleString('en-US')} of ${stuckSessions.length.toLocaleString('en-US')} joined the hub two or more times before giving up (median ${median(stuckSessions)} sessions).`,
      });
    }

    if (!out.some((s) => s.level === 'critical' || s.level === 'warning')) {
      out.unshift({
        id: 'normal',
        level: 'good',
        title: 'Intro flow looks normal',
        detail: `${pct(recent.finished, recent.players)}% of ${plural(recent.players, 'new player')} finished the intro in the last 14 days, against ${pct(base.finished, base.players)}% in the 8 weeks before.`,
      });
    }

    return out.sort((a, b) => order[a.level] - order[b.level]);
  }
}
