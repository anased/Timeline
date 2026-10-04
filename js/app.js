(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const DATA_KEY = "seerah-timeline:data:v1";
  const PREFS_KEY = "seerah-timeline:prefs:v1";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const PALETTE = ["#0f766e", "#b45309", "#be185d", "#4338ca", "#b91c1c", "#7e22ce", "#475569",
    "#15803d", "#0369a1", "#a16207", "#9d174d", "#1d4ed8"];
  const BIRTH_YEAR = 570.3; // approx. Rabi' al-Awwal of the Year of the Elephant
  let LABEL_W = 168;        // width of the sticky lane-label column (px); narrower on phones
  const ROW_H = 30;         // height of one row of events inside a lane (px)
  const LANE_PAD = 8;
  const MAX_LABEL_W = 240;
  const MIN_PPY = 6, MAX_PPY = 480;
  const ERAS = [
    { name: "Before prophethood", from: 570.3, to: 610.6 },
    { name: "Meccan period", from: 610.6, to: 622.7 },
    { name: "Madinan period", from: 622.7, to: 632.45 }
  ];
  const WINDOWS = [
    { value: 0, label: "Overlapping in time" },
    { value: 1, label: "Within ±1 year" },
    { value: 2, label: "Within ±2 years" },
    { value: 5, label: "Within ±5 years" }
  ];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let data = loadData();
  const prefs = Object.assign(
    { view: "timeline", ppy: 40, hidden: [], window: 1 },
    readJSON(PREFS_KEY) || {}
  );
  const ui = {
    view: prefs.view === "grid" ? "grid" : "timeline",
    ppy: clamp(Number(prefs.ppy) || 40, MIN_PPY, MAX_PPY),
    hidden: new Set(Array.isArray(prefs.hidden) ? prefs.hidden : []),
    window: WINDOWS.some(w => w.value === prefs.window) ? prefs.window : 1,
    query: "",
    selectedId: null,
    editingId: null,
    pendingCategory: null
  };

  const $ = sel => document.querySelector(sel);
  const el = {
    search: $("#search"),
    filters: $("#category-filters"),
    tlView: $("#timeline-view"),
    tlScroll: $("#tl-scroll"),
    tlInner: $("#tl-inner"),
    gridView: $("#grid-view"),
    gridScroll: $("#grid-scroll"),
    detailsEmpty: $("#details-empty"),
    detailsContent: $("#details-content"),
    eventDialog: $("#event-dialog"),
    eventForm: $("#event-form"),
    categorySelect: $("#category-select"),
    formError: $("#form-error"),
    datePreview: $("#date-preview"),
    catDialog: $("#categories-dialog"),
    catList: $("#categories-list"),
    catError: $("#categories-error")
  };

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function readJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function seedData() {
    return normalizeData({
      categories: JSON.parse(JSON.stringify(window.SEED_CATEGORIES || [])),
      events: JSON.parse(JSON.stringify(window.SEED_EVENTS || []))
    });
  }

  function loadData() {
    if (window.claude && typeof window.claude.use === "function" && !window.SEED_EVENTS) {
      return { categories: [], events: [] }; // hosted page: data arrives from the database
    }
    const stored = readJSON(DATA_KEY);
    if (stored && Array.isArray(stored.events)) {
      try {
        return normalizeData(stored);
      } catch (_) { /* fall through to seed */ }
    }
    return seedData();
  }

  // Where edits are saved. As a hosted claude.ai page the timeline lives in the page's
  // shared database ("cloud"); opened any other way it falls back to this browser's
  // localStorage ("local").
  const CATS_DOC = "meta/categories";
  const EVENTS_COL = "events";
  const store = {
    mode: "local",
    db: null,
    canWrite: true,
    loading: Boolean(window.claude && typeof window.claude.use === "function"),
    status: "idle"
  };

  async function connectCloud() {
    if (!store.loading) return;
    let db = null, user = null;
    try {
      [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    } catch (_) { /* treated as unavailable */ }
    if (!db) {
      store.loading = false;
      render();
      return;
    }
    store.mode = "cloud";
    store.db = db;
    if (user) {
      try {
        if (await user.can("data.write") === false) store.canWrite = false;
      } catch (_) { /* keep editing on; a refused write decides */ }
    }
    let evDocs = null, catList = null;
    const apply = () => {
      if (evDocs === null || catList === null) return;
      data = normalizeData({ categories: catList, events: evDocs });
      store.loading = false;
      if (ui.selectedId && !data.events.some(e => e.id === ui.selectedId)) ui.selectedId = null;
      render();
    };
    const onError = err => {
      store.loading = false;
      setStatus("error");
      toast(`The timeline stopped syncing (${err && err.message ? err.message : "connection lost"}). Reload the page to reconnect.`, true);
      render();
    };
    db.collection(EVENTS_COL).limit(1000).onSnapshot(snap => {
      evDocs = snap.docs
        .map(d => Object.assign({}, d.data(), { id: d.id }))
        .filter(e => toInt(e.startYear) !== null);
      apply();
    }, onError);
    db.doc(CATS_DOC).onSnapshot(snap => {
      const body = snap.exists ? snap.data() : null;
      catList = body && Array.isArray(body.list) ? body.list : [];
      apply();
    }, onError);
  }

  // Persist a change that has already been applied to `data`.
  async function persist({ events = [], deleted = [], categories = false } = {}) {
    if (store.mode === "local") {
      if (!writeJSON(DATA_KEY, { version: 1, categories: data.categories, events: data.events })) {
        toast("Your changes could not be saved in this browser (storage is unavailable or full). Use Export to keep a copy.", true);
      }
      return true;
    }
    const writes = [];
    if (categories) writes.push(() => store.db.doc(CATS_DOC).set({ list: data.categories }));
    events.forEach(ev => writes.push(() => store.db.collection(EVENTS_COL).doc(ev.id).set(Object.assign({}, ev))));
    deleted.forEach(id => writes.push(() => store.db.collection(EVENTS_COL).doc(id).delete()));
    setStatus("saving");
    try {
      for (let i = 0; i < writes.length; i += 6) {
        await Promise.all(writes.slice(i, i + 6).map(w => w()));
      }
      setStatus("saved");
      return true;
    } catch (err) {
      setStatus("error");
      if (err && err.code === "invalid_argument" && store.canWrite) {
        store.canWrite = false;
        toast("You can view this timeline but not edit it. Ask the owner for edit access.", true);
        render();
      } else if (err && err.code === "quota_exceeded") {
        toast("The timeline is full, so this change wasn't saved. Delete some events and try again.", true);
      } else {
        toast(`This change wasn't saved: ${err && err.message ? err.message : "unknown error"}. Check your connection and try again.`, true);
      }
      return false;
    }
  }

  // Replace everything (import / reset).
  function replaceAll(next) {
    const keep = new Set(next.events.map(e => e.id));
    const deleted = data.events.filter(e => !keep.has(e.id)).map(e => e.id);
    data = next;
    ui.selectedId = null;
    ui.hidden.clear();
    savePrefs();
    render();
    return persist({ events: data.events, deleted, categories: true });
  }

  function setStatus(status) {
    store.status = status;
    renderStatus();
  }

  function renderStatus() {
    const node = document.getElementById("save-status");
    if (!node) return;
    let text, cls;
    if (store.loading) [text, cls] = ["Loading…", "pending"];
    else if (store.mode === "local") [text, cls] = ["Saved in this browser only", "local"];
    else if (!store.canWrite) [text, cls] = ["View only", "local"];
    else if (store.status === "saving") [text, cls] = ["Saving…", "pending"];
    else if (store.status === "error") [text, cls] = ["Not saved", "error"];
    else [text, cls] = ["All changes saved", "ok"];
    node.textContent = text;
    node.className = "save-status " + cls;
    node.title = store.mode === "cloud"
      ? "Edits are saved to this page and show up on every device."
      : "Edits are kept in this browser's storage. Use Export to back them up.";
  }

  let toastTimer;
  function toast(message, isError) {
    const node = document.getElementById("toast");
    node.textContent = message;
    node.classList.toggle("error", Boolean(isError));
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 8000 : 3500);
  }

  // In-page replacement for confirm()/prompt(), which hosted pages block.
  function ask({ title, message = "", okLabel = "OK", danger = false, input = null }) {
    const dlg = document.getElementById("ask-dialog");
    const form = document.getElementById("ask-form");
    const field = document.getElementById("ask-input");
    const ok = document.getElementById("ask-ok");
    document.getElementById("ask-title").textContent = title;
    document.getElementById("ask-message").textContent = message;
    document.getElementById("ask-input-wrap").hidden = !input;
    document.getElementById("ask-input-label").textContent = input ? input.label : "";
    field.value = input ? input.value || "" : "";
    field.required = Boolean(input);
    ok.textContent = okLabel;
    ok.classList.toggle("danger-fill", danger);
    return new Promise(resolve => {
      const done = value => {
        form.onsubmit = null;
        document.getElementById("ask-cancel").onclick = null;
        dlg.oncancel = null;
        dlg.close();
        resolve(value);
      };
      form.onsubmit = e => {
        e.preventDefault();
        done(input ? field.value.trim() : true);
      };
      document.getElementById("ask-cancel").onclick = () => done(input ? null : false);
      dlg.oncancel = e => {
        e.preventDefault();
        done(input ? null : false);
      };
      dlg.showModal();
      (input ? field : ok).focus();
    });
  }

  function savePrefs() {
    writeJSON(PREFS_KEY, { view: ui.view, ppy: ui.ppy, hidden: [...ui.hidden], window: ui.window });
  }

  // ---------------------------------------------------------------------------
  // Data normalisation / validation
  // ---------------------------------------------------------------------------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function toInt(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  function toMonth(v) {
    const n = toInt(v);
    return n !== null && n >= 1 && n <= 12 ? n : null;
  }

  function normalizeEvent(e, categoryIds) {
    const startYear = toInt(e.startYear);
    if (startYear === null) throw new Error(`Event "${e.title || "(untitled)"}" has no start year.`);
    let endYear = toInt(e.endYear);
    let endMonth = endYear === null ? null : toMonth(e.endMonth);
    const ev = {
      id: String(e.id || uid()),
      title: String(e.title || "Untitled event").trim(),
      category: String(e.category || "").trim() || "uncategorized",
      startYear,
      startMonth: toMonth(e.startMonth),
      endYear,
      endMonth,
      approximate: Boolean(e.approximate),
      location: String(e.location || "").trim(),
      description: String(e.description || "").trim(),
      sources: String(e.sources || "").trim()
    };
    if (ev.endYear !== null && endOf(ev) <= startOf(ev)) {
      ev.endYear = null;
      ev.endMonth = null;
    }
    if (categoryIds) categoryIds.add(ev.category);
    return ev;
  }

  function normalizeData(raw) {
    const events = Array.isArray(raw) ? raw : raw.events;
    if (!Array.isArray(events)) throw new Error("The file does not contain an \"events\" list.");
    const used = new Set();
    const seen = new Set();
    const outEvents = events.map(e => {
      const ev = normalizeEvent(e || {}, used);
      while (seen.has(ev.id)) ev.id = uid();
      seen.add(ev.id);
      return ev;
    });
    const cats = [];
    const catIds = new Set();
    (Array.isArray(raw.categories) ? raw.categories : []).forEach((c, i) => {
      if (!c) return;
      const id = String(c.id || c.name || "").trim();
      if (!id || catIds.has(id)) return;
      catIds.add(id);
      cats.push({ id, name: String(c.name || id).trim(), color: validColor(c.color) || PALETTE[i % PALETTE.length] });
    });
    used.forEach(id => {
      if (!catIds.has(id)) {
        catIds.add(id);
        cats.push({ id, name: id === "uncategorized" ? "Uncategorized" : id, color: PALETTE[cats.length % PALETTE.length] });
      }
    });
    return { categories: cats, events: outEvents };
  }

  function validColor(c) {
    return typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
  }

  // ---------------------------------------------------------------------------
  // Dates
  // ---------------------------------------------------------------------------
  // Decimal-year interval [startOf, endOf) for each event.
  function startOf(e) {
    return e.startYear + (e.startMonth ? (e.startMonth - 1) / 12 : 0);
  }

  function endOf(e) {
    if (e.endYear !== null && e.endYear !== undefined) {
      return e.endYear + (e.endMonth ? e.endMonth / 12 : 1);
    }
    return e.startYear + (e.startMonth ? e.startMonth / 12 : 1);
  }

  function isSpan(e) {
    return e.endYear !== null && e.endYear !== undefined;
  }

  // Julian Day Number (Julian calendar before 1582-10-15, Gregorian after).
  function julianDay(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    const gregorian = y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15)));
    if (gregorian) {
      return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
    }
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - 32083;
  }

  // Tabular Islamic calendar year. Values <= 0 are years before the Hijrah.
  function hijriYear(y, m, d) {
    const days = julianDay(y, m, d) - 1948440; // 1 Muharram 1 AH = 16 July 622 (Julian)
    return Math.floor((30 * days + 10646) / 10631);
  }

  function formatHijri(h) {
    return h >= 1 ? `${h} AH` : `${1 - h} BH`;
  }

  function formatHijriRange(a, b) {
    if (a === b) return formatHijri(a);
    if (a >= 1 && b >= 1) return `${a}–${b} AH`;
    if (a <= 0 && b <= 0) return `${1 - a}–${1 - b} BH`;
    return `${formatHijri(a)}–${formatHijri(b)}`;
  }

  function hijriFor(year, month, isEnd) {
    if (month) return [hijriYear(year, month, 15), hijriYear(year, month, 15)];
    return isEnd ? [hijriYear(year, 12, 31), hijriYear(year, 12, 31)] : [hijriYear(year, 1, 1), hijriYear(year, 12, 31)];
  }

  function hijriLabel(e) {
    const [a, b0] = hijriFor(e.startYear, e.startMonth, false);
    let b = b0;
    if (isSpan(e)) b = hijriFor(e.endYear, e.endMonth, true)[1];
    return formatHijriRange(a, b);
  }

  function ageAt(decimalYear) {
    const age = Math.floor(decimalYear - BIRTH_YEAR);
    return age >= 0 && age <= 63 ? age : null;
  }

  function ageLabel(e) {
    const s = e.startMonth ? startOf(e) + 1 / 24 : e.startYear + 0.5;
    const a = ageAt(s);
    if (isSpan(e)) {
      const b = ageAt(endOf(e) - 1 / 24);
      if (a !== null && b !== null && b !== a) return `Age ~${a}–${b}`;
      if (a === null && b !== null) return `Up to age ~${b}`;
    }
    return a === null ? "" : `Age ~${a}`;
  }

  function formatYM(year, month) {
    return month ? `${MONTHS[month - 1]} ${year}` : String(year);
  }

  function dateLabel(e) {
    let s = (e.approximate ? "c. " : "") + formatYM(e.startYear, e.startMonth);
    if (isSpan(e)) {
      s += e.endYear === e.startYear && e.startMonth && e.endMonth
        ? `–${MONTHS[e.endMonth - 1]} ${e.endYear}`
        : `–${formatYM(e.endYear, e.endMonth)}`;
    }
    return s + " CE";
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

  function categoryById(id) {
    return data.categories.find(c => c.id === id) || { id, name: id, color: "#64748b" };
  }

  function sortChrono(a, b) {
    return startOf(a) - startOf(b) || endOf(a) - endOf(b) || a.title.localeCompare(b.title);
  }

  function matchesQuery(e) {
    if (!ui.query) return true;
    const q = ui.query.toLowerCase();
    return [e.title, e.location, e.description, e.sources, categoryById(e.category).name]
      .some(f => f && f.toLowerCase().includes(q));
  }

  function visibleCategories() {
    return data.categories.filter(c => !ui.hidden.has(c.id));
  }

  function visibleEvents() {
    return data.events.filter(e => !ui.hidden.has(e.category) && matchesQuery(e)).sort(sortChrono);
  }

  function selectedEvent() {
    return ui.selectedId ? data.events.find(e => e.id === ui.selectedId) || null : null;
  }

  // Events whose interval overlaps the selected event's interval widened by the window.
  function concurrentWith(sel, events) {
    const lo = startOf(sel) - ui.window;
    const hi = endOf(sel) + ui.window;
    return events.filter(e => e.id !== sel.id && startOf(e) < hi && endOf(e) > lo);
  }

  function yearRange(events) {
    if (!events.length) return [565, 640];
    let lo = Infinity, hi = -Infinity;
    events.forEach(e => {
      lo = Math.min(lo, startOf(e));
      hi = Math.max(hi, endOf(e));
    });
    return [Math.floor(lo) - 2, Math.ceil(hi) + 2];
  }

  let measureCtx = null;
  function textWidth(text) {
    if (!measureCtx) {
      measureCtx = document.createElement("canvas").getContext("2d");
      const fam = getComputedStyle(document.body).fontFamily;
      measureCtx.font = `500 13px ${fam}`;
    }
    return measureCtx.measureText(text).width;
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    document.body.classList.toggle("read-only", !store.canWrite);
    renderStatus();
    renderFilters();
    document.querySelectorAll(".segmented [data-view]").forEach(b => {
      b.setAttribute("aria-selected", String(b.dataset.view === ui.view));
    });
    el.tlView.hidden = ui.view !== "timeline";
    el.gridView.hidden = ui.view !== "grid";
    if (ui.view === "timeline") renderTimeline();
    else renderGrid();
    renderDetails();
  }

  function renderFilters() {
    const counts = {};
    data.events.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
    el.filters.innerHTML = data.categories.map(c => `
      <button type="button" class="chip${ui.hidden.has(c.id) ? " off" : ""}" data-cat="${esc(c.id)}"
        aria-pressed="${!ui.hidden.has(c.id)}" style="--c:${c.color}">
        <span class="swatch"></span>${esc(c.name)}<span class="count">${counts[c.id] || 0}</span>
      </button>`).join("");
  }

  function renderTimeline() {
    LABEL_W = window.innerWidth < 600 ? 112 : 168;
    const events = visibleEvents();
    const cats = visibleCategories();
    const [minY, maxY] = yearRange(events.length ? events : data.events);
    const ppy = ui.ppy;
    const width = (maxY - minY) * ppy;
    const x = y => (y - minY) * ppy;
    const sel = selectedEvent();
    const visibleSel = sel && events.some(e => e.id === sel.id) ? sel : null;
    const concurrent = visibleSel ? new Set(concurrentWith(visibleSel, events).map(e => e.id)) : null;

    // Axis ticks: choose a label step that keeps labels at least ~56px apart.
    const step = [1, 2, 5, 10, 20, 50, 100].find(s => s * ppy >= 56) || 100;
    let ticks = "";
    for (let y = Math.ceil(minY / step) * step; y <= maxY; y += step) {
      const h = hijriYear(y, 7, 1);
      ticks += `<div class="tick" style="left:${x(y)}px"><span class="tick-ce">${y}</span><span class="tick-ah">${formatHijri(h)}</span></div>`;
    }
    const eras = ERAS.filter(r => r.to > minY && r.from < maxY).map(r => {
      const l = x(Math.max(r.from, minY));
      const w = x(Math.min(r.to, maxY)) - l;
      return `<div class="era" style="left:${l}px;width:${w}px" title="${esc(r.name)}"><span style="left:${LABEL_W + 8}px">${esc(r.name)}</span></div>`;
    }).join("");

    let lanes = "";
    cats.forEach(cat => {
      const items = events.filter(e => e.category === cat.id);
      const rowsEnd = [];
      let html = "";
      items.forEach(e => {
        const left = x(startOf(e));
        const span = isSpan(e);
        const barW = span ? Math.max(8, x(endOf(e)) - left) : 0;
        const labelW = Math.min(MAX_LABEL_W, Math.ceil(textWidth(e.title)));
        const extent = span ? Math.max(barW, labelW + 16) : labelW + 22;
        let row = rowsEnd.findIndex(end => end <= left - 6);
        if (row === -1) { row = rowsEnd.length; rowsEnd.push(0); }
        rowsEnd[row] = left + extent;
        const cls = ["tl-item", span ? "span" : "point"];
        if (visibleSel) {
          if (e.id === visibleSel.id) cls.push("is-selected");
          else if (concurrent.has(e.id)) cls.push("is-concurrent");
          else cls.push("is-dim");
        }
        if (e.approximate) cls.push("approx");
        html += `<button type="button" class="${cls.join(" ")}" data-id="${esc(e.id)}"
          style="left:${left}px;top:${LANE_PAD + row * ROW_H}px;${span ? `--bar:${barW}px;width:${extent}px;` : ""}"
          title="${esc(e.title)} — ${esc(dateLabel(e))}">
          ${span ? `<span class="bar"></span>` : `<span class="dot"></span>`}
          <span class="label" style="max-width:${MAX_LABEL_W}px;${span ? `left:${LABEL_W + 4}px;` : ""}">${esc(e.title)}</span>
        </button>`;
      });
      const h = Math.max(1, rowsEnd.length) * ROW_H + LANE_PAD * 2;
      lanes += `<div class="tl-lane" style="--c:${cat.color}">
        <div class="tl-lane-label" style="width:${LABEL_W}px"><span class="swatch"></span><span>${esc(cat.name)}</span><span class="count">${items.length}</span></div>
        <div class="tl-track" style="width:${width}px;height:${h}px;background-size:${ppy}px 100%">${html}</div>
      </div>`;
    });

    let band = "";
    if (visibleSel) {
      const l = x(startOf(visibleSel) - ui.window);
      const r = x(endOf(visibleSel) + ui.window);
      band = `<div class="tl-band" style="left:${LABEL_W + l}px;width:${r - l}px"></div>`;
    }

    const empty = emptyMessage(cats, events);

    el.tlInner.style.width = `${LABEL_W + width}px`;
    el.tlInner.innerHTML = `
      <div class="tl-axis">
        <div class="tl-corner" style="width:${LABEL_W}px">CE<br><span class="muted">Hijri (approx.)</span></div>
        <div class="tl-axis-track" style="width:${width}px">${eras}${ticks}</div>
      </div>
      <div class="tl-lanes">${band}${lanes}</div>
      ${empty}`;
  }

  function emptyMessage(cats, events) {
    if (store.loading) return `<p class="tl-empty">Loading your timeline…</p>`;
    if (!data.events.length) {
      return `<div class="tl-empty"><p><strong>No events yet.</strong></p><p>${store.canWrite
        ? "Use <strong>+ Add event</strong> to add the first one, or import a JSON export from the <strong>⋯</strong> menu."
        : "Events will appear here once the owner adds them."}</p></div>`;
    }
    if (!data.categories.some(c => !ui.hidden.has(c.id)) || !cats.length) return `<p class="tl-empty">All categories are hidden. Turn one on above.</p>`;
    if (!events.length) return `<p class="tl-empty">No events match your search.</p>`;
    return "";
  }

  function renderGrid() {
    const events = visibleEvents();
    const cats = visibleCategories();
    const sel = selectedEvent();
    const visibleSel = sel && events.some(e => e.id === sel.id) ? sel : null;
    const concurrent = visibleSel ? new Set(concurrentWith(visibleSel, events).map(e => e.id)) : null;

    if (!cats.length || !events.length) {
      el.gridScroll.innerHTML = emptyMessage(cats, events);
      return;
    }

    const [minY, maxY] = yearRange(events);
    const winLo = visibleSel ? startOf(visibleSel) - ui.window : null;
    const winHi = visibleSel ? endOf(visibleSel) + ui.window : null;
    let rows = "";
    for (let y = minY; y <= maxY; y++) {
      const active = events.filter(e => startOf(e) < y + 1 && endOf(e) > y);
      if (!active.length) continue;
      const inWindow = visibleSel && winLo < y + 1 && winHi > y;
      const age = ageAt(y + 0.5);
      const h = formatHijriRange(hijriYear(y, 1, 1), hijriYear(y, 12, 31));
      let cells = "";
      cats.forEach(cat => {
        const here = active.filter(e => e.category === cat.id);
        cells += `<td style="--c:${cat.color}">${here.map(e => {
          const continuing = Math.floor(startOf(e)) < y;
          const cls = ["g-item"];
          if (continuing) cls.push("continuing");
          if (visibleSel) {
            if (e.id === visibleSel.id) cls.push("is-selected");
            else if (concurrent.has(e.id)) cls.push("is-concurrent");
            else cls.push("is-dim");
          }
          const when = continuing ? "" : (e.startMonth ? MONTHS[e.startMonth - 1] : "");
          return `<button type="button" class="${cls.join(" ")}" data-id="${esc(e.id)}"${continuing ? ` title="${esc(e.title)} (continues from ${e.startYear})"` : ""}>
            <span class="g-title">${esc(e.title)}</span>${when ? `<span class="g-when">${esc(when)}</span>` : ""}
          </button>`;
        }).join("")}</td>`;
      });
      rows += `<tr class="${inWindow ? "in-window" : ""}" data-year="${y}">
        <th scope="row"><span class="g-year">${y}</span><span class="g-sub">${esc(h)}</span>${age !== null ? `<span class="g-sub">Age ~${age}</span>` : ""}</th>
        ${cells}
      </tr>`;
    }
    el.gridScroll.innerHTML = `<table class="grid">
      <thead><tr><th scope="col">Year (CE)</th>${cats.map(c => `<th scope="col" style="--c:${c.color}"><span class="swatch"></span>${esc(c.name)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  function renderDetails() {
    const sel = selectedEvent();
    el.detailsEmpty.hidden = Boolean(sel);
    el.detailsContent.hidden = !sel;
    if (!sel) {
      el.detailsContent.innerHTML = "";
      return;
    }
    const cat = categoryById(sel.category);
    const events = visibleEvents();
    const pool = events.some(e => e.id === sel.id) ? events : events.concat(sel).sort(sortChrono);
    const idx = pool.findIndex(e => e.id === sel.id);
    const prev = pool[idx - 1], next = pool[idx + 1];
    const conc = concurrentWith(sel, events);
    const age = ageLabel(sel);

    const groups = data.categories
      .map(c => ({ c, items: conc.filter(e => e.category === c.id) }))
      .filter(g => g.items.length);

    el.detailsContent.innerHTML = `
      <div class="d-nav">
        <button type="button" class="btn small" data-goto="${prev ? esc(prev.id) : ""}" ${prev ? "" : "disabled"} title="Previous event (←)">← Prev</button>
        <button type="button" class="btn small" data-action="close" title="Close (Esc)">Close</button>
        <button type="button" class="btn small" data-goto="${next ? esc(next.id) : ""}" ${next ? "" : "disabled"} title="Next event (→)">Next →</button>
      </div>
      <span class="cat-pill" style="--c:${cat.color}"><span class="swatch"></span>${esc(cat.name)}</span>
      <h2 class="d-title">${esc(sel.title)}</h2>
      <p class="d-date">${esc(dateLabel(sel))} · ${esc(hijriLabel(sel))}${age ? ` · ${esc(age)}` : ""}</p>
      ${sel.location ? `<p class="d-loc">📍 ${esc(sel.location)}</p>` : ""}
      ${sel.description ? `<p class="d-desc">${esc(sel.description)}</p>` : ""}
      ${sel.sources ? `<p class="d-src"><strong>Sources:</strong> ${esc(sel.sources)}</p>` : ""}
      <div class="d-actions">
        <button type="button" class="btn needs-write" data-action="edit">Edit</button>
        <button type="button" class="btn needs-write" data-action="add-near">+ Add event at this time</button>
      </div>
      <div class="d-concurrent">
        <div class="d-conc-head">
          <h3>Around the same time <span class="count">${conc.length}</span></h3>
          <select id="window-select" aria-label="How close in time">
            ${WINDOWS.map(w => `<option value="${w.value}" ${w.value === ui.window ? "selected" : ""}>${w.label}</option>`).join("")}
          </select>
        </div>
        ${groups.length ? groups.map(g => `
          <div class="d-group" style="--c:${g.c.color}">
            <h4><span class="swatch"></span>${esc(g.c.name)}</h4>
            <ul>${g.items.map(e => `
              <li><button type="button" class="link" data-goto="${esc(e.id)}">
                <span class="l-title">${esc(e.title)}</span>
                <span class="l-date">${esc(dateLabel(e))}</span>
              </button></li>`).join("")}
            </ul>
          </div>`).join("") : `<p class="muted">Nothing else in this time window${ui.query || ui.hidden.size ? " (with the current filters)" : ""}.</p>`}
      </div>`;
  }

  // ---------------------------------------------------------------------------
  // Selection & navigation
  // ---------------------------------------------------------------------------
  function select(id, { scroll = false } = {}) {
    ui.selectedId = id;
    render();
    if (scroll && id) scrollToEvent(id);
  }

  function scrollToEvent(id) {
    const node = (ui.view === "timeline" ? el.tlInner : el.gridScroll).querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!node) return;
    if (ui.view === "timeline") {
      const target = node.offsetLeft + LABEL_W - el.tlScroll.clientWidth / 2 + 80;
      el.tlScroll.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
      node.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      node.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }

  function setZoom(ppy, anchorClientX) {
    const old = ui.ppy;
    ppy = clamp(Math.round(ppy * 100) / 100, MIN_PPY, MAX_PPY);
    if (ppy === old) return;
    const rect = el.tlScroll.getBoundingClientRect();
    const anchor = anchorClientX === undefined ? rect.width / 2 : anchorClientX - rect.left;
    const yearAtAnchor = (el.tlScroll.scrollLeft + anchor - LABEL_W) / old;
    ui.ppy = ppy;
    savePrefs();
    renderTimeline();
    el.tlScroll.scrollLeft = yearAtAnchor * ppy + LABEL_W - anchor;
  }

  function fitZoom() {
    const events = visibleEvents();
    const [minY, maxY] = yearRange(events.length ? events : data.events);
    const avail = el.tlScroll.clientWidth - LABEL_W - 8;
    setZoom(Math.max(MIN_PPY, avail / (maxY - minY)));
    el.tlScroll.scrollLeft = 0;
  }

  // ---------------------------------------------------------------------------
  // Event dialog
  // ---------------------------------------------------------------------------
  function fillMonthSelects() {
    document.querySelectorAll(".month-select").forEach(s => {
      s.innerHTML = `<option value="">—</option>` + MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
    });
  }

  function fillCategorySelect(selected) {
    el.categorySelect.innerHTML = data.categories
      .map(c => `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}</option>`)
      .join("") + `<option value="__new">+ New category…</option>`;
  }

  function openEventDialog(ev, defaults) {
    ui.editingId = ev ? ev.id : null;
    const f = el.eventForm.elements;
    const src = ev || Object.assign({ title: "", category: data.categories[0] ? data.categories[0].id : "", startYear: "", startMonth: null,
      endYear: null, endMonth: null, approximate: false, location: "", description: "", sources: "" }, defaults || {});
    $("#event-dialog-title").textContent = ev ? "Edit event" : "Add event";
    fillCategorySelect(src.category);
    f.title.value = src.title;
    f.startYear.value = src.startYear ?? "";
    f.startMonth.value = src.startMonth || "";
    f.endYear.value = src.endYear ?? "";
    f.endMonth.value = src.endMonth || "";
    f.approximate.checked = Boolean(src.approximate);
    f.location.value = src.location || "";
    f.description.value = src.description || "";
    f.sources.value = src.sources || "";
    $("#delete-event").hidden = !ev;
    el.formError.textContent = "";
    el.categorySelect.dataset.prev = el.categorySelect.value;
    updateDatePreview();
    el.eventDialog.showModal();
    f.title.focus();
  }

  function readForm() {
    const f = el.eventForm.elements;
    return {
      title: f.title.value.trim(),
      category: f.category.value,
      startYear: toInt(f.startYear.value),
      startMonth: toMonth(f.startMonth.value),
      endYear: toInt(f.endYear.value),
      endMonth: toMonth(f.endMonth.value),
      approximate: f.approximate.checked,
      location: f.location.value.trim(),
      description: f.description.value.trim(),
      sources: f.sources.value.trim()
    };
  }

  function validateForm(v) {
    if (!v.title) return "Please enter a title.";
    if (!v.category || v.category === "__new") return "Please choose a category.";
    if (v.startYear === null) return "Please enter a start year.";
    if (v.endYear === null && v.endMonth) return "Please enter an end year, or clear the end month.";
    if (v.endYear !== null && endOf(v) <= startOf(v)) return "The end must be after the start.";
    return "";
  }

  function updateDatePreview() {
    const v = readForm();
    if (v.startYear === null || (v.endYear !== null && endOf(v) <= startOf(v))) {
      el.datePreview.textContent = "";
      return;
    }
    const age = ageLabel(v);
    el.datePreview.textContent = `${dateLabel(v)} · ${hijriLabel(v)}${age ? " · " + age : ""}`;
  }

  function saveEventFromForm() {
    const v = readForm();
    const err = validateForm(v);
    if (err) {
      el.formError.textContent = err;
      return false;
    }
    let ev;
    if (ui.editingId) {
      ev = normalizeEvent(Object.assign({}, v, { id: ui.editingId }));
      const i = data.events.findIndex(e => e.id === ui.editingId);
      if (i !== -1) data.events[i] = ev;
      else data.events.push(ev);
    } else {
      ev = normalizeEvent(Object.assign({}, v, { id: uid() }));
      data.events.push(ev);
    }
    const isNewCategory = !data.categories.some(c => c.id === ev.category);
    persist({ events: [ev], categories: isNewCategory || ui.pendingCategory === ev.category });
    ui.pendingCategory = null;
    const saved = ev.id;
    const cat = categoryById(v.category);
    if (ui.hidden.has(cat.id)) { ui.hidden.delete(cat.id); savePrefs(); }
    ui.editingId = null;
    el.eventDialog.close();
    select(saved, { scroll: true });
    return true;
  }

  function slugId(name, taken) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "category";
    let id = base, n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  function addCategory(name) {
    const id = slugId(name, new Set(data.categories.map(c => c.id)));
    const cat = { id, name, color: PALETTE[data.categories.length % PALETTE.length] };
    data.categories.push(cat);
    return cat;
  }

  // ---------------------------------------------------------------------------
  // Categories dialog
  // ---------------------------------------------------------------------------
  function catRow(c) {
    return `<div class="cat-row" data-id="${esc(c.id || "")}">
      <input type="color" value="${esc(c.color)}" aria-label="Colour">
      <input type="text" value="${esc(c.name)}" aria-label="Name" maxlength="60">
      <button type="button" class="btn small" data-move="-1" aria-label="Move up">↑</button>
      <button type="button" class="btn small" data-move="1" aria-label="Move down">↓</button>
      <button type="button" class="btn small danger" data-remove aria-label="Delete">✕</button>
    </div>`;
  }

  function openCategoriesDialog() {
    el.catList.innerHTML = data.categories.map(catRow).join("");
    el.catError.textContent = "";
    el.catDialog.showModal();
  }

  async function saveCategories() {
    const rows = [...el.catList.querySelectorAll(".cat-row")];
    const next = [];
    for (const r of rows) {
      const name = r.querySelector('input[type="text"]').value.trim();
      if (!name) {
        el.catError.textContent = "Every category needs a name.";
        return false;
      }
      next.push({ id: r.dataset.id, name, color: r.querySelector('input[type="color"]').value });
    }
    const keep = new Set(next.filter(c => c.id).map(c => c.id));
    const removed = data.categories.filter(c => !keep.has(c.id));
    const orphaned = data.events.filter(e => removed.some(c => c.id === e.category));
    if (orphaned.length) {
      const names = removed.filter(c => orphaned.some(e => e.category === c.id)).map(c => `"${c.name}"`).join(", ");
      const yes = await ask({
        title: "Delete events too?",
        message: `${orphaned.length} event(s) use ${names}. Deleting the category also deletes them.`,
        okLabel: `Delete ${orphaned.length} event(s)`,
        danger: true
      });
      if (!yes) return false;
      data.events = data.events.filter(e => !orphaned.includes(e));
    }
    const taken = new Set(keep);
    next.forEach(c => {
      if (c.id) return;
      c.id = slugId(c.name, taken);
      taken.add(c.id);
    });
    data.categories = next;
    removed.forEach(c => ui.hidden.delete(c.id));
    if (ui.selectedId && !data.events.some(e => e.id === ui.selectedId)) ui.selectedId = null;
    savePrefs();
    el.catDialog.close();
    render();
    persist({ categories: true, deleted: orphaned.map(e => e.id) });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------
  async function exportData() {
    const payload = { version: 1, exportedAt: new Date().toISOString(), categories: data.categories, events: [...data.events].sort(sortChrono) };
    const json = JSON.stringify(payload, null, 2);
    const filename = `seerah-timeline-${new Date().toISOString().slice(0, 10)}.json`;
    if (window.claude && typeof window.claude.use === "function") {
      // Hosted pages can't start downloads themselves; the viewer confirms the save.
      const downloads = await window.claude.use("downloads").catch(() => null);
      if (downloads) {
        try {
          await downloads.save({ filename, data: json });
        } catch (err) {
          if (!err || err.code !== "declined") toast(`Export failed: ${err && err.message ? err.message : "unknown error"}.`, true);
        }
        return;
      }
    }
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let next;
      try {
        next = normalizeData(JSON.parse(reader.result));
      } catch (err) {
        toast(`Couldn't import "${file.name}": ${err.message}`, true);
        return;
      }
      const yes = await ask({
        title: "Replace all events?",
        message: `This replaces your current ${data.events.length} events with the ${next.events.length} events in "${file.name}".`,
        okLabel: "Replace",
        danger: true
      });
      if (!yes) return;
      if (await replaceAll(next)) toast(`Imported ${next.events.length} events.`);
    };
    reader.readAsText(file);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function closeMenu() {
    const m = document.querySelector("details.menu");
    if (m) m.open = false;
  }

  function bind() {
    let searchTimer;
    el.search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { ui.query = el.search.value.trim(); render(); }, 120);
    });

    document.querySelectorAll(".segmented [data-view]").forEach(b => b.addEventListener("click", () => {
      ui.view = b.dataset.view;
      savePrefs();
      render();
      if (ui.selectedId) scrollToEvent(ui.selectedId);
    }));

    el.filters.addEventListener("click", e => {
      const chip = e.target.closest("[data-cat]");
      if (!chip) return;
      const id = chip.dataset.cat;
      if (e.altKey || e.metaKey) {
        // Alt/Cmd-click: show only this category (or everything if it already is the only one).
        const only = ui.hidden.size === data.categories.length - 1 && !ui.hidden.has(id);
        ui.hidden = new Set(only ? [] : data.categories.filter(c => c.id !== id).map(c => c.id));
      } else if (ui.hidden.has(id)) {
        ui.hidden.delete(id);
      } else {
        ui.hidden.add(id);
      }
      savePrefs();
      render();
    });

    el.tlInner.addEventListener("click", e => {
      const item = e.target.closest("[data-id]");
      if (item) select(item.dataset.id);
      else if (e.target.closest(".tl-track")) select(null);
    });
    el.tlInner.addEventListener("dblclick", e => {
      const item = e.target.closest("[data-id]");
      if (item && store.canWrite) openEventDialog(data.events.find(x => x.id === item.dataset.id));
    });
    el.tlScroll.addEventListener("wheel", e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(ui.ppy * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
    }, { passive: false });

    el.gridScroll.addEventListener("click", e => {
      const item = e.target.closest("[data-id]");
      if (item) select(item.dataset.id);
    });
    el.gridScroll.addEventListener("dblclick", e => {
      const item = e.target.closest("[data-id]");
      if (item && store.canWrite) openEventDialog(data.events.find(x => x.id === item.dataset.id));
    });

    el.detailsContent.addEventListener("click", e => {
      const go = e.target.closest("[data-goto]");
      if (go && go.dataset.goto) return select(go.dataset.goto, { scroll: true });
      const act = e.target.closest("[data-action]");
      if (!act) return;
      const sel = selectedEvent();
      if (act.dataset.action === "close") select(null);
      else if (act.dataset.action === "edit" && sel) openEventDialog(sel);
      else if (act.dataset.action === "add-near" && sel) {
        openEventDialog(null, { startYear: sel.startYear, startMonth: sel.startMonth, approximate: sel.approximate });
      }
    });
    el.detailsContent.addEventListener("change", e => {
      if (e.target.id !== "window-select") return;
      ui.window = Number(e.target.value);
      savePrefs();
      render();
    });

    $("#zoom-in").addEventListener("click", () => setZoom(ui.ppy * 1.4));
    $("#zoom-out").addEventListener("click", () => setZoom(ui.ppy / 1.4));
    $("#zoom-fit").addEventListener("click", fitZoom);

    $("#add-event").addEventListener("click", () => {
      const sel = selectedEvent();
      openEventDialog(null, sel ? { startYear: sel.startYear, category: sel.category } : undefined);
    });

    // Event form
    fillMonthSelects();
    el.eventForm.addEventListener("submit", e => {
      e.preventDefault();
      saveEventFromForm();
    });
    el.eventForm.addEventListener("input", () => {
      el.formError.textContent = "";
      updateDatePreview();
    });
    el.categorySelect.addEventListener("change", async () => {
      if (el.categorySelect.value !== "__new") {
        el.categorySelect.dataset.prev = el.categorySelect.value;
        return;
      }
      const name = await ask({ title: "New category", input: { label: "Name", value: "" }, okLabel: "Add category" });
      if (!name) {
        el.categorySelect.value = el.categorySelect.dataset.prev || "";
        return;
      }
      const existing = data.categories.find(c => c.name.toLowerCase() === name.toLowerCase());
      const cat = existing || addCategory(name);
      // Saved together with the event, so cancelling the form doesn't leave an empty lane.
      if (!existing) ui.pendingCategory = cat.id;
      fillCategorySelect(cat.id);
      el.categorySelect.dataset.prev = cat.id;
      renderFilters();
    });
    el.eventDialog.addEventListener("close", () => {
      // Drop a category created in the form if the event wasn't saved with it.
      if (ui.pendingCategory && !data.events.some(e => e.category === ui.pendingCategory)) {
        data.categories = data.categories.filter(c => c.id !== ui.pendingCategory);
        renderFilters();
      }
      ui.pendingCategory = null;
    });
    $("#cancel-event").addEventListener("click", () => el.eventDialog.close());
    $("#delete-event").addEventListener("click", async () => {
      const ev = data.events.find(e => e.id === ui.editingId);
      if (!ev) return;
      const yes = await ask({ title: "Delete this event?", message: `"${ev.title}" will be removed from the timeline.`, okLabel: "Delete", danger: true });
      if (!yes) return;
      data.events = data.events.filter(e => e.id !== ev.id);
      if (ui.selectedId === ev.id) ui.selectedId = null;
      ui.editingId = null;
      el.eventDialog.close();
      render();
      persist({ deleted: [ev.id] });
    });

    // Categories dialog
    $("#manage-categories").addEventListener("click", () => { closeMenu(); openCategoriesDialog(); });
    $("#add-category").addEventListener("click", () => {
      el.catList.insertAdjacentHTML("beforeend", catRow({ id: "", name: "", color: PALETTE[el.catList.children.length % PALETTE.length] }));
      el.catList.lastElementChild.querySelector('input[type="text"]').focus();
    });
    el.catList.addEventListener("click", e => {
      const row = e.target.closest(".cat-row");
      if (!row) return;
      if (e.target.closest("[data-remove]")) row.remove();
      const mv = e.target.closest("[data-move]");
      if (mv) {
        if (mv.dataset.move === "-1" && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
        if (mv.dataset.move === "1" && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
      }
    });
    $("#categories-form").addEventListener("submit", e => {
      e.preventDefault();
      saveCategories();
    });
    $("#cancel-categories").addEventListener("click", () => el.catDialog.close());

    // Menu actions
    $("#export-json").addEventListener("click", () => { closeMenu(); exportData(); });
    $("#import-json").addEventListener("click", () => { closeMenu(); $("#import-file").click(); });
    $("#import-file").addEventListener("change", e => {
      const file = e.target.files[0];
      if (file) importFile(file);
      e.target.value = "";
    });
    const resetBtn = $("#reset-data");
    if (!window.SEED_EVENTS) resetBtn.hidden = true;
    resetBtn.addEventListener("click", async () => {
      closeMenu();
      const yes = await ask({
        title: "Reset to sample data?",
        message: "All your events and categories will be replaced with the sample data. Export first if you want to keep your changes.",
        okLabel: "Reset",
        danger: true
      });
      if (yes) replaceAll(seedData());
    });
    document.addEventListener("click", e => {
      const m = document.querySelector("details.menu");
      if (m && m.open && !m.contains(e.target)) m.open = false;
    });

    // Keyboard: ←/→ step through events, Esc clears the selection.
    document.addEventListener("keydown", e => {
      if (document.querySelector("dialog[open]")) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag)) return;
      if (e.key === "Escape" && ui.selectedId) return select(null);
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && ui.selectedId) {
        const btn = el.detailsContent.querySelectorAll(".d-nav [data-goto]")[e.key === "ArrowLeft" ? 0 : 1];
        if (btn && btn.dataset.goto) {
          e.preventDefault();
          select(btn.dataset.goto, { scroll: true });
        }
      }
    });
  }

  let lastNarrow = window.innerWidth < 600;
  window.addEventListener("resize", () => {
    const narrow = window.innerWidth < 600;
    if (narrow !== lastNarrow && ui.view === "timeline") renderTimeline();
    lastNarrow = narrow;
  });

  bind();
  render();
  connectCloud();
})();
