export interface PlayerRecord {
  uuid: string;
  name?: string;
  x: number;
  z: number;
  y: number;
  dimension: string;
  /** mtime of the player file; also the key for incremental re-indexing */
  lastModified: number;
  /** Bukkit firstPlayed (epoch ms) */
  firstJoined?: number;
  /** Bukkit lastPlayed, else Paper LastSeen (epoch ms) */
  lastOnline?: number;
}

/**
 * Hub intro progress (MCME-Introduction): finished, or the room the player
 * gave up in ('welcome' screen or 'compatibility' check). 'other' = neither.
 */
export type IntroStatus = 'finished' | 'welcome' | 'compatibility' | 'other';

/**
 * When the player was last online. File mtimes are unreliable on their own:
 * bulk copies give hundreds of thousands of files the same mtime.
 */
export function lastSeen(p: PlayerRecord): number {
  return p.lastOnline ?? p.lastModified;
}

export interface WorldInfo {
  name: string;
  mcVersion: string;
  dimensions: string[];
  playerCount: number;
  bounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  spawn?: { x: number; z: number };
  /** Per-dimension heatmap density info for the legend */
  heatmapDensity?: Record<string, HeatmapRenderResponse>;
  /** Bounds that encompass all player positions (may extend beyond region bounds) */
  playerBounds?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
}

export interface PlayersResponse {
  players: PlayerRecord[];
  total: number;
}

export interface SearchResponse {
  results: PlayerRecord[];
}

export interface HeatmapRenderRequest {
  dimension: string;
  afterDate?: number;
  beforeDate?: number;
  /** Viewport bounds — when provided, heatmap is normalized to this area only */
  viewport?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  /** Custom render bounds — when provided, the heatmap PNG covers only this area */
  renderBounds?: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
}

export interface HeatmapRenderResponse {
  url: string;
  contoursUrl: string;
  maxPerChunk: number;
  totalPlayers: number;
}

export interface ContourData {
  levels: {
    value: number;
    lines: number[][][];
  }[];
}

/** Server-side clustering types */

export interface ClusterItem {
  type: 'cluster';
  x: number;
  z: number;
  count: number;
  /** Up to 5 sample player names for the popup */
  names: string[];
}

export interface PlayerItem {
  type: 'player';
  uuid: string;
  name?: string;
  x: number;
  z: number;
  y: number;
  firstJoined?: number;
  lastOnline?: number;
  /** Absent when the intro plugin's files were not found */
  introStatus?: IntroStatus;
}

export interface ClustersResponse {
  /** Total individual players in viewport (before clustering) */
  totalInView: number;
  items: (ClusterItem | PlayerItem)[];
}

/** Default number of days to show players for */
export const DEFAULT_PLAYER_DAYS = 30;

export interface DropoutHeatmapRequest extends HeatmapRenderRequest {
  cutoffDate?: number;
}

export const DEFAULT_HUB_DATE = new Date('2026-02-16').getTime();
export const PLAYER_CACHE_VERSION = 4;

/* ---- Hub player flow ---- */

/** Last resource pack result MCME-Architect recorded for a player */
export type PackResult = 'loaded' | 'failed_reload' | 'failed_download' | 'declined' | 'no_result' | 'not_sent';

export interface PackInfo {
  /** Pack name from the release URL (e.g. Human); '' when no pack was sent */
  pack: string;
  version: string;
  /** Release file name, e.g. Human-Vanilla */
  variant: string;
  result: PackResult;
}

/** Counts for a group of new players */
export interface FlowCounts {
  players: number;
  finished: number;
  welcome: number;
  compatibility: number;
  other: number;
  /** Players the proxy logs cover (joined after the oldest proxy log) */
  activityKnown: number;
  /** ...of those, went on to a server other than the hub */
  reachedServer: number;
  /** ...of those, finished the intro first (the funnel's third step) */
  finishedMovedOn: number;
  /** ...of those, first joined at least 7 days before the data was read */
  returnEligible: number;
  /** ...of those, connected again on a later day within 7 days */
  returned7d: number;
  /** Players with a pack record, and how those ended */
  packKnown: number;
  packLoaded: number;
  packFailed: number;
  packDeclined: number;
}

export interface FlowBucket extends FlowCounts {
  /** Bucket start (local midnight, or Monday for weeks), epoch ms */
  start: number;
}

export interface FlowPlayer {
  uuid: string;
  name?: string;
  firstJoined: number;
  lastOnline?: number;
  outcome: IntroStatus;
  pack?: PackInfo;
  /** Hub sessions in the server logs; absent when the first join predates the oldest log */
  sessions?: number;
  firstSessionMs?: number;
  /** Went on to a server other than the hub; absent without proxy-log coverage */
  reachedServer?: boolean;
  /** Connected again on a later day within 7 days; absent when unknown or too recent */
  returned7d?: boolean;
  /** Game version of the client's latest join (from Plan); absent when unknown */
  clientVersion?: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
}

export type SignalLevel = 'critical' | 'warning' | 'info' | 'good';

export interface FlowSignal {
  /** Stable across refreshes while the same problem lasts, e.g. 'completion' or 'client-version:26.3' */
  id: string;
  level: SignalLevel;
  title: string;
  detail: string;
}

/** A dated change (update, pack release) drawn on the flow charts */
export interface FlowEvent {
  date: string;
  label: string;
}

export interface PackGroup extends FlowCounts {
  pack: string;
  version: string;
  variant: string;
}

export interface ClientGroup extends FlowCounts {
  /** ViaVersion's name for the client protocol, or 'Unknown' */
  version: string;
  /** The server's own version: intro room 2 only lets these through on its own */
  matchesServer: boolean;
}

