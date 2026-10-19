import { config } from '../config.js';
import { indexPlayers } from './player-indexer.js';
import { loadPlayerCache, savePlayerCache, playerCacheFile } from './player-cache.js';
import { playerStore } from './player-store.js';
import { loadIntroData } from './intro-progress.js';
import { loadPackStatus } from './pack-status.js';
import { loadHubSessions } from './hub-sessions.js';
import { loadProxyActivity } from './proxy-activity.js';
import { loadClientVersions } from './client-versions.js';
import { FlowModel, loadFlowEvents } from './flow.js';
import { FlowHistory, historyFile } from './flow-history.js';
import { ReleaseLog, releaseLogFile } from './release-log.js';
import { FlowLogReader, flowLogDir } from './flow-log.js';
import { assembleJourneys } from './journey.js';

/** The flow model the API serves; replaced whole on every refresh */
export const liveData: { flow: FlowModel | null } = { flow: null };

/** The cache is ~90 MB; between restarts it is rewritten at most this often */
const CACHE_SAVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastCacheSave = 0;
let history: FlowHistory | null = null;
let releases: ReleaseLog | null = null;
/** Kept between refreshes: it remembers how far today's and yesterday's files were read */
let flowLogReader: FlowLogReader | null = null;

/**
 * Re-read everything the flow and the map are built from: player files
 * (incrementally), intro progress, pack results, hub sessions and the flow log.
 */
export async function refreshData(opts: { initial: boolean; serverVersion: string }): Promise<void> {
  const worldPath = config.worldPath;
  const t0 = performance.now();

  const previous = opts.initial
    ? loadPlayerCache()
    : new Map(playerStore.all().map((p) => [p.uuid, p]));
  if (opts.initial && previous.size > 0) console.log(`  ${previous.size} players in cache`);

  const indexed = await indexPlayers(worldPath, previous, opts.initial
    ? (progress) => process.stdout.write(`\r  Progress: ${progress.processed}/${progress.total} (${progress.percent}%)`)
    : undefined);
  if (opts.initial) process.stdout.write('\n');
  playerStore.replaceAll(indexed.players);

  const changed = indexed.parsed > 0 || indexed.players.length !== previous.size;
  if (changed && (opts.initial || Date.now() - lastCacheSave > CACHE_SAVE_INTERVAL_MS)) {
    try {
      savePlayerCache(indexed.players);
      lastCacheSave = Date.now();
      if (opts.initial) console.log(`  Saved player cache to ${playerCacheFile}`);
    } catch (e) {
      console.warn('  Failed to save player cache:', e);
    }
  }

  const intro = loadIntroData(worldPath);
  playerStore.setIntroData(intro);
  flowLogReader ??= new FlowLogReader(flowLogDir(worldPath));
  const [packs, sessions, activity, clients, log] = await Promise.all([
    loadPackStatus(worldPath), loadHubSessions(worldPath), loadProxyActivity(worldPath), loadClientVersions(worldPath),
    flowLogReader.read(),
  ]);
  const flowLog = log ? { coverageStart: log.coverageStart, badLines: log.badLines, journeys: assembleJourneys(log.events) } : null;
  const events = loadFlowEvents();
  history ??= FlowHistory.load();
  releases ??= ReleaseLog.load();
  // Without pack data nothing is noted, so a release is never dated by an outage
  if (packs) releases.observe([...packs.values()].filter((p) => p.pack && p.version), Date.now());
  const flow = new FlowModel({
    players: indexed.players, intro, packs, sessions, activity, clients, history, releases, serverVersion: opts.serverVersion, events, flowLog,
  });
  flow.recordHistory(history);
  try {
    if (history.save() && opts.initial) console.log(`  Saved flow history (${history.size} players) to ${historyFile}`);
  } catch (e) {
    console.warn('  Failed to save flow history:', e);
  }
  try {
    if (releases.save() && opts.initial) console.log(`  Saved pack release log to ${releaseLogFile}`);
  } catch (e) {
    console.warn('  Failed to save pack release log:', e);
  }
  liveData.flow = flow;

  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  const parts = [
    `${playerStore.count} players (${indexed.parsed} parsed, ${indexed.failed} unreadable)`,
    intro ? `${intro.finished.size} intro finishers` : 'no intro data',
    packs ? `${packs.size} pack records` : 'no pack data',
    clients ? `${clients.size} client versions` : 'no client versions',
    sessions ? `hub sessions since ${new Date(sessions.coverageStart).toLocaleDateString('en-CA')}` : 'no hub logs',
    activity ? `proxy activity since ${new Date(activity.coverageStart).toLocaleDateString('en-CA')}` : 'no proxy logs',
    !flowLog ? 'no flow log'
      : `${flowLog.coverageStart !== null ? `flow log since ${new Date(flowLog.coverageStart).toLocaleDateString('en-CA')}` : 'flow log without a start yet'}`
        + ` (${flowLog.journeys.size} journeys${flowLog.badLines > 0 ? `, ${flowLog.badLines} unreadable lines` : ''})`,
    `${events.length} events`,
    `history of ${history.size} players`,
  ];
  console.log(`${opts.initial ? 'Loaded' : 'Refreshed'}: ${parts.join(', ')} (${secs}s)`);
}
