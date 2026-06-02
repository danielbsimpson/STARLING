// frontend/directions-map.js
// Lightweight canvas renderer for Directions route visualization.
// Renders a dark grid map, origin/destination markers, and a destination->origin
// animated neon route with yellow estimated slowdown subsegments.

import { DIRECTIONS_MAP_THEME, DIRECTIONS_MAP_TILE_THEMES } from './config.js';

const PALETTE = {
  bg: '#090909',
  gridA: 'rgba(255,255,255,0.04)',
  gridB: 'rgba(255,255,255,0.02)',
  frame: 'rgba(255,255,255,0.08)',
  route: '#37f3ff',
  routeGlow: 'rgba(55,243,255,0.45)',
  slow: '#ffd84d',
  slowGlow: 'rgba(255,216,77,0.45)',
  origin: '#9a9a9a',
  destination: '#37f3ff',
  markerStroke: 'rgba(0,0,0,0.8)',
  label: 'rgba(230,230,230,0.9)',
};

const MAP_PADDING = 22;
const DEFAULT_TILE_URL = DIRECTIONS_MAP_TILE_THEMES.dark;
const TILE_SIZE = 256;
const TILE_CACHE = new Map();

let _canvas = null;
let _ctx = null;
let _fallbackEl = null;
let _state = null;
let _animId = null;
let _resizeBound = false;
let _resizeObserver = null;

function _ensureCanvasSize() {
  if (!_canvas || !_ctx) return;
  const rect = _canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.max(1, Math.floor(rect.width * dpr));
  const targetH = Math.max(1, Math.floor(rect.height * dpr));
  if (_canvas.width === targetW && _canvas.height === targetH) return;

  _canvas.width = targetW;
  _canvas.height = targetH;
  _ctx.setTransform(1, 0, 0, 1, 0, 0);
  _ctx.scale(dpr, dpr);
}

function _drawBase() {
  if (!_canvas || !_ctx) return;
  const w = _canvas.clientWidth;
  const h = _canvas.clientHeight;

  _ctx.clearRect(0, 0, w, h);

  const grad = _ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#111');
  grad.addColorStop(1, PALETTE.bg);
  _ctx.fillStyle = grad;
  _ctx.fillRect(0, 0, w, h);

  _ctx.strokeStyle = PALETTE.gridA;
  _ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 28) {
    _ctx.beginPath();
    _ctx.moveTo(x + 0.5, 0);
    _ctx.lineTo(x + 0.5, h);
    _ctx.stroke();
  }
  _ctx.strokeStyle = PALETTE.gridB;
  for (let y = 0; y < h; y += 28) {
    _ctx.beginPath();
    _ctx.moveTo(0, y + 0.5);
    _ctx.lineTo(w, y + 0.5);
    _ctx.stroke();
  }

  _ctx.strokeStyle = PALETTE.frame;
  _ctx.lineWidth = 1;
  _ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
}

function _clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function _tileTemplate() {
  const selectedTheme = String(
    window.STARLING_DIRECTIONS_MAP_THEME
    || window.localStorage?.getItem('starling_directions_map_theme')
    || DIRECTIONS_MAP_THEME
    || 'dark'
  ).trim().toLowerCase();
  const themed = DIRECTIONS_MAP_TILE_THEMES[selectedTheme] || '';
  const custom = String(window.STARLING_DIRECTIONS_TILE_URL || '').trim();
  return custom || themed || DEFAULT_TILE_URL;
}

function _tileUrl(z, x, y) {
  return _tileTemplate()
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

function _toWorldPx(lat, lon, z) {
  const scale = TILE_SIZE * (2 ** z);
  const clampedLat = _clamp(lat, -85.05112878, 85.05112878);
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);
  const x = ((lon + 180) / 360) * scale;
  const y = (0.5 - (Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI))) * scale;
  return { x, y };
}

function _chooseTileZoom(minLat, minLon, maxLat, maxLon, innerW, innerH) {
  for (let z = 15; z >= 3; z -= 1) {
    const a = _toWorldPx(maxLat, minLon, z);
    const b = _toWorldPx(minLat, maxLon, z);
    const spanX = Math.abs(b.x - a.x);
    const spanY = Math.abs(b.y - a.y);
    if (spanX <= innerW * 2.5 && spanY <= innerH * 2.5) return z;
  }
  return 3;
}

