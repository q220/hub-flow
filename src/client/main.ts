// Leaflet and the styles are bundled: the page loads nothing from other hosts,
// so it runs under the MCME dashboard's Content-Security-Policy
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import type { FlowPlayer, WorldInfo } from '../shared/protocol';
import { apiUrl } from './api';
import { initMap, setBlockMap, showDefaultHeatmap, getMap, flyTo, addPlayerMarker, clearPlayerMarkers } from './map';
import { initFlowPage, onFlowShown } from './flow/flow-page';
import { initSearch } from './search';
import { initFilters } from './filters';
import { initSidebar } from './sidebar';
import { initPlayerLayer, setPlayerDimension } from './player-layer';
import { initStatus, setStatus, clearStatus } from './status';

const $ = (id: string) => document.getElementById(id)!;

// Inside the dashboard's New players page (?embed): the dashboard shows the title
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embedded');

let worldInfo: WorldInfo | null = null;
let mapReady = false;

async function boot(): Promise<void> {
  try {
    const infoRes = await fetch(apiUrl('/api/world-info'));
    worldInfo = await infoRes.json();
  } catch (err) {
    console.error('Failed to load world info:', err);
  }
  if (worldInfo) $('brand-world').textContent = `${worldInfo.name} · ${worldInfo.mcVersion}`;

  initFlowPage({ onShowOnMap: showPlayerOnMap });
  window.addEventListener('hashchange', route);
  route();
}

/** #map shows the map, anything else the flow page */
function route(): void {
  const view = location.hash === '#map' ? 'map' : 'flow';
  $('view-flow').hidden = view !== 'flow';
  $('app').hidden = view !== 'map';
  for (const tab of document.querySelectorAll<HTMLAnchorElement>('.tab')) {
    if (tab.dataset.view === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  if (view === 'map') {
    ensureMap();
    getMap()?.invalidateSize();
  } else {
    onFlowShown();
  }
}

/** Leaflet measures its container, so the map is built the first time its view is visible */
function ensureMap(): void {
  if (mapReady || !worldInfo) return;
  mapReady = true;
  initMapView(worldInfo);
}

function showPlayerOnMap(p: FlowPlayer): void {
  if (location.hash !== '#map') location.hash = '#map';
  route();
  clearPlayerMarkers();
  addPlayerMarker(p.x, p.z, p.name ?? '', p.uuid, p.dimension).openPopup();
  flyTo(p.x, p.z, 3);
}

function initMapView(worldInfo: WorldInfo): void {
  const loadingOverlay = document.getElementById('loading-overlay')!;

  try {
    // 1. Initialize map
    const map = initMap(worldInfo);
    // 3. Initialize status bar (must be before modules that produce status)
    initStatus();

    // 4. Initialize sidebar
    initSidebar(worldInfo);

    // 5. Prefer overworld as default, fall back to first available
    const defaultDim = worldInfo.dimensions.includes('minecraft:overworld')
      ? 'minecraft:overworld'
      : worldInfo.dimensions[0] || 'minecraft:overworld';
    setBlockMap(defaultDim, worldInfo);

    // Load heatmap, legend and contour lines (pre-rendered on server with default 30-day filter)
    setStatus('heatmap-init', 'Loading heatmap...');
    showDefaultHeatmap(defaultDim);
    clearStatus('heatmap-init');

    // 6. Initialize filters (dimension toggles, date, layers)
    initFilters(worldInfo);

    // 7. Initialize search
    initSearch();

    // 8. Initialize player layer — fetches clusters from server per viewport
    initPlayerLayer(worldInfo);
    setPlayerDimension(defaultDim);

    // 9. Add spawn point marker if available
    if (worldInfo.spawn) {
      const spawnIcon = L.divIcon({
        className: 'spawn-marker',
        html: '<div class="spawn-marker-inner"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const spawnMarker = L.marker(
        L.latLng(worldInfo.spawn.z, worldInfo.spawn.x),
        { icon: spawnIcon, zIndexOffset: 1000 },
      ).addTo(map);
      spawnMarker.bindPopup(
        `<div class="player-popup">
          <div class="popup-name">World Spawn</div>
          <div class="popup-info">X: ${worldInfo.spawn.x}, Z: ${worldInfo.spawn.z}</div>
        </div>`,
      );
      spawnMarker.bindTooltip('Spawn', {
        permanent: true,
        direction: 'top',
        offset: [0, -10],
        className: 'spawn-label',
      });
    }

    // 10. Set up coordinate display on hover
    const coordDisplay = document.getElementById('coord-display')!;
    map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const x = Math.round(e.latlng.lng);
      const z = Math.round(e.latlng.lat);
      coordDisplay.innerHTML = `<span>X: ${x} &nbsp; Z: ${z}</span>`;
    });

    // Hide loading
    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error('Failed to initialize:', err);
    loadingOverlay.innerHTML = `
      <div class="loading-content">
        <p style="color: var(--accent)">Failed to load world data</p>
        <p style="font-size: 13px; color: var(--text-secondary); margin-top: 8px">
          Make sure the server is running and the world path is correct.
        </p>
      </div>
    `;
  }
}

boot();
