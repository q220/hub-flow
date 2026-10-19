import fs from 'fs';
import path from 'path';
import type { IntroStatus, PlayerRecord } from '../../shared/protocol.js';
import { topLevelSections } from './simple-yaml.js';

/**
 * Hub intro progress from the MCME-Introduction plugin's own files.
 *
 * The plugin decides by position: on join it puts players back into the room
 * they stand in (room 1 = welcome screen, room 2 = client compatibility
 * check). Leaving room 2 starts the welcome chain, which appends the UUID to
 * finishedPlayerList.uid. So a player is either on that list, or their last
 * saved position shows which room they gave up in.
 */

interface Box {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export interface IntroData {
  finished: Set<string>;
  welcomeRoom: Box | null;
  compatibilityRoom: Box | null;
  /** World the rooms are in, as a dimension id of this world */
  dimensions: Set<string>;
}

/** Plugin folder: INTRO_DIR, else plugins/MCME-Introduction next to the world folder */
export function introDir(worldPath: string): string {
  return process.env.INTRO_DIR
    || path.join(path.dirname(path.resolve(worldPath)), 'plugins', 'MCME-Introduction');
}

export function loadIntroData(worldPath: string): IntroData | null {
  const dir = introDir(worldPath);
  const finishedFile = path.join(dir, 'finishedPlayerList.uid');
  if (!fs.existsSync(finishedFile)) return null;

  const finished = new Set(
    fs.readFileSync(finishedFile, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean),
  );

  let welcomeRoom: Box | null = null;
  let compatibilityRoom: Box | null = null;
  const dimensions = new Set(['minecraft:overworld']);
  const locationsFile = path.join(dir, 'locations.yml');
  if (fs.existsSync(locationsFile)) {
    const sections = topLevelSections(fs.readFileSync(locationsFile, 'utf-8'));
    welcomeRoom = toBox(sections.firstRoom);
    compatibilityRoom = toBox(sections.secondRoom);
    // Legacy layout: a non-main world is its own dimension, e.g. minecraft:newplayer
    const world = sections.firstRoom?.world;
    if (world) dimensions.add(`minecraft:${world}`);
  }

  return { finished, welcomeRoom, compatibilityRoom, dimensions };
}

export function introStatus(intro: IntroData, p: PlayerRecord): IntroStatus {
  if (intro.finished.has(p.uuid)) return 'finished';
  if (intro.dimensions.has(p.dimension)) {
    if (intro.welcomeRoom && inBox(intro.welcomeRoom, p)) return 'welcome';
    if (intro.compatibilityRoom && inBox(intro.compatibilityRoom, p)) return 'compatibility';
  }
  return 'other';
}

function inBox(b: Box, p: PlayerRecord): boolean {
  return p.x >= b.minX && p.x < b.maxX && p.y >= b.minY && p.y < b.maxY && p.z >= b.minZ && p.z < b.maxZ;
}

/** pos1/pos2 are inclusive block corners, so the box ends one block past the larger one */
function toBox(section: Record<string, string> | undefined): Box | null {
  const a = parseVec(section?.pos1);
  const b = parseVec(section?.pos2);
  if (!a || !b) return null;
  return {
    minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]) + 1,
    minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]) + 1,
    minZ: Math.min(a[2], b[2]), maxZ: Math.max(a[2], b[2]) + 1,
  };
}

function parseVec(value: string | undefined): number[] | null {
  const parts = value?.trim().split(/\s+/).map(Number);
  return parts && parts.length >= 3 && parts.every(Number.isFinite) ? parts : null;
}
