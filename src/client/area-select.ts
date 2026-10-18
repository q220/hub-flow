import type { WorldInfo } from '../shared/protocol';

import * as L from 'leaflet';

type BoundsRect = { minX: number; maxX: number; minZ: number; maxZ: number };
type BoundsCallback = (bounds: BoundsRect | null, opts?: { fit?: boolean }) => void;
type DrawModeCallback = (active: boolean) => void;

let map: L.Map;
let areaRect: L.Rectangle | null = null;
let cornerMarkers: L.Marker[] = [];
let drawMode = false;
let drawStart: L.LatLng | null = null;
let boundsCallbacks: BoundsCallback[] = [];
let drawModeCallbacks: DrawModeCallback[] = [];
let cornerDebounce: ReturnType<typeof setTimeout> | null = null;

export function initAreaSelect(leafletMap: L.Map, _worldInfo: WorldInfo): void {
  map = leafletMap;
}

export function onAreaBoundsChange(cb: BoundsCallback): void {
  boundsCallbacks.push(cb);
}

export function onDrawModeChange(cb: DrawModeCallback): void {
  drawModeCallbacks.push(cb);
}

export function getAreaBounds(): BoundsRect | null {
  if (!areaRect) return null;
  const b = areaRect.getBounds();
  return {
    minX: Math.floor(b.getWest()),
    maxX: Math.ceil(b.getEast()),
    minZ: Math.floor(b.getSouth()),
    maxZ: Math.ceil(b.getNorth()),
  };
}

export function clearArea(): void {
  if (drawMode) exitDrawMode();
  removeRect();
  fireBoundsChange(null, { fit: true });
}

export function enterDrawMode(): void {
  // Remove existing selection first
  removeRect();
  fireBoundsChange(null, { fit: true });

  drawMode = true;
  map.dragging.disable();
  map.getContainer().classList.add('draw-mode');
  map.on('mousedown', onDrawStart);
  fireDrawModeChange(true);
}

export function exitDrawMode(): void {
  drawMode = false;
  map.dragging.enable();
  map.getContainer().classList.remove('draw-mode');
  map.off('mousedown', onDrawStart);
  map.off('mousemove', onDrawMove);
  map.off('mouseup', onDrawEnd);
  drawStart = null;
  fireDrawModeChange(false);
}

export function isInDrawMode(): boolean {
  return drawMode;
}

function onDrawStart(e: L.LeafletMouseEvent): void {
  removeRect();
  drawStart = e.latlng;

  areaRect = L.rectangle(L.latLngBounds(drawStart, drawStart), {
    color: '#e94560',
    weight: 2,
    dashArray: '6 4',
    fillColor: '#e94560',
    fillOpacity: 0.1,
    interactive: false,
  }).addTo(map);

  map.on('mousemove', onDrawMove);
  map.on('mouseup', onDrawEnd);
}

function onDrawMove(e: L.LeafletMouseEvent): void {
  if (!drawStart || !areaRect) return;
  areaRect.setBounds(L.latLngBounds(drawStart, e.latlng));
}

function onDrawEnd(e: L.LeafletMouseEvent): void {
  if (!drawStart || !areaRect) return;

  const finalBounds = L.latLngBounds(drawStart, e.latlng);

  // Reject tiny selections (accidental clicks)
  const size = finalBounds.getNorthEast().distanceTo(finalBounds.getSouthWest());
  if (size < 10) {
    removeRect();
    exitDrawMode();
    return;
  }

  areaRect.setBounds(finalBounds);
  exitDrawMode();
  addCornerHandles();
  fireBoundsChange(getAreaBounds(), { fit: true });
}

function addCornerHandles(): void {
  removeCornerHandles();
  if (!areaRect) return;

  const b = areaRect.getBounds();
  const corners = [
    b.getNorthWest(),
    b.getNorthEast(),
    b.getSouthEast(),
    b.getSouthWest(),
  ];

  const cursors = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];

  corners.forEach((pos, i) => {
    const marker = L.marker(pos, {
      draggable: true,
      icon: L.divIcon({
        className: 'corner-handle',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
      zIndexOffset: 1000,
    });

    marker.on('add', () => {
      const el = marker.getElement();
      if (el) el.style.cursor = cursors[i];
    });

    marker.on('drag', () => onCornerDrag(i));
    marker.on('dragend', () => {
      // Debounce corner adjustment re-renders
      if (cornerDebounce) clearTimeout(cornerDebounce);
      cornerDebounce = setTimeout(() => {
        fireBoundsChange(getAreaBounds(), { fit: false });
      }, 300);
    });

    marker.addTo(map);
    cornerMarkers.push(marker);
  });
}

function onCornerDrag(draggedIdx: number): void {
  if (!areaRect || cornerMarkers.length !== 4) return;

  const oppositeIdx = (draggedIdx + 2) % 4;
  const dragged = cornerMarkers[draggedIdx].getLatLng();
  const opposite = cornerMarkers[oppositeIdx].getLatLng();

  const newBounds = L.latLngBounds(dragged, opposite);
  areaRect.setBounds(newBounds);

  const nw = newBounds.getNorthWest();
  const ne = newBounds.getNorthEast();
  const se = newBounds.getSouthEast();
  const sw = newBounds.getSouthWest();
  const positions = [nw, ne, se, sw];

  cornerMarkers.forEach((m, i) => {
    if (i !== draggedIdx) {
      m.setLatLng(positions[i]);
    }
  });
}

function removeCornerHandles(): void {
  for (const m of cornerMarkers) {
    map.removeLayer(m);
  }
  cornerMarkers = [];
}

function removeRect(): void {
  removeCornerHandles();
  if (areaRect) {
    map.removeLayer(areaRect);
    areaRect = null;
  }
  if (cornerDebounce) {
    clearTimeout(cornerDebounce);
    cornerDebounce = null;
  }
}

function fireBoundsChange(bounds: BoundsRect | null, opts?: { fit?: boolean }): void {
  for (const cb of boundsCallbacks) {
    cb(bounds, opts);
  }
}

function fireDrawModeChange(active: boolean): void {
  for (const cb of drawModeCallbacks) {
    cb(active);
  }
}