export interface PackResultGroup extends FlowCounts {
  result: PackResult | 'unknown';
}

/** All players whose latest pack is this release, regardless of when they joined */
export interface PackHealthRow {
  pack: string;
  version: string;
  variant: string;
  players: number;
  loaded: number;
  failed: number;
  declined: number;
  /** Whether new players got this release in the last 14 days */
  current: boolean;
  /** When the tool first saw it; null when it was already there when tracking started */
  firstSeen: number | null;
}

/** Pack results of one game version within a group of players */
export interface VersionPackResults {
  /** ViaVersion's name for the client protocol, or 'Unknown' */
  version: string;
  matchesServer: boolean;
  players: number;
  loaded: number;
  failed: number;
  declined: number;
  /** New players only: how many finished the intro */
  finished?: number;
  /** New players only: the releases they got, most common first */
  releases?: string[];
}

/** A release the tool saw appear: every player whose latest pack it is, by game version */
export interface NewRelease {
  pack: string;
  version: string;
  variant: string;
  firstSeen: number;
  players: number;
  loaded: number;
  failed: number;
  declined: number;
  byClient: VersionPackResults[];
}

/** The fast check: the last 24 hours and the newest releases, whatever range is selected */
export interface ReleaseCheck {
  /** Since when new releases are noted; null before the first pack data */
  trackingSince: number | null;
  last24h: { from: number; to: number; players: number; byClient: VersionPackResults[] };
  /** Releases first seen in the last 7 days, newest first */
  newReleases: NewRelease[];
}

/** One marker's 7 days before against the 7 days after */
export interface EventImpact extends FlowEvent {
  /** Null when the hub had not opened yet */
  before: FlowCounts | null;
  after: FlowCounts;
  /** Days each side covers: the hub's opening cuts "before", today cuts "after" */
  beforeDays: number;
  afterDays: number;
}

export interface SessionStats {
  outcome: IntroStatus;
  /** New players in the range with log coverage */
  players: number;
  medianSessions: number | null;
  /** Players with two or more hub sessions */
  multiSession: number;
  medianFirstSessionMs: number | null;
}

export interface FlowResponse {
  generatedAt: number;
  sources: { intro: boolean; packs: boolean; clients: boolean; sessionsFrom: number | null; activityFrom: number | null };
  /** The hub's Minecraft version */
  serverVersion: string;
  range: { from: number; to: number; bucket: 'day' | 'week' };
  previous: { from: number; to: number } | null;
  totals: FlowCounts;
  previousTotals: FlowCounts | null;
  series: FlowBucket[];
  byPackResult: PackResultGroup[];
  byClient: ClientGroup[];
  byPack: PackGroup[];
  sessions: SessionStats[];
  events: FlowEvent[];
  signals: FlowSignal[];
  /** The fixed window the signals compare: [from, to] against [baselineFrom, from) */
  signalWindow: { from: number; to: number; baselineFrom: number };
  packHealth: PackHealthRow[];
  releaseCheck: ReleaseCheck;
  /** Every marker, not only those in the range */
  eventImpacts: EventImpact[];
}

/** The current signals alone, for watchers such as the admin dashboard */
export interface FlowSignalsResponse {
  generatedAt: number;
  window: { from: number; to: number; baselineFrom: number };
  /** Every data source loaded: a signal missing now really means the problem is gone */
  complete: boolean;
  signals: FlowSignal[];
}

export interface FlowPlayersResponse {
  total: number;
  players: FlowPlayer[];
}

/* ---- MCME-Introduction's flow log (1.4.0+) ---- */

/** The client fields of an `enter` or `skip`; any of them can be missing */
export interface JourneyClient {
  /** ViaVersion's name for the protocol, e.g. 26.2 or 26.1-26.1.2 */
  version?: string;
  protocol?: number;
  /** The brand the client reported, e.g. vanilla or fabric; null when it sent none */
  brand?: string | null;
  /** MCME-Architect saw MCME's marker mod */
  marker?: boolean;
  /** The version is one the compatibility room lets through */
  supported?: boolean;
}

/** One stay in an intro room, from its `enter` to its `exit` */
export interface JourneyVisit {
  /** welcome or compatibility; absent if the log did not say */
  room?: string;
  /** When the player was put in the room */
  at: number;
  client: JourneyClient;
  /** The compatibility room's warning screen: version, modded, mcme or missing_mod */
  warning?: string;
  /** The room's pack results in order: loaded, declined, failed_download, failed_reload, invalid_url, timeout; not_sent is not final */
  packs: { result: string; waitMs?: number }[];
  /**
   * Absent while the player is still in the room. how: walked, confirmed,
   * skipped, quit, left or stopped, as the plugin logs them, or unknown when
   * the server stopped without a clean shutdown (two starts without a stop)
   */
  exit?: { how: string; at?: number; stayedMs?: number };
}

/** A room the player was passed over without being put in it */
export interface JourneySkip {
  room?: string;
  at: number;
  client: JourneyClient;
  /** true: the client needs nothing; false: it would get the room, but the player confirmed before */
  compatible?: boolean;
}

/** A player's way through the intro rooms, from the flow log */
export interface PlayerJourney {
  visits: JourneyVisit[];
  skips: JourneySkip[];
  /** The first `finish`; first: whether it was the player's first time through */
  finish?: { at: number; first?: boolean };
  /** Times the compatibility warning was shown again outside the rooms */
  reminders: number;
  /** /confirm: optifine, ignore or reset; inRoom: used in one of the rooms */
  confirms: { at: number; choice?: string; inRoom?: boolean }[];
}
