import type { WorldInfo, ContourData } from '../shared/protocol';
import { apiUrl } from './api';
import { escapeHtml } from './html';
import { setStatus, clearStatus } from './status';

import * as L from 'leaflet';

let map: L.Map;
let blockMapLayer: L.GridLayer | null = null;
let heatmapLayer: L.ImageOverlay | null = null;
let playerMarkerLayer: L.LayerGroup;
let legendControl: L.Control | null = null;
let contourLayer: L.LayerGroup | null = null;
let storedWorldInfo: WorldInfo;
let regionBounds: L.LatLngBounds;
let dropoutHeatmapLayer: L.ImageOverlay | null = null;
let dropoutLegendControl: L.Control | null = null;

export function initMap(worldInfo: WorldInfo): L.Map {
  storedWorldInfo = worldInfo;
  const { minX, maxX, minZ, maxZ } = worldInfo.bounds;

  // Create bounds for CRS.Simple: [lat, lng] = [z, x] in Minecraft terms
  const southWest = L.latLng(minZ, minX);
  const northEast = L.latLng(maxZ, maxX);
  regionBounds = L.latLngBounds(southWest, northEast);

  // Pad maxBounds slightly so the map doesn't feel claustrophobically clipped
  const padLat = (maxZ - minZ) * 0.1;
  const padLng = (maxX - minX) * 0.1;

  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -5,
    maxZoom: 5,
    zoomSnap: 0.5,
    attributionControl: false,
    maxBounds: L.latLngBounds(
      L.latLng(minZ - padLat, minX - padLng),
      L.latLng(maxZ + padLat, maxX + padLng),
    ),
    maxBoundsViscosity: 0.8,
  });

  map.fitBounds(regionBounds);

  playerMarkerLayer = L.layerGroup().addTo(map);

  return map;
}

/**
 * Toggle whether the map can pan beyond region bounds to show out-of-bounds players.
 */
export function toggleExtendedBounds(extended: boolean): void {
  if (!map || !storedWorldInfo) return;

  if (extended && storedWorldInfo.playerBounds) {
    const pb = storedWorldInfo.playerBounds;
    const padLat = (pb.maxZ - pb.minZ) * 0.1;
    const padLng = (pb.maxX - pb.minX) * 0.1;
    map.setMaxBounds(L.latLngBounds(
      L.latLng(pb.minZ - padLat, pb.minX - padLng),
      L.latLng(pb.maxZ + padLat, pb.maxX + padLng),
    ));
  } else {
    // Restore region-based maxBounds
    const { minX, maxX, minZ, maxZ } = storedWorldInfo.bounds;
    const padLat = (maxZ - minZ) * 0.1;
    const padLng = (maxX - minX) * 0.1;
    map.setMaxBounds(L.latLngBounds(
      L.latLng(minZ - padLat, minX - padLng),
      L.latLng(maxZ + padLat, maxX + padLng),
    ));
    // Snap back to region bounds if currently panned outside
    if (!regionBounds.contains(map.getCenter())) {
      map.fitBounds(regionBounds);
    }
  }
}

/**
 * Set the block map layer for a dimension using per-region tiles.
 * Tiles are 512x512 px, one per region file.
 * Tile coords map to Leaflet GridLayer coords:
 *   tx = coords.x, ty = coords.y (server handles the Y-flip)
 */
export function setBlockMap(dimension: string, _worldInfo: WorldInfo): void {
  const slug = dimension.replace('minecraft:', '');

  if (blockMapLayer) {
    map.removeLayer(blockMapLayer);
  }

  const RegionTileLayer = L.GridLayer.extend({
    createTile(coords: L.Coords) {
      const tile = document.createElement('img') as HTMLImageElement;
      tile.crossOrigin = '';
      tile.style.width = '512px';
      tile.style.height = '512px';

      const url = apiUrl(`/api/tiles/${slug}/${coords.x}/${coords.y}.png`);
      tile.src = url;

      // If tile doesn't exist (no region file), show nothing
      tile.onerror = () => {
        tile.style.display = 'none';
      };

      return tile;
    },
  });

  const layer: L.GridLayer = new (RegionTileLayer as unknown as new (options: L.GridLayerOptions) => L.GridLayer)({
    tileSize: 512,
    maxNativeZoom: 0,
    minNativeZoom: 0,
    minZoom: -5,
    maxZoom: 5,
    noWrap: true,
    keepBuffer: 4,
    updateWhenZooming: false,
  }).addTo(map);
  blockMapLayer = layer;

  // Tile loading progress
  let pendingTiles = 0;
  let loadedTiles = 0;

  layer.on('loading', () => {
    pendingTiles = 0;
    loadedTiles = 0;
    setStatus('tiles', 'Loading map tiles...');
  });

  layer.on('tileloadstart', () => {
    pendingTiles++;
    setStatus('tiles', `Loading map tiles (${loadedTiles}/${pendingTiles})...`);
  });

  layer.on('tileload', () => {
    loadedTiles++;
    setStatus('tiles', `Loading map tiles (${loadedTiles}/${pendingTiles})...`);
  });

  layer.on('tileerror', () => {
    loadedTiles++;
    setStatus('tiles', `Loading map tiles (${loadedTiles}/${pendingTiles})...`);
  });

  layer.on('load', () => {
    clearStatus('tiles');
  });
}

