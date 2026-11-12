// A small slippy map for Bargo: OpenStreetMap tiles, pan, zoom, markers and route lines. No dependencies.
// Tiles come from OpenStreetMap's public servers, which suit testing. Before a big launch, switch TILE_URL
// to a paid tile provider (MapTiler, Mapbox, Stadia...) as the OSM tile usage policy asks for.
(function () {
  'use strict';
  const TILE = 256, MIN_Z = 10, MAX_Z = 18;
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Web Mercator: latitude/longitude <-> pixel on the whole-world map at zoom z.
  function project(lat, lng, z) {
    const n = TILE * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
    return { x: ((lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function unproject(x, y, z) {
    const n = TILE * 2 ** z;
    return { lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, lng: (x / n) * 360 - 180 };
  }

  class TileMap {
    constructor(el, opts = {}) {
      this.el = el;
      this.interactive = opts.interactive !== false;
      this.z = clamp(opts.zoom ?? 13, MIN_Z, MAX_Z);
      this.center = { lat: opts.center?.lat ?? 4.8156, lng: opts.center?.lng ?? 7.0498 };
      this.markers = [];
      this.lines = [];
      this.tileEls = new Map();
      this.handlers = {};
      this.abort = new AbortController();
      this.w = 0; this.h = 0;
      el.classList.add('tmap');
      el.style.touchAction = this.interactive ? 'none' : 'pan-y';
      el.innerHTML = '<div class="tm-tiles"></div><svg class="tm-line" aria-hidden="true"></svg><div class="tm-marks"></div>'
        + (opts.centerPin ? '<div class="tm-pin" aria-hidden="true"><i></i></div>' : '')
        + (this.interactive ? '<div class="tm-ctrl"><button type="button" data-z="1" aria-label="Zoom in">+</button><button type="button" data-z="-1" aria-label="Zoom out">&minus;</button></div>' : '')
        + '<div class="tm-attr"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">&copy; OpenStreetMap contributors</a></div>';
      this.tiles = el.querySelector('.tm-tiles');
      this.svg = el.querySelector('.tm-line');
      this.marks = el.querySelector('.tm-marks');
      if (this.interactive) this.bind();
      if (typeof ResizeObserver !== 'undefined') { this.ro = new ResizeObserver(() => this.render()); this.ro.observe(el); }
      this.render();
    }

    // ----- view -----
    setView(lat, lng, z) {
      this.center = { lat, lng };
      if (z != null) this.z = clamp(Math.round(z), MIN_Z, MAX_Z);
      this.render();
    }
    getCenter() { return { ...this.center }; }
    getZoom() { return this.z; }
    fitBounds(points, pad = 34) {
      const pts = points.filter(Boolean).map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p));
      if (!pts.length) return;
      this.measure();
      const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
      const box = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lngs), w: Math.min(...lngs) };
      const aw = Math.max(40, this.w - pad * 2), ah = Math.max(40, this.h - pad * 2);
      let z = 16;
      if (box.n !== box.s || box.e !== box.w) {
        for (z = MAX_Z; z > MIN_Z; z--) {
          const a = project(box.n, box.w, z), b = project(box.s, box.e, z);
          if (b.x - a.x <= aw && b.y - a.y <= ah) break;
        }
      }
      const a = project(box.n, box.w, z), b = project(box.s, box.e, z);
      const mid = unproject((a.x + b.x) / 2, (a.y + b.y) / 2, z);
      this.setView(mid.lat, mid.lng, z);
    }

    // ----- things on the map -----
    addMarker(lat, lng, cls = '', title = '') {
      const el = document.createElement('div');
      el.className = 'tm-mk ' + cls;
      if (title) el.title = title;
      this.marks.appendChild(el);
      const m = { lat, lng, el };
      this.markers.push(m);
      this.render();
      return m;
    }
    addLine(points, { dashed = false } = {}) {
      this.lines.push({ pts: points.map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p)), dashed });
      this.render();
    }
    on(name, fn) { (this.handlers[name] ||= []).push(fn); }
    emit(name) { (this.handlers[name] || []).forEach((f) => f(this.getCenter(), this.z)); }

    // ----- drawing -----
    measure() { this.w = this.el.clientWidth; this.h = this.el.clientHeight; }
    render() {
      this.measure();
      if (!this.w || !this.h) return;
      const { w, h, z } = this;
      const c = project(this.center.lat, this.center.lng, z);
      const left = c.x - w / 2, top = c.y - h / 2, n = 2 ** z;
      const want = new Set();
      for (let y = Math.floor(top / TILE); y <= Math.floor((top + h) / TILE); y++) {
        if (y < 0 || y >= n) continue;
        for (let x = Math.floor(left / TILE); x <= Math.floor((left + w) / TILE); x++) {
          const wx = ((x % n) + n) % n, key = `${z}/${wx}/${y}/${x}`;
          want.add(key);
          let img = this.tileEls.get(key);
          if (!img) {
            img = new Image();
            img.alt = ''; img.draggable = false; img.className = 'tm-tile';
            img.onerror = () => img.classList.add('bad');
            img.src = TILE_URL.replace('{z}', z).replace('{x}', wx).replace('{y}', y);
            this.tiles.appendChild(img);
            this.tileEls.set(key, img);
          }
          img.style.transform = `translate(${Math.round(x * TILE - left)}px,${Math.round(y * TILE - top)}px)`;
        }
      }
      for (const [key, img] of this.tileEls) if (!want.has(key)) { img.remove(); this.tileEls.delete(key); }
      for (const m of this.markers) {
        const p = project(m.lat, m.lng, z);
        m.el.style.transform = `translate(${p.x - left}px,${p.y - top}px)`;
      }
      this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      this.svg.innerHTML = this.lines.map((l) => {
        const d = l.pts.map((q, i) => { const p = project(q.lat, q.lng, z); return `${i ? 'L' : 'M'}${(p.x - left).toFixed(1)} ${(p.y - top).toFixed(1)}`; }).join('');
        return `<path d="${d}" class="tm-casing"/><path d="${d}" class="tm-stroke${l.dashed ? ' dashed' : ''}"/>`;
      }).join('');
    }

    // ----- gestures -----
    zoomAt(dir, px, py) {
      const nz = clamp(this.z + dir, MIN_Z, MAX_Z);
      if (nz === this.z) return;
      this.measure();
      const ax = px ?? this.w / 2, ay = py ?? this.h / 2;
      const c = project(this.center.lat, this.center.lng, this.z);
      const under = unproject(c.x + (ax - this.w / 2), c.y + (ay - this.h / 2), this.z);
      const u = project(under.lat, under.lng, nz);
      this.center = unproject(u.x - (ax - this.w / 2), u.y - (ay - this.h / 2), nz);
      this.z = nz;
      this.render();
      this.settle();
    }
    settle() { clearTimeout(this.timer); this.timer = setTimeout(() => this.emit('moveend'), 250); }
    bind() {
      const el = this.el, signal = this.abort.signal, ptrs = new Map();
      let moved = false, pinch = 0;
      const gap = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
      const mid = () => { const [a, b] = [...ptrs.values()], r = el.getBoundingClientRect(); return { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }; };
      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.tm-ctrl, .tm-attr')) return;
        el.setPointerCapture(e.pointerId);
        ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
        moved = false;
        if (ptrs.size === 2) pinch = gap();
      }, { signal });
      el.addEventListener('pointermove', (e) => {
        const p = ptrs.get(e.pointerId);
        if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (ptrs.size === 2) {
          const g = gap(), m = mid();
          if (g / pinch > 1.6) { this.zoomAt(1, m.x, m.y); pinch = g; } else if (g / pinch < 0.62) { this.zoomAt(-1, m.x, m.y); pinch = g; }
          moved = true;
        } else if (ptrs.size === 1 && (dx || dy)) {
          moved = true;
          const c = project(this.center.lat, this.center.lng, this.z);
          this.center = unproject(c.x - dx, c.y - dy, this.z);
          this.render();
        }
      }, { signal });
      const end = (e) => {
        if (!ptrs.delete(e.pointerId)) return;
        if (ptrs.size < 2) pinch = 0;
        if (!ptrs.size && moved) this.settle();
      };
      el.addEventListener('pointerup', end, { signal });
      el.addEventListener('pointercancel', end, { signal });
      let wheelAt = 0;
      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (Date.now() - wheelAt < 180) return;
        wheelAt = Date.now();
        const r = el.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false, signal });
      el.addEventListener('click', (e) => {
        const b = e.target.closest('.tm-ctrl button');
        if (b) this.zoomAt(Number(b.dataset.z));
      }, { signal });
    }

    destroy() {
      this.abort.abort();
      clearTimeout(this.timer);
      this.ro && this.ro.disconnect();
      this.el.innerHTML = '';
      this.el.classList.remove('tmap');
    }
  }

  TileMap.project = project;
  TileMap.unproject = unproject;
  if (typeof window !== 'undefined') window.TileMap = TileMap;
  if (typeof module !== 'undefined') module.exports = { project, unproject };
})();
