'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const els = {
    fileName: $('fileName'), counter: $('counter'), counterText: $('counterText'), jump: $('jumpInput'),
    search: $('search'), results: $('results'),
    viewer: null, pages: null, stage: $('stage'), empty: $('empty'), error: $('error'), status: $('status'),
    errorTitle: $('errorTitle'), errorFile: $('errorFile'), errorMsg: $('errorMsg'),
    prev: $('prev'), next: $('next'), pageInd: $('pageInd'), veil: $('dropVeil'),
    zoomVal: $('zoomVal'),
  };

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.min.js';
  }

  /* ---------------- settings ---------------- */
  const LS_KEY = 'pdfviewer.settings';
  const settings = { theme: null, zoom: 'width' };
  try { Object.assign(settings, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (_) {}
  function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (_) {} }

  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
  if (settings.theme !== 'dark' && settings.theme !== 'light') {
    settings.theme = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(settings.theme);
  $('themeToggle').addEventListener('click', () => {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    applyTheme(settings.theme); saveSettings();
  });

  /* ---------------- file list ---------------- */
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const cmp = (a, b) => collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  let files = [];            // [{path,name}] sorted
  let current = -1;          // index into files
  let sources = [];          // ROOT paths (folders / files) that were opened; this is what the session stores
  const MAX_SOURCES = 300;

  function noteSources(roots) {
    for (const r of roots || []) {
      if (typeof r === 'string' && r && !sources.includes(r) && sources.length < MAX_SOURCES) sources.push(r);
    }
    saveSessionSoon();
  }

  function addItems(items, restoreScroll) {
    if (!items || !items.length) return;
    const curPath = current >= 0 ? files[current].path : null;
    const seen = new Set(files.map((f) => f.path));
    let added = 0;
    for (const it of items) {
      if (!it || !it.path || seen.has(it.path)) continue;
      seen.add(it.path);
      files.push({ path: it.path, name: it.name || String(it.path).split(/[\\/]/).pop() });
      added++;
    }
    if (!added) return;
    files.sort(cmp);
    if (curPath) {
      current = files.findIndex((f) => f.path === curPath);
      updateChrome();
      refreshPreload();
      saveSessionSoon();
      if (els.search.value) runSearch();
    } else {
      go(0);
      if (els.search.value) runSearch();
    }
  }

  async function withPaths(paths) {
    if (!api || !paths || !paths.length) return;
    try {
      const items = await api.resolvePaths(paths);
      if (items && items.length) noteSources(paths);
      addItems(items);
    } catch (e) { flash('Could not read those items'); }
  }
  async function pickVia(fn) {
    const items = await fn();
    if (items && items.length) {
      let roots = [];
      try { if (api.lastRoots) roots = await api.lastRoots(); } catch (_) {}
      if (!roots || !roots.length) roots = items.length <= 200 ? items.map((i) => i.path) : [];
      noteSources(roots);
    }
    addItems(items);
  }
  async function doOpenFolder() { try { await pickVia(() => api.openFolder()); } catch (e) { flash('Could not open folder'); } }
  async function doOpenFiles() { try { await pickVia(() => api.openFiles()); } catch (e) { flash('Could not open files'); } }

  /* ---------------- session persistence ---------------- */
  const SESSION_KEY = 'pdfviewer.session';
  let curScroll = { page: 1, frac: 0 };   // scroll position inside the current file
  let pendingRestore = null;               // scroll target to apply when the current file opens
  let launchOverride = false;              // OS launch args seen: they win over the restored session
  let sessionTimer = 0;

  function saveSession() {
    clearTimeout(sessionTimer); sessionTimer = 0;
    try {
      if (!files.length || current < 0) { localStorage.removeItem(SESSION_KEY); return; }
      if (V && !V.staging && !V.dead) {
        curScroll = V.restoreTarget ? V.restoreTarget : scrollPos(V);
      }
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        v: 1, sources, path: files[current].path, idx: current, page: curScroll.page, frac: curScroll.frac,
      }));
    } catch (_) {}
  }
  function saveSessionSoon() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 400);
  }
  window.addEventListener('beforeunload', saveSession);
  window.addEventListener('pagehide', saveSession);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });

  async function restoreSession() {
    try {
      if (!api) return;
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s || !Array.isArray(s.sources) || !s.sources.length) return;
      const roots = s.sources.filter((x) => typeof x === 'string' && x).slice(0, MAX_SOURCES);
      const items = await api.resolvePaths(roots);
      if (launchOverride || files.length || !items || !items.length) return;   // user/OS already opened something
      sources = roots;
      const list = [];
      const seen = new Set();
      for (const it of items) {
        if (!it || !it.path || seen.has(it.path)) continue;
        seen.add(it.path);
        list.push({ path: it.path, name: it.name || String(it.path).split(/[\\/]/).pop() });
      }
      list.sort(cmp);
      if (!list.length) return;
      files = list;
      let idx = files.findIndex((f) => f.path === s.path);
      let rs = null;
      if (idx >= 0) {
        const page = Math.max(1, s.page | 0), frac = Math.min(1, Math.max(0, +s.frac || 0));
        if (page > 1 || frac > 0) rs = { page, frac };
      } else {
        idx = Math.min(files.length - 1, Math.max(0, s.idx | 0));   // file is gone: nearest index
      }
      go(idx, rs);
    } catch (_) { /* fall back to the empty state silently */ }
  }

  function closeAll() {
    navToken++;
    files = []; current = -1; sources = [];
    curScroll = { page: 1, frac: 0 }; pendingRestore = null;
    discardView(V); V = null;
    discardView(frozen); frozen = null;
    pruneCache(new Set());
    els.error.hidden = true; els.pageInd.hidden = true; setStatus('');
    els.search.value = ''; closeResults();
    updateChrome();
    saveSession();
  }

  /* ---------------- doc cache (current +/- 1 only) ---------------- */
  const cache = new Map();   // path -> {promise, doc, dead, first:{canvas,scale,dpr}|null}
  function getEntry(path) {
    let e = cache.get(path);
    if (e) return e;
    e = { promise: null, doc: null, dead: false, first: null, firstBusy: false, firstSlot: null };
    e.promise = (async () => {
      const data = await api.readFile(path);
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      const task = pdfjsLib.getDocument({
        data: u8,
        isEvalSupported: false,
        cMapUrl: '../node_modules/pdfjs-dist/cmaps/', cMapPacked: true,
        standardFontDataUrl: '../node_modules/pdfjs-dist/standard_fonts/',
      });
      const doc = await task.promise;
      if (e.dead) { doc.destroy(); throw new Error('discarded'); }
      e.doc = doc;
      return doc;
    })();
    e.promise.catch(() => {});
    cache.set(path, e);
    return e;
  }
  function freeFirst(e) {
    if (e.firstSlot && e.firstSlot.task) { try { e.firstSlot.task.cancel(); } catch (_) {} }
    if (e.first) { e.first.canvas.width = 0; e.first.canvas.height = 0; e.first = null; }
  }
  function pruneCache(keep) {
    for (const [p, e] of cache) {
      if (keep.has(p)) continue;
      e.dead = true;
      cache.delete(p);
      freeFirst(e);
      if (e.doc) { try { e.doc.destroy(); } catch (_) {} }
    }
  }
  function refreshPreload() {
    if (current < 0) return;
    const keep = new Set();
    for (const i of [current - 1, current, current + 1]) if (files[i]) keep.add(files[i].path);
    pruneCache(keep);
  }
  function preloadNeighbours() {
    for (const i of [current + 1, current - 1]) {
      if (!files[i]) continue;
      const e = getEntry(files[i].path);
      prerenderFirst(e);
    }
  }
  // Render page 1 of a preloaded neighbour at the current zoom so an arrow flip can swap instantly.
  async function prerenderFirst(e) {
    if (e.first || e.firstBusy || e.dead) return;
    e.firstBusy = true;
    let page = null, canvas = null;
    try {
      const doc = await e.promise;
      if (e.dead) return;
      page = await doc.getPage(1);
      if (e.dead) return;
      const [w, h] = pageSize(page);
      const scale = computeScaleFor(w, h);
      e.firstSlot = {};
      canvas = await paint(page, scale, e.firstSlot);
      if (e.dead) { canvas.width = 0; canvas = null; return; }
      e.first = { canvas, scale, dpr: window.devicePixelRatio || 1 };
      canvas = null;
    } catch (_) { /* ignore: normal render path will handle it */ }
    finally {
      if (canvas) canvas.width = 0;
      if (page) { try { page.cleanup(); } catch (_) {} }
      e.firstBusy = false; e.firstSlot = null;
    }
  }

  /* ---------------- navigation ---------------- */
  let navToken = 0;
  function go(i, restoreScroll) {
    if (i < 0 || i >= files.length) return;
    current = i;
    curScroll = restoreScroll || { page: 1, frac: 0 };
    pendingRestore = restoreScroll || null;
    updateChrome();
    refreshPreload();
    saveSessionSoon();
    openCurrent();
  }
  const prevFile = () => { if (current > 0) go(current - 1); };
  const nextFile = () => { if (current >= 0 && current < files.length - 1) go(current + 1); };

  function updateChrome() {
    const n = files.length;
    const has = current >= 0 && n > 0;
    els.empty.hidden = n > 0;
    els.counter.hidden = !has;
    $('btnClose').hidden = !has;
    if (!els.jump.hidden && !has) els.jump.hidden = true;
    els.prev.hidden = els.next.hidden = !has;
    els.prev.disabled = !has || current <= 0;
    els.next.disabled = !has || current >= n - 1;
    if (has) {
      const f = files[current];
      els.fileName.textContent = f.name;
      els.fileName.title = f.path;
      document.title = f.name;
      els.counterText.textContent = (current + 1) + ' / ' + n;
    } else {
      els.fileName.textContent = 'No file open';
      els.fileName.title = '';
      document.title = 'PDF Viewer';
    }
  }

  /* ---------------- viewer (double-buffered) ----------------
     V       = the view being built (staging, hidden) or the live one.
     frozen  = the previous file's view: stays on screen, inert, until V's first page is painted. */
  let V = null;
  let frozen = null;
  const MAX_CANVAS_PIXELS = 24e6;

  function setStatus(msg) {
    if (!msg) { els.status.hidden = true; return; }
    els.status.textContent = msg; els.status.hidden = false;
  }
  let flashTimer = 0;
  function flash(msg) { setStatus(msg); clearTimeout(flashTimer); flashTimer = setTimeout(() => setStatus(''), 3000); }

  function stopView(v) {
    v.dead = true;
    v.near.clear();
    if (v.io1) v.io1.disconnect();
    if (v.io2) v.io2.disconnect();
    clearTimeout(v.swapTimer);
    for (const p of v.pages) cancelPage(p);
  }
  function discardView(v) {
    if (!v) return;
    stopView(v);
    for (const p of v.pages) if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas = null; }
    v.scroller.remove();
    if (v === V) els.pageInd.hidden = true;
  }
  // Called at the start of every navigation: keep what is on screen, stop it working.
  function retireView() {
    if (!V) return;
    if (V.staging) discardView(V);
    else { if (frozen) discardView(frozen); frozen = V; stopView(V); }
    V = null;
    els.pageInd.hidden = true;
  }
  function cancelPage(p) {
    if (p.task) { try { p.task.cancel(); } catch (_) {} p.task = null; }
    p.rendering = false;
  }
  function freeCanvas(p) {
    cancelPage(p);
    p.token++;
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.rscale = 0;
  }

  function showError(f, err) {
    discardView(V); V = null;
    discardView(frozen); frozen = null;
    let title = 'Can’t open this PDF', msg = '';
    const name = err && err.name;
    if (name === 'PasswordException') { title = 'Password-protected PDF'; msg = 'This file is encrypted and can’t be shown.'; }
    else if (name === 'InvalidPDFException') { msg = 'The file is damaged or is not a PDF.'; }
    else if (name === 'MissingPDFException') { msg = 'The file could not be found.'; }
    else { msg = (err && err.message) ? String(err.message) : 'Unknown error.'; }
    els.errorTitle.textContent = title;
    els.errorFile.textContent = f.name;
    els.errorMsg.textContent = msg;
    els.error.hidden = false;
    setStatus('');
  }

  async function openCurrent() {
    const token = ++navToken;
    const f = files[current];
    const restore = pendingRestore; pendingRestore = null;
    retireView();
    els.error.hidden = true;
    const slow = setTimeout(() => { if (token === navToken) setStatus('Loading…'); }, 160);
    try {
      const entry = getEntry(f.path);
      const doc = await entry.promise;
      if (token !== navToken) return;
      const first = await doc.getPage(1);
      if (token !== navToken) { first.cleanup(); return; }
      buildViewer(doc, first, token, entry, f.path, restore);
    } catch (err) {
      if (token !== navToken) return;
      cache.delete(f.path);
      showError(f, err);
      preloadNeighbours();
    } finally {
      clearTimeout(slow);
    }
  }

  function pageSize(page) {
    const v = page.getViewport({ scale: 1 });
    return [v.width, v.height];
  }

  function makeScroller() {
    const sc = document.createElement('div');
    sc.className = 'viewer staging';
    sc.tabIndex = 0;
    sc.setAttribute('aria-label', 'PDF pages');
    const pg = document.createElement('div');
    pg.className = 'pages';
    sc.appendChild(pg);
    sc.addEventListener('wheel', (e) => {
      if (V) V.restoreTarget = null;
      if (!e.ctrlKey) return;
      e.preventDefault();
      stepZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
    sc.addEventListener('scroll', () => {
      if (!V || V.scroller !== sc) return;
      onScroll(); pump(); saveSessionSoon();
      clearTimeout(sweepTimer); sweepTimer = setTimeout(sweep, 250);
    }, { passive: true });
    sc.addEventListener('mousedown', () => { if (V) V.restoreTarget = null; if (document.activeElement !== sc) sc.focus({ preventScroll: true }); });
    sc.addEventListener('touchstart', () => { if (V) V.restoreTarget = null; }, { passive: true });
    els.stage.insertBefore(sc, els.stage.firstChild);
    return { sc, pg };
  }

  function buildViewer(doc, first, token, entry, path, restore) {
    const n = doc.numPages;
    const [w1, h1] = pageSize(first);
    first.cleanup();
    const { sc, pg } = makeScroller();
    V = {
      doc, token, n, path, entry, scroller: sc, pagesEl: pg, staging: true, pages: [], near: new Set(), scale: 1, gen: 0,
      dead: false, queue: [], active: 0, w1, h1, io1: null, io2: null, restoreTarget: restore, swapTimer: 0,
    };
    const view = V;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.n = String(i + 1);
      const p = { n: i + 1, el, w: w1, h: h1, sized: i === 0, canvas: null, task: null, rendering: false, rscale: 0, token: 0 };
      view.pages.push(p);
      frag.appendChild(el);
    }
    pg.appendChild(frag);
    view.scale = computeScale();
    applySizes();
    if (restore) applyRestore(view); else sc.scrollTop = 0;

    // Page 1 pre-rendered while this file was a neighbour: adopt it, no render needed.
    const fc = entry && entry.first;
    const p1 = view.pages[0];
    if (fc && fc.dpr === (window.devicePixelRatio || 1) && Math.abs(fc.scale - view.scale) / view.scale < 0.015) {
      entry.first = null;
      p1.canvas = fc.canvas; p1.rscale = view.scale;
      p1.el.appendChild(fc.canvas);
    } else if (fc) freeFirst(entry);

    view.io1 = new IntersectionObserver((entries) => {
      if (view.dead) return;
      for (const en of entries) {
        const n1 = +en.target.dataset.n;
        if (en.isIntersecting) { view.near.add(n1); queueRender(view, n1); }
        else view.near.delete(n1);
      }
      pump();
    }, { root: sc, rootMargin: '120% 0px 120% 0px' });
    view.io2 = new IntersectionObserver((entries) => {
      if (view.dead) return;
      for (const en of entries) {
        if (en.isIntersecting) continue;
        const p = view.pages[+en.target.dataset.n - 1];
        if (p.canvas || p.rendering) freeCanvas(p);
      }
    }, { root: sc, rootMargin: '350% 0px 350% 0px' });
    for (const p of view.pages) { view.io1.observe(p.el); view.io2.observe(p.el); }
    view.swapTimer = setTimeout(() => swapIn(view), 4000);   // never stay hidden forever
    if (p1.canvas && (!restore || restore.page === 1)) swapIn(view);
    if (n > 1) measureRest(view);
  }

  // Reveal the staged view once something is painted; drop the frozen one. Page-1 bitmap of the
  // old file is handed back to its cache entry (if still a neighbour) so flipping back is instant.
  function swapIn(view) {
    if (view !== V || view.dead || !view.staging) return;
    clearTimeout(view.swapTimer);
    view.staging = false;
    view.scroller.classList.remove('staging');
    const old = frozen; frozen = null;
    if (old) {
      const e = old.entry, p1 = old.pages[0];
      if (e && cache.get(old.path) === e && !e.dead && !e.first && p1 && p1.canvas && p1.rscale === old.scale) {
        p1.canvas.remove();
        e.first = { canvas: p1.canvas, scale: old.scale, dpr: window.devicePixelRatio || 1 };
        p1.canvas = null;
      }
      discardView(old);
    }
    for (const el of document.querySelectorAll('#viewer, #pages')) el.removeAttribute('id');
    view.scroller.id = 'viewer'; view.pagesEl.id = 'pages';
    view.scroller.dataset.path = view.path;
    els.viewer = view.scroller; els.pages = view.pagesEl;
    updateZoomLabel();
    setStatus('');
    onScroll();
    if (!isTyping(document.activeElement)) view.scroller.focus({ preventScroll: true });
    preloadNeighbours();
  }

  function scrollPos(v) {
    const st = v.scroller.scrollTop;
    if (st <= 0) return { page: 1, frac: 0 };
    let lo = 0, hi = v.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (v.pages[m].el.offsetTop <= st) lo = m; else hi = m - 1;
    }
    const el = v.pages[lo].el;
    const frac = el.offsetHeight > 0 ? Math.min(1, Math.max(0, (st - el.offsetTop) / el.offsetHeight)) : 0;
    return { page: lo + 1, frac };
  }
  function applyRestore(view) {
    const t = view.restoreTarget;
    if (!t) return;
    const p = view.pages[Math.min(view.n, Math.max(1, t.page)) - 1];
    view.scroller.scrollTop = (t.page === 1 && t.frac === 0) ? 0 : p.el.offsetTop + t.frac * p.el.offsetHeight;
  }

  // Learn real page sizes in the background (cheap; no rendering).
  async function measureRest(view) {
    let changed = false;
    for (let i = 2; i <= view.n; i++) {
      if (view.dead) return;
      try {
        const page = await view.doc.getPage(i);
        if (view.dead) return;
        const [w, h] = pageSize(page);
        page.cleanup();
        const p = view.pages[i - 1];
        p.sized = true;
        if (Math.abs(w - p.w) > 0.5 || Math.abs(h - p.h) > 0.5) {
          p.w = w; p.h = h; changed = true; sizePage(view, p);
          if (view.near.has(i)) { p.rscale = 0; queueRender(view, i); }   // keep old canvas until the new one is drawn
        }
      } catch (_) { return; }
      if (i % 25 === 0) { if (changed) { applyRestore(view); pump(); } await new Promise((r) => setTimeout(r, 0)); }
    }
    if (changed) applyRestore(view);
    pump();
  }

  function sizePage(view, p) {
    p.el.style.width = Math.round(p.w * view.scale) + 'px';
    p.el.style.height = Math.round(p.h * view.scale) + 'px';
  }
  function applySizes() { for (const p of V.pages) sizePage(V, p); }

  /* ---------------- rendering queue ---------------- */
  function queueRender(view, n) {
    const p = view.pages[n - 1];
    if (p.rendering) return;
    if (p.canvas && p.rscale === view.scale) return;
    if (!view.queue.includes(n)) view.queue.push(n);
  }
  function currentPageNo() {
    if (!V) return 1;
    const mid = V.scroller.scrollTop + V.scroller.clientHeight / 3;
    let lo = 0, hi = V.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (V.pages[m].el.offsetTop <= mid) lo = m; else hi = m - 1;
    }
    return lo + 1;
  }
  function pump() {
    if (!V || V.dead) return;
    while (V.active < 2 && V.queue.length) {
      const cur = currentPageNo();
      let bi = 0, bd = Infinity;
      for (let i = 0; i < V.queue.length; i++) {
        const d = Math.abs(V.queue[i] - cur);
        if (d < bd) { bd = d; bi = i; }
      }
      const n = V.queue.splice(bi, 1)[0];
      if (!V.near.has(n)) continue;
      renderPage(V, V.pages[n - 1]);
    }
  }
  // Draw one page into a fresh canvas. slot.task receives the render task (for cancel).
  async function paint(page, scale, slot) {
    const vp = page.getViewport({ scale });
    let dpr = window.devicePixelRatio || 1;
    const px = vp.width * vp.height * dpr * dpr;
    if (px > MAX_CANVAS_PIXELS) dpr *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width * dpr));
    canvas.height = Math.max(1, Math.floor(vp.height * dpr));
    try {
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      slot.task = page.render({ canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0], background: '#ffffff' });
      await slot.task.promise;
    } catch (err) { canvas.width = 0; throw err; }
    return canvas;
  }
  async function renderPage(view, p) {
    if (p.rendering) return;
    p.rendering = true; view.active++;
    const myTok = ++p.token, scale = view.scale, gen = view.gen;
    let page = null, canvas = null;
    try {
      page = await view.doc.getPage(p.n);
      if (view.dead || myTok !== p.token) return;
      canvas = await paint(page, scale, p);
      if (view.dead || myTok !== p.token || gen !== view.gen) { canvas.width = 0; canvas = null; return; }
      // swap old canvas for the new one in the same task: no frame without content
      if (p.canvas) { p.canvas.width = 0; p.canvas.remove(); }
      p.canvas = canvas; canvas = null; p.rscale = scale;
      p.el.appendChild(p.canvas);
      if (view.staging) swapIn(view);
    } catch (err) {
      if (!(err && err.name === 'RenderingCancelledException')) {
        if (!view.dead && myTok === p.token) console.warn('page render failed', p.n, err && err.message);
        if (!view.dead && view.staging) swapIn(view);   // don't hang on a page that cannot render
      }
    } finally {
      if (canvas) canvas.width = 0;
      if (page) { try { page.cleanup(); } catch (_) {} }
      if (myTok === p.token) { p.task = null; p.rendering = false; }
      view.active--;
      if (!view.dead) {
        if (view.near.has(p.n) && p.rscale !== view.scale) queueRender(view, p.n);
        pump();
      }
    }
  }

  /* ---------------- zoom ---------------- */
  const MIN_Z = 0.1, MAX_Z = 6;
  function computeScaleFor(w1, h1) {
    const host = V ? V.scroller : els.stage;
    const pe = V ? V.pagesEl : null;
    let pl = 22, pr = 22;
    if (pe) { const cs = getComputedStyle(pe); pl = parseFloat(cs.paddingLeft) || 0; pr = parseFloat(cs.paddingRight) || 0; }
    const availW = host.clientWidth - pl - pr;
    const availH = host.clientHeight - 44;
    let s;
    if (settings.zoom === 'page') s = Math.min(availW / w1, availH / h1);
    else if (settings.zoom === 'width') s = availW / w1;
    else s = +settings.zoom || 1;
    return Math.min(MAX_Z, Math.max(MIN_Z, s || 1));
  }
  function computeScale() {
    if (!V) return 1;
    return computeScaleFor(V.w1, V.h1);
  }
  function updateZoomLabel() {
    const s = V ? V.scale : 1;
    els.zoomVal.textContent = Math.round(s * 100) + '%';
  }
  let zoomTimer = 0;
  function setZoom(mode) {
    settings.zoom = typeof mode === 'number' ? Math.min(MAX_Z, Math.max(MIN_Z, mode)) : mode;
    saveSettings();
    relayout();
  }
  function relayout() {
    if (!V) return;
    const v = V.scroller;
    const ratio = v.scrollHeight > 0 ? v.scrollTop / v.scrollHeight : 0;
    const ratioX = v.scrollWidth > 0 ? (v.scrollLeft + v.clientWidth / 2) / v.scrollWidth : 0.5;
    V.scale = computeScale();
    applySizes();
    updateZoomLabel();
    v.scrollTop = ratio * v.scrollHeight;
    v.scrollLeft = Math.max(0, ratioX * v.scrollWidth - v.clientWidth / 2);
    // stale neighbour bitmaps no longer match: drop them, they re-render lazily
    for (const e of cache.values()) freeFirst(e);
    clearTimeout(zoomTimer);
    const view = V;
    zoomTimer = setTimeout(() => {
      if (V !== view) return;
      view.gen++;
      view.queue.length = 0;
      for (const p of view.pages) {
        // keep the old canvas (CSS-stretched) until the re-render replaces it: no blank frame
        if (view.near.has(p.n)) { if (p.rendering) cancelPage(p); queueRender(view, p.n); }
        else freeCanvas(p);
      }
      pump();
      if (!view.staging) preloadNeighbours();
    }, 140);
  }
  function stepZoom(f) { setZoom(+(V ? V.scale : 1) * f); }
  window.addEventListener('resize', () => {
    if (V && (settings.zoom === 'width' || settings.zoom === 'page')) relayout();
  });

  /* page indicator */
  let rafScroll = 0, indTimer = 0;
  function onScroll() {
    if (rafScroll) return;
    rafScroll = requestAnimationFrame(() => {
      rafScroll = 0;
      if (!V || V.staging || V.n < 2) { els.pageInd.hidden = true; return; }
      els.pageInd.textContent = 'Page ' + currentPageNo() + ' / ' + V.n;
      els.pageInd.hidden = false;
      clearTimeout(indTimer);
      indTimer = setTimeout(() => { els.pageInd.hidden = true; }, 1600);
    });
  }
  // Safety net next to the far IntersectionObserver: drop canvases that are far from the viewport.
  let sweepTimer = 0;
  function sweep() {
    if (!V || V.dead) return;
    const v = V.scroller, H = v.clientHeight, top = v.scrollTop - 3.5 * H, bot = v.scrollTop + 4.5 * H;
    for (const p of V.pages) {
      if (!p.canvas && !p.rendering) continue;
      const t = p.el.offsetTop, b = t + p.el.offsetHeight;
      if (b < top || t > bot) freeCanvas(p);
    }
  }

  /* ---------------- search ---------------- */
  const MAX_RESULTS = 200;
  let results = [];      // indices into files
  let activeRes = 0;
  function runSearch() {
    const q = els.search.value.trim().toLowerCase();
    if (!q) { closeResults(); return; }
    const numeric = /^\d+$/.test(q);
    const qn = numeric ? Number(q) : 0;
    const b0 = [], b1 = [], b2 = [];
    for (let i = 0; i < files.length; i++) {
      const name = files[i].name.toLowerCase();
      if (name.indexOf(q) === -1) continue;
      if (numeric) {
        const m = /^\s*(\d+)/.exec(name);
        if (m && Number(m[1]) === qn) b0.push(i);
        else if (name.startsWith(q)) b1.push(i);
        else b2.push(i);
      } else if (name.startsWith(q)) b0.push(i); else b1.push(i);
    }
    results = b0.concat(b1, b2);
    activeRes = 0;
    renderResults();
  }
  function renderResults() {
    const ul = els.results;
    ul.textContent = '';
    const frag = document.createDocumentFragment();
    const shown = Math.min(results.length, MAX_RESULTS);
    for (let k = 0; k < shown; k++) {
      const li = document.createElement('li');
      li.id = 'res-' + k;
      li.setAttribute('role', 'option');
      li.dataset.k = String(k);
      li.setAttribute('aria-selected', k === activeRes ? 'true' : 'false');
      const a = document.createElement('span'); a.className = 'n'; a.textContent = files[results[k]].name;
      const b = document.createElement('span'); b.className = 'i'; b.textContent = '#' + (results[k] + 1);
      li.append(a, b);
      frag.appendChild(li);
    }
    if (!results.length) {
      const li = document.createElement('li'); li.className = 'none'; li.textContent = 'No matching files'; frag.appendChild(li);
    } else if (results.length > shown) {
      const li = document.createElement('li'); li.className = 'more';
      li.textContent = 'Showing ' + shown + ' of ' + results.length + ' — keep typing to narrow';
      frag.appendChild(li);
    }
    ul.appendChild(frag);
    ul.hidden = false;
    els.search.setAttribute('aria-expanded', 'true');
    syncActive();
  }
  function syncActive() {
    const items = els.results.querySelectorAll('li[role=option]');
    items.forEach((li, k) => li.setAttribute('aria-selected', k === activeRes ? 'true' : 'false'));
    const el = items[activeRes];
    if (el) { el.scrollIntoView({ block: 'nearest' }); els.search.setAttribute('aria-activedescendant', el.id); }
    else els.search.removeAttribute('aria-activedescendant');
  }
  function closeResults() {
    els.results.hidden = true; results = [];
    els.search.setAttribute('aria-expanded', 'false');
    els.search.removeAttribute('aria-activedescendant');
  }
  function chooseResult(k) {
    if (results[k] == null) return;
    const idx = results[k];
    els.search.value = '';
    closeResults();
    els.search.blur();
    go(idx);
    focusViewer();
  }
  els.search.addEventListener('input', runSearch);
  els.search.addEventListener('focus', () => { if (els.search.value) runSearch(); });
  els.search.addEventListener('keydown', (e) => {
    const shown = Math.min(results.length, MAX_RESULTS);
    if (e.key === 'ArrowDown') { e.preventDefault(); if (shown) { activeRes = (activeRes + 1) % shown; syncActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (shown) { activeRes = (activeRes - 1 + shown) % shown; syncActive(); } }
    else if (e.key === 'Enter') { e.preventDefault(); chooseResult(activeRes); }
    else if (e.key === 'Escape') { e.preventDefault(); els.search.value = ''; closeResults(); els.search.blur(); focusViewer(); }
  });
  els.results.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const li = e.target.closest('li[role=option]');
    if (li) chooseResult(+li.dataset.k);
  });
  els.results.addEventListener('mousemove', (e) => {
    const li = e.target.closest('li[role=option]');
    if (li && +li.dataset.k !== activeRes) { activeRes = +li.dataset.k; syncActive(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.search')) closeResults();
  });
  els.search.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== els.search) closeResults(); }, 120); });

  /* ---------------- jump to index ---------------- */
  function openJump() {
    if (current < 0) return;
    els.counter.hidden = true; els.jump.hidden = false;
    els.jump.value = String(current + 1);
    els.jump.focus(); els.jump.select();
  }
  function closeJump() {
    if (els.jump.hidden) return;
    els.jump.hidden = true;
    els.counter.hidden = !(files.length > 0);
  }
  els.counter.addEventListener('click', openJump);
  els.jump.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = parseInt(els.jump.value, 10);
      closeJump();
      if (Number.isFinite(v) && files.length) go(Math.min(files.length, Math.max(1, v)) - 1);
      focusViewer();
    } else if (e.key === 'Escape') { e.preventDefault(); closeJump(); focusViewer(); }
  });
  els.jump.addEventListener('input', () => { els.jump.value = els.jump.value.replace(/[^\d]/g, ''); });
  els.jump.addEventListener('blur', closeJump);

  /* ---------------- buttons & keys ---------------- */
  $('btnFolder').addEventListener('click', doOpenFolder);
  $('btnFiles').addEventListener('click', doOpenFiles);
  $('emptyFolder').addEventListener('click', doOpenFolder);
  $('emptyFiles').addEventListener('click', doOpenFiles);
  els.prev.addEventListener('click', prevFile);
  els.next.addEventListener('click', nextFile);
  $('zoomIn').addEventListener('click', () => stepZoom(1.2));
  $('zoomOut').addEventListener('click', () => stepZoom(1 / 1.2));
  $('fitWidth').addEventListener('click', () => setZoom('width'));
  $('fitPage').addEventListener('click', () => setZoom('page'));

  function focusViewer() { if (V && V.scroller) V.scroller.focus({ preventScroll: true }); else if (els.viewer) els.viewer.focus({ preventScroll: true }); }
  function isTyping(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (e.ctrlKey || e.metaKey) {
      const lk = k.toLowerCase();
      if (lk === 'o') { e.preventDefault(); e.shiftKey ? doOpenFolder() : doOpenFiles(); return; }
      if (lk === 'f') { e.preventDefault(); els.search.focus(); els.search.select(); return; }
      if (k === '=' || k === '+') { e.preventDefault(); stepZoom(1.2); return; }
      if (k === '-' || k === '_') { e.preventDefault(); stepZoom(1 / 1.2); return; }
      if (k === '0') { e.preventDefault(); setZoom('width'); return; }
      return;
    }
    if (isTyping(e.target)) return;
    if (e.altKey || e.shiftKey) return;
    if (k === 'ArrowLeft') { e.preventDefault(); prevFile(); }
    else if (k === 'ArrowRight') { e.preventDefault(); nextFile(); }
  });

  /* ---------------- drag & drop ---------------- */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.veil.hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.veil.hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; els.veil.hidden = true;
    const paths = [];
    for (const f of Array.from(e.dataTransfer.files || [])) {
      try { const p = api.getPathForFile(f); if (p) paths.push(p); } catch (_) {}
    }
    withPaths(paths);
  });

  if (api && api.onOpenPaths) api.onOpenPaths((paths, meta) => {
    if (meta && meta.launch) {            // OS launch / Open-with args win over the restored session
      launchOverride = true;
      if (files.length) closeAll();
    }
    withPaths(paths);
  });
  $('btnClose').addEventListener('click', closeAll);

  // Update toast: manual "Check for updates" + background download status
  const updateToast = document.getElementById('updateToast');
  const updateMsg = document.getElementById('updateMsg');
  const updateRestart = document.getElementById('updateRestart');
  let toastTimer = 0;
  function toast(msg, opts) {
    if (!updateToast) return;
    opts = opts || {};
    updateMsg.textContent = msg;
    updateRestart.hidden = !opts.restart;
    updateToast.hidden = false;
    clearTimeout(toastTimer);
    if (opts.ms) toastTimer = setTimeout(() => { updateToast.hidden = true; }, opts.ms);
  }
  let manualUpdate = false;   // only react to checking/not-available/error after a click
  const onUpdateStatus = (s) => {
    if (!s) return;
    if (s.state === 'downloaded') { manualUpdate = false; toast('Update ready - Restart to install', { restart: true }); }
    else if (s.state === 'available') { if (manualUpdate) toast('Update found - downloading...'); }
    else if (s.state === 'checking') { if (manualUpdate) toast('Checking...'); }
    else if (s.state === 'not-available') { if (manualUpdate) toast("You're up to date" + (s.version ? ' (v' + s.version + ')' : ''), { ms: 4000 }); manualUpdate = false; }
    else if (s.state === 'error') { if (manualUpdate) toast("Couldn't check for updates", { ms: 5000 }); manualUpdate = false; }
  };
  if (api && api.onUpdateStatus) api.onUpdateStatus(onUpdateStatus);
  window.addEventListener('pdfv-update-status', (e) => onUpdateStatus(e.detail));
  updateRestart?.addEventListener('click', () => api.installUpdate());
  document.getElementById('updateDismiss')?.addEventListener('click', () => { updateToast.hidden = true; });
  $('btnUpdate').addEventListener('click', async () => {
    if (!api || !api.checkForUpdates) { toast('Updates unavailable in portable/dev build', { ms: 4000 }); return; }
    manualUpdate = true;
    toast('Checking...');
    try {
      const r = await api.checkForUpdates();
      if (r && r.state === 'unavailable') { manualUpdate = false; toast('Updates unavailable in portable/dev build', { ms: 4000 }); }
      else if (r && r.state === 'error') { manualUpdate = false; toast("Couldn't check for updates", { ms: 5000 }); }
    } catch (_) { manualUpdate = false; toast("Couldn't check for updates", { ms: 5000 }); }
  });

  window.addEventListener('beforeunload', () => { pruneCache(new Set()); });

  updateChrome();
  updateZoomLabel();
  restoreSession();
})();