export function setHeatmap(
  url: string,
  worldInfo: WorldInfo,
  customBounds?: { minX: number; maxX: number; minZ: number; maxZ: number },
): void {
  const { minX, maxX, minZ, maxZ } = customBounds || worldInfo.bounds;
  const bounds: L.LatLngBoundsExpression = [
    [minZ, minX],
    [maxZ, maxX],
  ];

  if (heatmapLayer) {
    map.removeLayer(heatmapLayer);
  }

  heatmapLayer = L.imageOverlay(`${url}?t=${Date.now()}`, bounds, {
    opacity: 0.7,
    zIndex: 2,
  }).addTo(map);
}

/** Show the heatmap the server rendered at startup (last 30 days) for a dimension */
export function showDefaultHeatmap(dimension: string): void {
  const density = storedWorldInfo.heatmapDensity?.[dimension];
  if (!density) return;
  setHeatmap(apiUrl(density.url), storedWorldInfo);
  setHeatmapLegend(density.maxPerChunk, density.totalPlayers);
  if (density.contoursUrl) {
    loadContours(density.contoursUrl);
  }
}

export function setDropoutHeatmap(
  url: string,
  worldInfo: WorldInfo,
  customBounds?: { minX: number; maxX: number; minZ: number; maxZ: number },
): void {
  const { minX, maxX, minZ, maxZ } = customBounds || worldInfo.bounds;
  const bounds: L.LatLngBoundsExpression = [
    [minZ, minX],
    [maxZ, maxX],
  ];

  if (dropoutHeatmapLayer) {
    map.removeLayer(dropoutHeatmapLayer);
  }

  dropoutHeatmapLayer = L.imageOverlay(`${url}?t=${Date.now()}`, bounds, {
    opacity: 0.7,
    zIndex: 3,
  }).addTo(map);
}

export function clearDropoutHeatmap(): void {
  if (dropoutHeatmapLayer) {
    map.removeLayer(dropoutHeatmapLayer);
    dropoutHeatmapLayer = null;
  }
  if (dropoutLegendControl) {
    map.removeControl(dropoutLegendControl);
    dropoutLegendControl = null;
  }
}

export function setDropoutLegend(maxPerChunk: number, totalPlayers: number): void {
  if (dropoutLegendControl) {
    map.removeControl(dropoutLegendControl);
  }

  if (maxPerChunk <= 0) return;

  const LegendControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'dropout-legend');

      const stops = [
        'rgba(60,20,120,0.40)',
        'rgba(100,30,180,0.55)',
        'rgba(180,0,220,0.60)',
        'rgba(230,40,200,0.70)',
        'rgba(255,100,140,0.80)',
        'rgba(255,200,220,0.90)',
      ];

      const gradientBar = `linear-gradient(to right, ${stops.join(', ')})`;

      // innerHTML is safe here: data comes from server, not user input
      div.innerHTML = `
        <div class="legend-title">Gave up after the intro</div>
        <div class="legend-bar" style="background: ${gradientBar};"></div>
        <div class="legend-labels">
          <span>0</span>
          <span>${maxPerChunk} / chunk</span>
        </div>
        <div class="legend-total">${totalPlayers.toLocaleString()} players who finished the intro and never reached another server</div>
      `;

      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });

  dropoutLegendControl = new LegendControl({ position: 'bottomleft' });
  dropoutLegendControl.addTo(map);
}

export function toggleBlockMapVisibility(visible: boolean): void {
  if (blockMapLayer) {
    if (visible) {
      blockMapLayer.addTo(map);
    } else {
      map.removeLayer(blockMapLayer);
    }
  }
}

export function toggleHeatmapVisibility(visible: boolean): void {
  if (heatmapLayer) {
    if (visible) {
      heatmapLayer.addTo(map);
    } else {
      map.removeLayer(heatmapLayer);
    }
  }
  if (contourLayer) {
    if (visible) {
      contourLayer.addTo(map);
    } else {
      map.removeLayer(contourLayer);
    }
  }
}

export function flyTo(x: number, z: number, zoom = 3): void {
  map.flyTo(L.latLng(z, x), zoom, { duration: 0.8 });
}

export function addPlayerMarker(
  x: number,
  z: number,
  name: string,
  uuid: string,
  dimension: string,
): L.Marker {
  const marker = L.marker(L.latLng(z, x), {
    title: name || uuid,
  });

  const dimName = dimension.replace('minecraft:', '').replace('the_', '');
  marker.bindPopup(
    `<div class="player-popup">
      <div class="popup-name">${escapeHtml(name || 'Unknown')}</div>
      <div class="popup-info">UUID: ${escapeHtml(uuid)}</div>
      <div class="popup-info">Position: ${Math.round(x)}, ${Math.round(z)}</div>
      <div class="popup-info">Dimension: ${escapeHtml(dimName)}</div>
    </div>`,
  );

  marker.addTo(playerMarkerLayer);
  return marker;
}