function _ensureTileRequested(z, x, y) {
  const key = `${z}/${x}/${y}`;
  const cached = TILE_CACHE.get(key);
  if (cached) return cached;

  const entry = { status: 'loading', img: null };
  TILE_CACHE.set(key, entry);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    entry.status = 'loaded';
    entry.img = img;
    if (_state) _render(_state.lastProgress || 0);
  };
  img.onerror = () => {
    entry.status = 'error';
    entry.img = null;
    if (_state) _render(_state.lastProgress || 0);
  };
  img.src = _tileUrl(z, x, y);
  return entry;
}

function _drawTileBasemap() {
  if (!_state?.tileViewport || !_ctx) return;
  const tv = _state.tileViewport;

  let loadedAny = false;
  for (let ty = tv.minTileY; ty <= tv.maxTileY; ty += 1) {
    for (let tx = tv.minTileX; tx <= tv.maxTileX; tx += 1) {
      const entry = _ensureTileRequested(tv.zoom, tx, ty);
      if (!entry || entry.status !== 'loaded' || !entry.img) continue;

      const wx = tx * TILE_SIZE;
      const wy = ty * TILE_SIZE;
      const dx = tv.originX + (wx - tv.minWorldX) * tv.scale;
      const dy = tv.originY + (wy - tv.minWorldY) * tv.scale;
      const ds = TILE_SIZE * tv.scale;
      _ctx.drawImage(entry.img, dx, dy, ds, ds);
      loadedAny = true;
    }
  }

  if (loadedAny) {
    _ctx.fillStyle = 'rgba(0,0,0,0.12)';
    _ctx.fillRect(0, 0, _canvas.clientWidth, _canvas.clientHeight);
  }
}

function _distance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function _buildSlowEdgeSet(segments = []) {
  const set = new Set();
  for (const seg of segments) {
    if (!seg || !seg.slow_zone) continue;
    const start = Number(seg.start_idx);
    const end = Number(seg.end_idx);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const lo = Math.max(0, Math.min(start, end));
    const hi = Math.max(0, Math.max(start, end));
    for (let i = lo; i < hi; i += 1) set.add(i);
  }
  return set;
}