export function clearPlayerMarkers(): void {
  playerMarkerLayer.clearLayers();
}

export async function loadContours(contoursUrl: string): Promise<void> {
  try {
    const res = await fetch(apiUrl(`${contoursUrl}?t=${Date.now()}`));
    if (!res.ok) return;
    const data: ContourData = await res.json();
    setContourLines(data);
  } catch (e) {
    console.warn('Failed to load contour data:', e);
  }
}

export function setContourLines(data: ContourData): void {
  if (contourLayer) {
    map.removeLayer(contourLayer);
  }

  contourLayer = L.layerGroup();

  for (const level of data.levels) {
    const label = level.value >= 1000
      ? `${(level.value / 1000).toFixed(1)}k`
      : `${level.value}`;

    for (const line of level.lines) {
      // Convert [x, z] to Leaflet [lat, lng] = [z, x]
      const latlngs = line.map(([x, z]) => L.latLng(z, x));

      // Draw the contour polyline
      const polyline = L.polyline(latlngs, {
        color: 'rgba(255, 255, 255, 0.6)',
        weight: 1.5,
        dashArray: '4 4',
        interactive: false,
      });
      contourLayer.addLayer(polyline);

      // Place density label at midpoint of polyline
      if (latlngs.length >= 2) {
        const midIdx = Math.floor(latlngs.length / 2);
        const midPoint = latlngs[midIdx];

        const marker = L.marker(midPoint, {
          icon: L.divIcon({
            className: 'contour-label',
            html: `<span>${label}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
          interactive: false,
          zIndexOffset: -100,
        });
        contourLayer.addLayer(marker);

        // For long polylines, add extra labels
        const totalPts = latlngs.length;
        if (totalPts > 20) {
          const step = Math.floor(totalPts / 3);
          for (const idx of [step, totalPts - step]) {
            const pt = latlngs[idx];
            const extra = L.marker(pt, {
              icon: L.divIcon({
                className: 'contour-label',
                html: `<span>${label}</span>`,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
              }),
              interactive: false,
              zIndexOffset: -100,
            });
            contourLayer.addLayer(extra);
          }
        }
      }
    }
  }

  contourLayer.addTo(map);
}

export function setCustomBounds(
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  fit = true,
): void {
  if (!map || !storedWorldInfo) return;

  if (bounds) {
    const padLat = (bounds.maxZ - bounds.minZ) * 0.1;
    const padLng = (bounds.maxX - bounds.minX) * 0.1;
    map.setMaxBounds(L.latLngBounds(
      L.latLng(bounds.minZ - padLat, bounds.minX - padLng),
      L.latLng(bounds.maxZ + padLat, bounds.maxX + padLng),
    ));
    if (fit) {
      map.fitBounds(L.latLngBounds(
        L.latLng(bounds.minZ, bounds.minX),
        L.latLng(bounds.maxZ, bounds.maxX),
      ));
    }
  } else {
    // Restore original region-based maxBounds
    const { minX, maxX, minZ, maxZ } = storedWorldInfo.bounds;
    const padLat = (maxZ - minZ) * 0.1;
    const padLng = (maxX - minX) * 0.1;
    map.setMaxBounds(L.latLngBounds(
      L.latLng(minZ - padLat, minX - padLng),
      L.latLng(maxZ + padLat, maxX + padLng),
    ));
    if (fit) {
      map.fitBounds(regionBounds);
    }
  }
}

export function getMap(): L.Map {
  return map;
}

export function setHeatmapLegend(maxPerChunk: number, totalPlayers: number): void {
  if (legendControl) {
    map.removeControl(legendControl);
  }

  if (maxPerChunk <= 0) return;

  const LegendControl = L.Control.extend({
    onAdd() {
      const div = L.DomUtil.create('div', 'heatmap-legend');

      // Color gradient bar (matches heatmapColor in heatmap-renderer.ts)
      const stops = [
        'rgba(30,60,180,0.40)',   // low - deep blue
        'rgba(0,140,255,0.55)',   // blue-cyan
        'rgba(0,255,255,0.60)',   // cyan
        'rgba(200,255,0,0.70)',   // yellow-green
        'rgba(255,155,0,0.80)',   // orange
        'rgba(255,0,0,0.90)',     // red - high
      ];

      const gradientBar = `linear-gradient(to right, ${stops.join(', ')})`;

      div.innerHTML = `
        <div class="legend-title">Player Density</div>
        <div class="legend-bar" style="background: ${gradientBar};"></div>
        <div class="legend-labels">
          <span>0</span>
          <span>${maxPerChunk} / chunk</span>
        </div>
        <div class="legend-total">${totalPlayers.toLocaleString()} players total</div>
      `;

      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });

  legendControl = new LegendControl({ position: 'bottomright' });
  legendControl.addTo(map);
}