function _projectRoute(routePolyline, bbox) {
  const points = (routePolyline || []).filter(pt => Array.isArray(pt) && pt.length >= 2)
    .map(([lat, lon]) => ({ lat: Number(lat), lon: Number(lon) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  if (!points.length || !_canvas) return [];

  let minLat;
  let minLon;
  let maxLat;
  let maxLon;

  if (Array.isArray(bbox) && bbox.length === 4) {
    [minLat, minLon, maxLat, maxLon] = bbox.map(Number);
  } else {
    minLat = Math.min(...points.map(p => p.lat));
    maxLat = Math.max(...points.map(p => p.lat));
    minLon = Math.min(...points.map(p => p.lon));
    maxLon = Math.max(...points.map(p => p.lon));
  }

  const w = _canvas.clientWidth;
  const h = _canvas.clientHeight;
  const innerW = Math.max(1, w - MAP_PADDING * 2);
  const innerH = Math.max(1, h - MAP_PADDING * 2);

  const zoom = _chooseTileZoom(minLat, minLon, maxLat, maxLon, innerW, innerH);

  const worldPoints = points.map(p => ({ ...p, ..._toWorldPx(p.lat, p.lon, zoom) }));
  let minWorldX = Math.min(...worldPoints.map(p => p.x));
  let maxWorldX = Math.max(...worldPoints.map(p => p.x));
  let minWorldY = Math.min(...worldPoints.map(p => p.y));
  let maxWorldY = Math.max(...worldPoints.map(p => p.y));

  // Add margin so path isn't glued to the frame.
  const padX = Math.max(16, (maxWorldX - minWorldX) * 0.12);
  const padY = Math.max(16, (maxWorldY - minWorldY) * 0.12);
  minWorldX -= padX;
  maxWorldX += padX;
  minWorldY -= padY;
  maxWorldY += padY;

  const spanX = Math.max(1, maxWorldX - minWorldX);
  const spanY = Math.max(1, maxWorldY - minWorldY);
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const drawW = spanX * scale;
  const drawH = spanY * scale;
  const originX = MAP_PADDING + (innerW - drawW) * 0.5;
  const originY = MAP_PADDING + (innerH - drawH) * 0.5;

  const worldTiles = 2 ** zoom;
  const minTileX = _clamp(Math.floor(minWorldX / TILE_SIZE) - 1, 0, worldTiles - 1);
  const maxTileX = _clamp(Math.floor(maxWorldX / TILE_SIZE) + 1, 0, worldTiles - 1);
  const minTileY = _clamp(Math.floor(minWorldY / TILE_SIZE) - 1, 0, worldTiles - 1);
  const maxTileY = _clamp(Math.floor(maxWorldY / TILE_SIZE) + 1, 0, worldTiles - 1);

  _state = _state || {};
  _state.tileViewport = {
    zoom,
    minWorldX,
    maxWorldX,
    minWorldY,
    maxWorldY,
    scale,
    originX,
    originY,
    minTileX,
    maxTileX,
    minTileY,
    maxTileY,
  };

  return worldPoints.map((p, idx) => {
    return {
      idx,
      lat: p.lat,
      lon: p.lon,
      x: originX + (p.x - minWorldX) * scale,
      y: originY + (p.y - minWorldY) * scale,
    };
  });
}

function _drawMarker(point, label, color) {
  if (!point || !_ctx) return;
  _ctx.beginPath();
  _ctx.fillStyle = color;
  _ctx.strokeStyle = PALETTE.markerStroke;
  _ctx.lineWidth = 2;
  _ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
  _ctx.fill();
  _ctx.stroke();

  _ctx.font = '10px Share Tech Mono, monospace';
  _ctx.fillStyle = PALETTE.label;
  _ctx.textAlign = 'left';
  _ctx.textBaseline = 'bottom';
  _ctx.fillText(label, point.x + 8, point.y - 6);
}

function _drawEdge(a, b, isSlow, progress = 1) {
  if (!_ctx || !a || !b || progress <= 0) return;
  const x2 = a.x + (b.x - a.x) * progress;
  const y2 = a.y + (b.y - a.y) * progress;

  _ctx.beginPath();
  _ctx.moveTo(a.x, a.y);
  _ctx.lineTo(x2, y2);
  _ctx.strokeStyle = isSlow ? PALETTE.slowGlow : PALETTE.routeGlow;
  _ctx.lineWidth = 7;
  _ctx.lineCap = 'round';
  _ctx.stroke();

  _ctx.beginPath();
  _ctx.moveTo(a.x, a.y);
  _ctx.lineTo(x2, y2);
  _ctx.strokeStyle = isSlow ? PALETTE.slow : PALETTE.route;
  _ctx.lineWidth = 3;
  _ctx.lineCap = 'round';
  _ctx.stroke();
}

function _render(progressRatio = 0) {
  if (!_state || !_ctx) return;
  _drawBase();
  _drawTileBasemap();

  const route = _state.route;
  if (!route.length) {
    if (_fallbackEl) _fallbackEl.textContent = 'Route path unavailable';
    const originPoint = _state.originPoint;
    const destinationPoint = _state.destinationPoint;
    if (originPoint) _drawMarker(originPoint, 'ORIGIN', PALETTE.origin);
    if (destinationPoint) _drawMarker(destinationPoint, 'DESTINATION', PALETTE.destination);
    return;
  }

  if (_fallbackEl) _fallbackEl.textContent = '';

  const path = _state.path;
  const slowEdges = _state.slowEdges;
  const total = _state.totalLength;
  const targetDist = total * Math.max(0, Math.min(1, progressRatio));

  let walked = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const edgeLen = _state.edgeLengths[i];
    const edgeOrigIdx = Math.min(a.idx, b.idx);
    const isSlow = slowEdges.has(edgeOrigIdx);

    if (walked + edgeLen <= targetDist) {
      _drawEdge(a, b, isSlow, 1);
      walked += edgeLen;
      continue;
    }

    const remaining = targetDist - walked;
    if (remaining > 0 && edgeLen > 0) {
      _drawEdge(a, b, isSlow, remaining / edgeLen);
    }
    break;
  }

  const originPoint = _state.route[0];
  const destinationPoint = _state.route[_state.route.length - 1];
  _drawMarker(originPoint, 'ORIGIN', PALETTE.origin);
  _drawMarker(destinationPoint, 'DESTINATION', PALETTE.destination);
}

function _cancelAnimation() {
  if (_animId != null) {
    cancelAnimationFrame(_animId);
    _animId = null;
  }
}

function _onResize() {
  if (!_canvas || !_state) return;
  _ensureCanvasSize();
  if (_canvas.clientWidth < 10 || _canvas.clientHeight < 10) return;
  _state.route = _projectRoute(_state.routePolyline, _state.routeBbox);
  _state.path = [..._state.route];
  _state.edgeLengths = [];
  _state.totalLength = 0;
  for (let i = 0; i < _state.path.length - 1; i += 1) {
    const len = _distance(_state.path[i], _state.path[i + 1]);
    _state.edgeLengths.push(len);
    _state.totalLength += len;
  }
  _render(_state.lastProgress || 0);
}

/**
 * Initialize map module with element ids.
 */
export function initDirectionsMap({ canvasId = 'directions-map-canvas', fallbackId = 'directions-map-fallback' } = {}) {
  _canvas = document.getElementById(canvasId);
  _fallbackEl = document.getElementById(fallbackId);
  _ctx = _canvas ? _canvas.getContext('2d') : null;

  if (_canvas && !_resizeBound) {
    window.addEventListener('resize', _onResize);
    _resizeBound = true;
  }

  // The directions panel animates from width 0 -> expanded. Observe the canvas
  // box directly so we redraw once layout settles, without requiring a window resize.
  if (_canvas && typeof ResizeObserver !== 'undefined' && !_resizeObserver) {
    _resizeObserver = new ResizeObserver(() => _onResize());
    _resizeObserver.observe(_canvas);
  }
}

/**
 * Set route/map state and render static base.
 */
export function renderDirectionsMap(payload) {
  if (!_canvas || !_ctx) return false;
  _cancelAnimation();
  _ensureCanvasSize();

  const routePolyline = Array.isArray(payload?.route_polyline) ? payload.route_polyline : [];
  const routeBbox = Array.isArray(payload?.route_bbox) ? payload.route_bbox : null;
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];

  const route = _projectRoute(routePolyline, routeBbox);
  const path = [...route];

  let totalLength = 0;
  const edgeLengths = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const len = _distance(path[i], path[i + 1]);
    edgeLengths.push(len);
    totalLength += len;
  }

  _state = {
    routePolyline,
    routeBbox,
    route,
    path,
    segments,
    slowEdges: _buildSlowEdgeSet(segments),
    edgeLengths,
    totalLength,
    originPoint: route[0] || null,
    destinationPoint: route[route.length - 1] || null,
    lastProgress: 0,
  };

  _render(0);

  // One extra pass after the next frame catches width transitions that complete
  // just after the initial render call.
  requestAnimationFrame(() => _onResize());
  return true;
}

/**
 * Animate drawing from origin to destination.
 */
export function animateRouteFromOrigin({ durationMs = 7000 } = {}) {
  if (!_state || !_ctx) return;
  _cancelAnimation();

  const routeHasPath = Array.isArray(_state.route) && _state.route.length > 1;
  if (!routeHasPath) {
    _render(0);
    return;
  }

  const start = performance.now();
  const totalMs = Math.max(500, Number(durationMs) || 7000);

  const step = now => {
    const ratio = Math.max(0, Math.min(1, (now - start) / totalMs));
    _state.lastProgress = ratio;
    _render(ratio);
    if (ratio < 1) {
      _animId = requestAnimationFrame(step);
    } else {
      _animId = null;
    }
  };

  _animId = requestAnimationFrame(step);
}

// Backward-compatible alias retained for existing imports/tests.
export function animateRouteFromDestination(opts = {}) {
  animateRouteFromOrigin(opts);
}

/**
 * Remove route drawing state and stop any in-flight animation.
 */
export function destroyDirectionsMap() {
  _cancelAnimation();
  _state = null;
  if (_ctx && _canvas) {
    _ensureCanvasSize();
    _drawBase();
    if (_fallbackEl) _fallbackEl.textContent = '';
  }
}
