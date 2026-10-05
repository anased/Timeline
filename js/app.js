(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const DATA_KEY = "seerah-timeline:data:v1";
  const PREFS_KEY = "seerah-timeline:prefs:v1";
  const NOTES_KEY = "seerah-timeline:notes:v1";
  const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  // The page is Arabic and right-to-left: time runs from right (earlier) to left (later).
  const RTL = true;
  document.documentElement.lang = "ar";
  document.documentElement.dir = "rtl";
  const PALETTE = ["#0f766e", "#b45309", "#be185d", "#4338ca", "#b91c1c", "#7e22ce", "#475569",
    "#15803d", "#0369a1", "#a16207", "#9d174d", "#1d4ed8"];
  const BIRTH_YEAR = 570.3; // approx. Rabi' al-Awwal of the Year of the Elephant
  let LABEL_W = 168;        // width of the sticky lane-label column (px); narrower on phones
  const ROW_H = 30;         // height of one row of events inside a lane (px)
  const LANE_PAD = 8;
  const MAX_LABEL_W = 240;
  const MIN_PPY = 6, MAX_PPY = 480;
  const ERAS = [
    { name: "قبل البعثة", from: 570.3, to: 610.6 },
    { name: "العهد المكي", from: 610.6, to: 622.7 },
    { name: "العهد المدني", from: 622.7, to: 632.45 }
  ];
  const WINDOWS = [
    { value: 0, label: "المتداخلة زمنيًا" },
    { value: 1, label: "في حدود سنة" },
    { value: 2, label: "في حدود سنتين" },
    { value: 5, label: "في حدود خمس سنين" }
  ];

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let data = loadData();
  const prefs = Object.assign(
    { view: "timeline", ppy: 40, hidden: [], window: 1, onlyNoted: false },
    readJSON(PREFS_KEY) || {}
  );
  const ui = {
    view: ["grid", "notes"].includes(prefs.view) ? prefs.view : "timeline",
    ppy: clamp(Number(prefs.ppy) || 40, MIN_PPY, MAX_PPY),
    hidden: new Set(Array.isArray(prefs.hidden) ? prefs.hidden : []),
    window: WINDOWS.some(w => w.value === prefs.window) ? prefs.window : 1,
    onlyNoted: Boolean(prefs.onlyNoted),
    query: "",
    selectedId: null,
    editingId: null,
    pendingCategory: null,
    autoTitle: "",
    noteDrafts: {},       // eventId -> unsent composer text
    editingNoteId: null,  // note being edited in place
    editDraft: ""
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
    notesView: $("#notes-view"),
    notesList: $("#notes-list"),
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
      notes.list = loadLocalNotes();
      indexNotes();
      render();
      return;
    }
    store.mode = "cloud";
    store.db = db;
    connectNotes(db, user);
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
      toast(`توقفت مزامنة الخط الزمني (${err && err.message ? err.message : "انقطع الاتصال"}). أعد تحميل الصفحة لإعادة الاتصال.`, true);
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
        toast("تعذّر حفظ تعديلاتك في هذا المتصفح (التخزين غير متاح أو ممتلئ). استخدم التصدير للاحتفاظ بنسخة.", true);
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
        toast("يمكنك عرض هذا الخط الزمني دون تعديله. اطلب من المالك صلاحية التعديل.", true);
        render();
      } else if (err && err.code === "quota_exceeded") {
        toast("امتلأ الخط الزمني فلم يُحفظ هذا التعديل. احذف بعض الأحداث ثم حاول مجددًا.", true);
      } else {
        toast(`لم يُحفظ هذا التعديل: ${err && err.message ? err.message : "خطأ غير معروف"}. تحقق من الاتصال ثم حاول مجددًا.`, true);
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

  // ---------------------------------------------------------------------------
  // Notes: private to each person. Hosted, each note is a document in the viewer's own
  // subtree (data/users/<id>/<noteId>), which nobody else can read. Otherwise notes live in
  // this browser's localStorage.
  // ---------------------------------------------------------------------------
  const hosted = Boolean(window.claude && typeof window.claude.use === "function");
  const notes = { list: hosted ? [] : loadLocalNotes(), mode: "local", col: null, canWrite: true };
  let notesByEvent = new Map();
  indexNotes();

  function loadLocalNotes() {
    const stored = readJSON(NOTES_KEY);
    return stored && Array.isArray(stored.notes) ? stored.notes.map(normalizeNote).filter(Boolean) : [];
  }

  function normalizeNote(n) {
    if (!n || typeof n.text !== "string" || !n.text.trim() || !n.eventId) return null;
    const created = typeof n.createdAt === "string" ? n.createdAt : new Date().toISOString();
    return {
      id: String(n.id || uid()),
      eventId: String(n.eventId),
      text: n.text.trim(),
      createdAt: created,
      updatedAt: typeof n.updatedAt === "string" ? n.updatedAt : created
    };
  }

  // Newest first within each event.
  function indexNotes() {
    notesByEvent = new Map();
    [...notes.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach(n => {
      if (!notesByEvent.has(n.eventId)) notesByEvent.set(n.eventId, []);
      notesByEvent.get(n.eventId).push(n);
    });
  }

  function notesFor(eventId) {
    return notesByEvent.get(eventId) || [];
  }

  function canWriteNotes() {
    return notes.canWrite && store.canWrite;
  }

  async function connectNotes(db, user) {
    let id = null;
    try {
      id = user ? await user.id() : null;
    } catch (_) { /* no private subtree this visit */ }
    if (!id) {
      notes.list = loadLocalNotes();
      indexNotes();
      render();
      return;
    }
    notes.mode = "cloud";
    notes.col = db.collection("data/users/" + id);
    notes.col.limit(1000).onSnapshot(snap => {
      notes.list = snap.docs
        .map(d => Object.assign({}, d.data(), { id: d.id }))
        .filter(n => n.kind === "note")
        .map(normalizeNote)
        .filter(Boolean);
      indexNotes();
      render();
    }, err => {
      toast(`توقفت مزامنة ملاحظاتك (${err && err.message ? err.message : "انقطع الاتصال"}). أعد تحميل الصفحة.`, true);
    });
  }

  async function persistNotes({ set = [], del = [] } = {}) {
    if (notes.mode === "local") {
      if (!writeJSON(NOTES_KEY, { version: 1, notes: notes.list })) {
        toast("تعذّر حفظ ملاحظاتك في هذا المتصفح (التخزين غير متاح أو ممتلئ).", true);
        return false;
      }
      return true;
    }
    const writes = [];
    set.forEach(n => writes.push(() => notes.col.doc(n.id).set({
      kind: "note", eventId: n.eventId, text: n.text, createdAt: n.createdAt, updatedAt: n.updatedAt
    })));
    del.forEach(id => writes.push(() => notes.col.doc(id).delete()));
    setStatus("saving");
    try {
      for (let i = 0; i < writes.length; i += 6) {
        await Promise.all(writes.slice(i, i + 6).map(w => w()));
      }
      setStatus("saved");
      return true;
    } catch (err) {
      setStatus("error");
      if (err && err.code === "invalid_argument") {
        notes.canWrite = false;
        toast("لا يمكنك إضافة ملاحظات في هذه الصفحة. اطلب من المالك صلاحية المشاركة.", true);
        render();
      } else {
        toast(`لم تُحفظ الملاحظة: ${err && err.message ? err.message : "خطأ غير معروف"}. تحقق من الاتصال ثم حاول مجددًا.`, true);
      }
      return false;
    }
  }

  function addNote(eventId, text) {
    text = text.trim();
    if (!text) return;
    const now = new Date().toISOString();
    const n = { id: uid(), eventId, text, createdAt: now, updatedAt: now };
    notes.list.push(n);
    indexNotes();
    ui.noteDrafts[eventId] = "";
    render();
    persistNotes({ set: [n] });
  }

  function updateNote(id, text) {
    text = text.trim();
    const n = notes.list.find(x => x.id === id);
    ui.editingNoteId = null;
    ui.editDraft = "";
    if (!n || !text || text === n.text) {
      render();
      return;
    }
    n.text = text;
    n.updatedAt = new Date().toISOString();
    indexNotes();
    render();
    persistNotes({ set: [n] });
  }

  function deleteNote(id) {
    const n = notes.list.find(x => x.id === id);
    if (!n) return;
    notes.list = notes.list.filter(x => x.id !== id);
    if (ui.editingNoteId === id) ui.editingNoteId = null;
    indexNotes();
    render();
    persistNotes({ del: [id] });
    toast("حُذفت الملاحظة.", false, {
      label: "تراجع",
      run: () => {
        if (notes.list.some(x => x.id === n.id)) return;
        notes.list.push(n);
        indexNotes();
        render();
        persistNotes({ set: [n] });
      }
    });
  }

  // Removes the viewer's notes on events that were just deleted.
  function dropNotesFor(eventIds) {
    const ids = new Set(eventIds);
    const gone = notes.list.filter(n => ids.has(n.eventId)).map(n => n.id);
    if (!gone.length) return;
    notes.list = notes.list.filter(n => !ids.has(n.eventId));
    indexNotes();
    persistNotes({ del: gone });
  }

  function formatNoteDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    try {
      return d.toLocaleDateString("ar-u-nu-latn", { day: "numeric", month: "long", year: "numeric" });
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  function setStatus(status) {
    store.status = status;
    renderStatus();
  }

  function renderStatus() {
    const node = document.getElementById("save-status");
    if (!node) return;
    let text, cls;
    if (store.loading) [text, cls] = ["جارٍ التحميل…", "pending"];
    else if (store.mode === "local") [text, cls] = ["محفوظ في هذا المتصفح فقط", "local"];
    else if (!store.canWrite) [text, cls] = ["للعرض فقط", "local"];
    else if (store.status === "saving") [text, cls] = ["جارٍ الحفظ…", "pending"];
    else if (store.status === "error") [text, cls] = ["لم يُحفظ", "error"];
    else [text, cls] = ["حُفظت كل التعديلات", "ok"];
    node.textContent = text;
    node.className = "save-status " + cls;
    node.title = store.mode === "cloud"
      ? "تُحفظ التعديلات في هذه الصفحة وتظهر على كل أجهزتك."
      : "تُحفظ التعديلات في هذا المتصفح فقط. استخدم التصدير لأخذ نسخة احتياطية.";
  }

  let toastTimer;
  // `action` ({label, run}) adds a button to the toast, e.g. undo.
  function toast(message, isError, action) {
    const node = document.getElementById("toast");
    node.textContent = message;
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        node.hidden = true;
        action.run();
      });
      node.append(" ", btn);
    }
    node.classList.toggle("error", Boolean(isError));
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 8000 : (action ? 6000 : 3500));
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
    writeJSON(PREFS_KEY, { view: ui.view, ppy: ui.ppy, hidden: [...ui.hidden], window: ui.window, onlyNoted: ui.onlyNoted });
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
    if (startYear === null) throw new Error(`الحدث "${e.title || "(بلا عنوان)"}" ليس له سنة بداية.`);
    let endYear = toInt(e.endYear);
    let endMonth = endYear === null ? null : toMonth(e.endMonth);
    const ev = {
      id: String(e.id || uid()),
      title: String(e.title || "حدث بلا عنوان").trim(),
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
    const q = normalizeQuran(e.quran);
    if (q) ev.quran = q;
    if (ev.endYear !== null && endOf(ev) <= startOf(ev)) {
      ev.endYear = null;
      ev.endMonth = null;
    }
    if (categoryIds) categoryIds.add(ev.category);
    return ev;
  }

  // { surah: 1–114, from, to } — from/to null means the whole Sura.
  function normalizeQuran(q) {
    if (!q || typeof q !== "object") return null;
    const s = surahInfo(toInt(q.surah));
    if (!s) return null;
    let from = toInt(q.from), to = toInt(q.to);
    if (from !== null && (from < 1 || from > s.ayat)) from = null;
    if (to !== null && (to < 1 || to > s.ayat)) to = null;
    if (from === null && to !== null) from = to;
    if (from !== null && to === null) to = from;
    if (from !== null && to < from) [from, to] = [to, from];
    if (from === 1 && to === s.ayat) from = to = null;
    return { surah: s.n, from, to };
  }

  function surahInfo(n) {
    const list = window.SURAHS || [];
    return n >= 1 && n <= list.length ? list[n - 1] : null;
  }

  function ayatLabel(q) {
    if (q.from === null) return "السورة كاملة";
    return q.from === q.to ? `الآية ${q.from}` : `الآيات ${q.from}–${q.to}`;
  }

  function quranTitle(q) {
    const s = surahInfo(q.surah);
    if (!s) return "";
    if (q.from === null) return `سورة ${s.name}`;
    return `سورة ${s.name} (${q.from === q.to ? q.from : `${q.from}–${q.to}`})`;
  }

  function quranLink(q) {
    return `https://quran.com/${q.surah}${q.from === null ? "" : `/${q.from}${q.to !== q.from ? `-${q.to}` : ""}`}`;
  }

  function isQuranCategory(id) {
    const c = data.categories.find(x => x.id === id);
    return Boolean(c && c.kind === "quran");
  }

  function normalizeData(raw) {
    const events = Array.isArray(raw) ? raw : raw.events;
    if (!Array.isArray(events)) throw new Error("الملف لا يحتوي على قائمة \"events\".");
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
      const cat = { id, name: String(c.name || id).trim(), color: validColor(c.color) || PALETTE[i % PALETTE.length] };
      if (c.kind === "quran") cat.kind = "quran";
      cats.push(cat);
    });
    used.forEach(id => {
      if (!catIds.has(id)) {
        catIds.add(id);
        cats.push({ id, name: id === "uncategorized" ? "بلا تصنيف" : id, color: PALETTE[cats.length % PALETTE.length] });
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
    return h >= 1 ? `${h} هـ` : `${1 - h} ق.هـ`;
  }

  function formatHijriRange(a, b) {
    if (a === b) return formatHijri(a);
    if (a >= 1 && b >= 1) return `${a}–${b} هـ`;
    if (a <= 0 && b <= 0) return `${1 - a}–${1 - b} ق.هـ`;
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
      if (a !== null && b !== null && b !== a) return `العمر نحو ${a}–${b}`;
      if (a === null && b !== null) return `إلى عمر نحو ${b}`;
    }
    return a === null ? "" : `العمر نحو ${a}`;
  }

  function formatYM(year, month) {
    return month ? `${MONTHS[month - 1]} ${year}` : String(year);
  }

  function dateLabel(e) {
    let s = (e.approximate ? "نحو " : "") + formatYM(e.startYear, e.startMonth);
    if (isSpan(e)) {
      s += e.endYear === e.startYear && e.startMonth && e.endMonth
        ? `–${MONTHS[e.endMonth - 1]} ${e.endYear}`
        : `–${formatYM(e.endYear, e.endMonth)}`;
    }
    return s + " م";
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
    return startOf(a) - startOf(b) || endOf(a) - endOf(b) || a.title.localeCompare(b.title, "ar");
  }

  // Search ignores harakat and the usual spelling variants (أ/إ/آ/ا, ة/ه, ى/ي).
  function normalizeText(t) {
    return String(t).toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/ى/g, "ي");
  }

  function matchesQuery(e) {
    if (!ui.query) return true;
    const q = normalizeText(ui.query);
    return [e.title, e.location, e.description, e.sources, categoryById(e.category).name]
      .concat(notesFor(e.id).map(n => n.text))
      .concat(e.quran && surahInfo(e.quran.surah) ? [`سورة ${surahInfo(e.quran.surah).name}`] : [])
      .some(f => f && normalizeText(f).includes(q));
  }

  function visibleCategories() {
    return data.categories.filter(c => !ui.hidden.has(c.id));
  }

  function visibleEvents() {
    return data.events
      .filter(e => !ui.hidden.has(e.category) && (!ui.onlyNoted || notesFor(e.id).length) && matchesQuery(e))
      .sort(sortChrono);
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
    el.notesView.hidden = ui.view !== "notes";
    if (ui.view === "timeline") renderTimeline();
    else if (ui.view === "grid") renderGrid();
    else renderNotesView();
    renderDetails();
  }

  function renderFilters() {
    const counts = {};
    data.events.forEach(e => { counts[e.category] = (counts[e.category] || 0) + 1; });
    el.filters.innerHTML = data.categories.map(c => `
      <button type="button" class="chip${ui.hidden.has(c.id) ? " off" : ""}" data-cat="${esc(c.id)}"
        aria-pressed="${!ui.hidden.has(c.id)}" style="--c:${c.color}">
        <span class="swatch"></span>${esc(c.name)}<span class="count">${counts[c.id] || 0}</span>
      </button>`).join("") + `
      <button type="button" class="chip noted-chip${ui.onlyNoted ? " on" : ""}" data-noted aria-pressed="${ui.onlyNoted}"
        title="إظهار الأحداث التي عليها ملاحظات فقط">
        ✎ لها ملاحظات<span class="count">${data.events.filter(e => notesFor(e.id).length).length}</span>
      </button>`;
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
      ticks += `<div class="tick" style="inset-inline-start:${x(y)}px"><span class="tick-ce">${y}</span><span class="tick-ah">${formatHijri(h)}</span></div>`;
    }
    const eras = ERAS.filter(r => r.to > minY && r.from < maxY).map(r => {
      const l = x(Math.max(r.from, minY));
      const w = x(Math.min(r.to, maxY)) - l;
      return `<div class="era" style="inset-inline-start:${l}px;width:${w}px" title="${esc(r.name)}"><span style="inset-inline-start:${LABEL_W + 8}px">${esc(r.name)}</span></div>`;
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
        const noteCount = notesFor(e.id).length;
        const badgeW = noteCount ? 34 : 0;
        const extent = span ? Math.max(barW, labelW + 16 + badgeW) : labelW + 22 + badgeW;
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
          style="inset-inline-start:${left}px;top:${LANE_PAD + row * ROW_H}px;${span ? `--bar:${barW}px;width:${extent}px;` : ""}"
          title="${esc(e.title)} — ${esc(dateLabel(e))}">
          ${span ? `<span class="bar"></span>` : `<span class="dot"></span>`}
          <span class="label" style="max-width:${MAX_LABEL_W}px;${span ? `inset-inline-start:${LABEL_W + 4}px;` : ""}">${esc(e.title)}</span>
          ${noteCount ? `<span class="note-badge" title="ملاحظاتك: ${noteCount}">✎ ${noteCount}</span>` : ""}
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
      band = `<div class="tl-band" style="inset-inline-start:${LABEL_W + l}px;width:${r - l}px"></div>`;
    }

    const empty = emptyMessage(cats, events);

    el.tlInner.style.width = `${LABEL_W + width}px`;
    el.tlInner.innerHTML = `
      <div class="tl-axis">
        <div class="tl-corner" style="width:${LABEL_W}px">ميلادي<br><span class="muted">هجري (تقريبي)</span></div>
        <div class="tl-axis-track" style="width:${width}px">${eras}${ticks}</div>
      </div>
      <div class="tl-lanes">${band}${lanes}</div>
      ${empty}`;
  }

  function emptyMessage(cats, events) {
    if (store.loading) return `<p class="tl-empty">جارٍ تحميل الخط الزمني…</p>`;
    if (!data.events.length) {
      return `<div class="tl-empty"><p><strong>لا توجد أحداث بعد.</strong></p><p>${store.canWrite
        ? "استخدم <strong>+ إضافة حدث</strong> لإضافة أول حدث، أو استورد ملف JSON من قائمة <strong>⋯</strong>."
        : "ستظهر الأحداث هنا عندما يضيفها المالك."}</p></div>`;
    }
    if (!data.categories.some(c => !ui.hidden.has(c.id)) || !cats.length) return `<p class="tl-empty">كل التصنيفات مخفية. فعّل أحدها من الأعلى.</p>`;
    if (!events.length && ui.onlyNoted && !ui.query) return `<p class="tl-empty">لا توجد أحداث عليها ملاحظات بعد. ألغِ فلتر «لها ملاحظات» لرؤية كل الأحداث.</p>`;
    if (!events.length) return `<p class="tl-empty">لا توجد أحداث تطابق بحثك.</p>`;
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
            <span class="g-title">${esc(e.title)}</span>${notesFor(e.id).length ? `<span class="note-badge" title="ملاحظاتك">✎ ${notesFor(e.id).length}</span>` : ""}${when ? `<span class="g-when">${esc(when)}</span>` : ""}
          </button>`;
        }).join("")}</td>`;
      });
      rows += `<tr class="${inWindow ? "in-window" : ""}" data-year="${y}">
        <th scope="row"><span class="g-year">${y}</span><span class="g-sub">${esc(h)}</span>${age !== null ? `<span class="g-sub">العمر نحو ${age}</span>` : ""}</th>
        ${cells}
      </tr>`;
    }
    el.gridScroll.innerHTML = `<table class="grid">
      <thead><tr><th scope="col">السنة (ميلادي)</th>${cats.map(c => `<th scope="col" style="--c:${c.color}"><span class="swatch"></span>${esc(c.name)}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Re-rendering replaces the textareas; keep the caret where the person was typing.
  function withFocusKept(container, fn) {
    const active = document.activeElement;
    const key = active && container.contains(active) && active.dataset ? active.dataset.focusKey : null;
    const range = key && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    fn();
    if (!key) return;
    const again = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (!again) return;
    again.focus();
    if (range) again.setSelectionRange(range[0], range[1]);
    autoGrow(again);
  }

  function autoGrow(t) {
    if (!t || t.tagName !== "TEXTAREA") return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight + 2, 320) + "px";
  }

  function noteCard(n) {
    if (ui.editingNoteId === n.id) {
      return `<article class="note editing" data-note="${esc(n.id)}">
        <textarea class="note-input" data-focus-key="edit-${esc(n.id)}" data-note-edit="${esc(n.id)}" rows="3" aria-label="تعديل الملاحظة">${esc(ui.editDraft)}</textarea>
        <div class="note-row">
          <span class="muted small">Ctrl+Enter للحفظ · Esc للإلغاء</span>
          <span class="note-tools">
            <button type="button" class="btn small" data-note-action="cancel">إلغاء</button>
            <button type="button" class="btn small primary" data-note-action="save">حفظ</button>
          </span>
        </div>
      </article>`;
    }
    const edited = n.updatedAt && n.updatedAt !== n.createdAt;
    return `<article class="note" data-note="${esc(n.id)}">
      <p class="note-text">${esc(n.text)}</p>
      <div class="note-row">
        <span class="muted small">${esc(formatNoteDate(n.createdAt))}${edited ? " · عُدّلت" : ""}</span>
        ${canWriteNotes() ? `<span class="note-tools">
          <button type="button" class="text-btn" data-note-action="edit">تعديل</button>
          <button type="button" class="text-btn danger" data-note-action="delete">حذف</button>
        </span>` : ""}
      </div>
    </article>`;
  }

  function renderNotesSection(sel) {
    const list = notesFor(sel.id);
    const draft = ui.noteDrafts[sel.id] || "";
    return `<section class="d-notes" aria-label="ملاحظاتي">
      <div class="d-notes-head">
        <h3>ملاحظاتي <span class="count">${list.length}</span></h3>
        <span class="muted small">🔒 ملاحظاتك خاصة بك ولا يراها غيرك</span>
      </div>
      ${canWriteNotes() ? `<div class="note-composer">
        <textarea id="note-composer" class="note-input" data-focus-key="composer" data-event="${esc(sel.id)}" rows="2"
          placeholder="اكتب ملاحظة… (فائدة، سؤال، مرجع)" aria-label="ملاحظة جديدة">${esc(draft)}</textarea>
        <div class="note-row">
          <span class="muted small">Ctrl+Enter للحفظ</span>
          <button type="button" class="btn small primary" data-note-action="add" ${draft.trim() ? "" : "disabled"}>إضافة</button>
        </div>
      </div>` : ""}
      ${list.length ? `<div class="note-list">${list.map(noteCard).join("")}</div>` : ""}
    </section>`;
  }

  function renderDetails() {
    withFocusKept(el.detailsContent, renderDetailsNow);
  }

  function renderDetailsNow() {
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
        <button type="button" class="btn small" data-goto="${prev ? esc(prev.id) : ""}" ${prev ? "" : "disabled"} title="الحدث السابق">→ السابق</button>
        <button type="button" class="btn small" data-action="close" title="إغلاق (Esc)">إغلاق</button>
        <button type="button" class="btn small" data-goto="${next ? esc(next.id) : ""}" ${next ? "" : "disabled"} title="الحدث التالي">التالي ←</button>
      </div>
      <span class="cat-pill" style="--c:${cat.color}"><span class="swatch"></span>${esc(cat.name)}</span>
      <h2 class="d-title">${esc(sel.title)}</h2>
      <p class="d-date">${esc(dateLabel(sel))} · ${esc(hijriLabel(sel))}${age ? ` · ${esc(age)}` : ""}</p>
      ${sel.quran && surahInfo(sel.quran.surah) ? (() => {
        const s = surahInfo(sel.quran.surah);
        return `<p class="d-quran">
          <span class="d-quran-ref">سورة ${esc(s.name)} · ${esc(ayatLabel(sel.quran))} · ${s.type} · ترتيب النزول ${s.order}</span>
          <a href="${quranLink(sel.quran)}" target="_blank" rel="noopener noreferrer">اقرأ الآيات ↗</a>
        </p>`;
      })() : ""}
      ${sel.location ? `<p class="d-loc">📍 ${esc(sel.location)}</p>` : ""}
      ${sel.description ? `<p class="d-desc">${esc(sel.description)}</p>` : ""}
      ${sel.sources ? `<p class="d-src"><strong>المصادر:</strong> ${esc(sel.sources)}</p>` : ""}
      <div class="d-actions">
        <button type="button" class="btn needs-write" data-action="edit">تعديل</button>
        <button type="button" class="btn needs-write" data-action="add-near">+ إضافة حدث في هذا الوقت</button>
      </div>
      ${renderNotesSection(sel)}
      <div class="d-concurrent">
        <div class="d-conc-head">
          <h3>في الفترة نفسها <span class="count">${conc.length}</span></h3>
          <select id="window-select" aria-label="مدى التقارب الزمني">
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
          </div>`).join("") : `<p class="muted">لا شيء آخر في هذه الفترة${ui.query || ui.hidden.size ? " (مع عوامل التصفية الحالية)" : ""}.</p>`}
      </div>`;
  }

  function renderNotesView() {
    withFocusKept(el.notesList, renderNotesViewNow);
  }

  function renderNotesViewNow() {
    if (store.loading) {
      el.notesList.innerHTML = `<p class="tl-empty">جارٍ تحميل ملاحظاتك…</p>`;
      return;
    }
    if (!notes.list.length) {
      el.notesList.innerHTML = `<div class="tl-empty"><p><strong>لا ملاحظات بعد.</strong></p>
        <p>اختر حدثًا من الخط الزمني واكتب ملاحظتك في لوحة التفاصيل. ملاحظاتك خاصة بك ولا يراها غيرك.</p></div>`;
      return;
    }
    const q = ui.query ? normalizeText(ui.query) : "";
    const byId = new Map(data.events.map(e => [e.id, e]));
    const groups = [];
    data.events.filter(e => notesFor(e.id).length && !ui.hidden.has(e.category)).sort(sortChrono).forEach(e => {
      let list = notesFor(e.id);
      if (q && !normalizeText(e.title).includes(q)) list = list.filter(n => normalizeText(n.text).includes(q));
      if (list.length) groups.push({ e, list });
    });
    const orphans = notes.list
      .filter(n => !byId.has(n.eventId) && (!q || normalizeText(n.text).includes(q)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = groups.reduce((sum, g) => sum + g.list.length, 0) + orphans.length;
    if (!total) {
      el.notesList.innerHTML = `<p class="tl-empty">لا توجد ملاحظات تطابق البحث أو التصنيفات المختارة.</p>`;
      return;
    }
    el.notesList.innerHTML = `
      <p class="notes-summary muted">${total} ملاحظة على ${groups.length + (orphans.length ? 1 : 0)} حدث · مرتبة بحسب السيرة</p>
      ${groups.map(({ e, list }) => {
        const cat = categoryById(e.category);
        return `<section class="notes-group${e.id === ui.selectedId ? " is-selected" : ""}" style="--c:${cat.color}">
          <button type="button" class="notes-group-head" data-open-event="${esc(e.id)}" title="عرض الحدث على الخط الزمني">
            <span class="swatch"></span>
            <span class="ng-title">${esc(e.title)}</span>
            <span class="ng-date">${esc(dateLabel(e))} · ${esc(hijriLabel(e))}</span>
          </button>
          <div class="note-list">${list.map(noteCard).join("")}</div>
        </section>`;
      }).join("")}
      ${orphans.length ? `<section class="notes-group orphan" style="--c:var(--muted)">
        <div class="notes-group-head static"><span class="swatch"></span><span class="ng-title">أحداث محذوفة</span>
          <span class="ng-date">ملاحظات على أحداث لم تعد في الخط الزمني</span></div>
        <div class="note-list">${orphans.map(noteCard).join("")}</div>
      </section>` : ""}`;
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
      // One combined scroll: a separate scrollIntoView would cancel the horizontal one.
      const start = parseFloat(node.style.getPropertyValue("inset-inline-start")) || 0;
      const target = Math.max(0, start + LABEL_W - el.tlScroll.clientWidth / 2 + 80);
      const box = el.tlScroll.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      const axisH = 62;
      let top = el.tlScroll.scrollTop;
      if (r.top < box.top + axisH || r.bottom > box.bottom) top += r.top - box.top - axisH - 40;
      el.tlScroll.scrollTo({ left: RTL ? -target : target, top: Math.max(0, top), behavior: "smooth" });
    } else {
      node.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }

  // Distance scrolled from the start edge of the timeline (the right edge in RTL).
  function scrollStart() {
    return Math.abs(el.tlScroll.scrollLeft);
  }

  function setScrollStart(v, smooth) {
    const left = RTL ? -v : v;
    if (smooth) el.tlScroll.scrollTo({ left, behavior: "smooth" });
    else el.tlScroll.scrollLeft = left;
  }

  function setZoom(ppy, anchorClientX) {
    const old = ui.ppy;
    ppy = clamp(Math.round(ppy * 100) / 100, MIN_PPY, MAX_PPY);
    if (ppy === old) return;
    const rect = el.tlScroll.getBoundingClientRect();
    const anchor = anchorClientX === undefined ? rect.width / 2 : (RTL ? rect.right - anchorClientX : anchorClientX - rect.left);
    const yearAtAnchor = (scrollStart() + anchor - LABEL_W) / old;
    ui.ppy = ppy;
    savePrefs();
    renderTimeline();
    setScrollStart(yearAtAnchor * ppy + LABEL_W - anchor);
  }

  function fitZoom() {
    const events = visibleEvents();
    const [minY, maxY] = yearRange(events.length ? events : data.events);
    const avail = el.tlScroll.clientWidth - LABEL_W - 8;
    setZoom(Math.max(MIN_PPY, avail / (maxY - minY)));
    setScrollStart(0);
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
      .join("") + `<option value="__new">+ تصنيف جديد…</option>`;
  }

  function fillSurahSelect() {
    const sel = el.eventForm.elements.surah;
    if (sel.options.length > 1) return;
    sel.innerHTML = `<option value="">— اختر السورة —</option>` +
      (window.SURAHS || []).map(s => `<option value="${s.n}">${s.n} · ${esc(s.name)}</option>`).join("");
  }

  // Show the Sura fields only for a Quran category, and keep the hint and limits current.
  function syncQuranFields() {
    const f = el.eventForm.elements;
    const on = isQuranCategory(f.category.value);
    $("#quran-fields").hidden = !on;
    const s = surahInfo(toInt(f.surah.value));
    f.ayahFrom.max = f.ayahTo.max = s ? s.ayat : "";
    $("#surah-hint").textContent = s ? `${s.type} · ${s.ayat} آية · ترتيب النزول ${s.order}` : "";
  }

  // Fill the title from the Sura while it is empty or still the last auto title.
  function autoQuranTitle() {
    const f = el.eventForm.elements;
    const q = readQuran();
    if (!q) return;
    const t = quranTitle(q);
    if (!f.title.value.trim() || f.title.value === ui.autoTitle) {
      f.title.value = t;
      ui.autoTitle = t;
    }
  }

  function readQuran() {
    const f = el.eventForm.elements;
    if (!isQuranCategory(f.category.value)) return null;
    const n = toInt(f.surah.value);
    if (!surahInfo(n)) return null;
    return normalizeQuran({ surah: n, from: f.ayahFrom.value, to: f.ayahTo.value });
  }

  function openEventDialog(ev, defaults) {
    ui.editingId = ev ? ev.id : null;
    const f = el.eventForm.elements;
    const src = ev || Object.assign({ title: "", category: data.categories[0] ? data.categories[0].id : "", startYear: "", startMonth: null,
      endYear: null, endMonth: null, approximate: false, location: "", description: "", sources: "" }, defaults || {});
    $("#event-dialog-title").textContent = ev ? "تعديل الحدث" : "إضافة حدث";
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
    fillSurahSelect();
    f.surah.value = src.quran ? src.quran.surah : "";
    f.ayahFrom.value = src.quran && src.quran.from !== null ? src.quran.from : "";
    f.ayahTo.value = src.quran && src.quran.to !== null ? src.quran.to : "";
    ui.autoTitle = src.quran ? quranTitle(src.quran) : "";
    syncQuranFields();
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
      sources: f.sources.value.trim(),
      quran: readQuran()
    };
  }

  function validateForm(v) {
    if (!v.title) return "اكتب عنوانًا للحدث.";
    if (!v.category || v.category === "__new") return "اختر تصنيفًا.";
    if (v.startYear === null) return "اكتب سنة البداية.";
    if (v.startYear < 1 || v.startYear > 3000 || (v.endYear !== null && (v.endYear < 1 || v.endYear > 3000))) return "اكتب سنة بين 1 و3000.";
    if (v.endYear === null && v.endMonth) return "اكتب سنة النهاية، أو امسح شهر النهاية.";
    if (v.endYear !== null && endOf(v) <= startOf(v)) return "يجب أن تكون النهاية بعد البداية.";
    if (isQuranCategory(v.category)) {
      const f = el.eventForm.elements;
      const s = surahInfo(toInt(f.surah.value));
      if (!s) return "اختر السورة.";
      const from = toInt(f.ayahFrom.value), to = toInt(f.ayahTo.value);
      for (const a of [from, to]) {
        if (a !== null && (a < 1 || a > s.ayat)) return `سورة ${s.name} ${s.ayat} آية، فاكتب رقم آية بين 1 و${s.ayat}.`;
      }
      if (from !== null && to !== null && to < from) return "رقم الآية الأخيرة يجب ألا يقل عن الأولى.";
    }
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
      <input type="color" value="${esc(c.color)}" aria-label="اللون">
      <input type="text" value="${esc(c.name)}" aria-label="الاسم" maxlength="60">
      <button type="button" class="btn small" data-move="-1" aria-label="تحريك لأعلى">↑</button>
      <button type="button" class="btn small" data-move="1" aria-label="تحريك لأسفل">↓</button>
      <button type="button" class="btn small danger" data-remove aria-label="حذف">✕</button>
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
        el.catError.textContent = "لكل تصنيف اسم لا بد منه.";
        return false;
      }
      const cat = { id: r.dataset.id, name, color: r.querySelector('input[type="color"]').value };
      const old = data.categories.find(c => c.id === r.dataset.id);
      if (old && old.kind) cat.kind = old.kind;
      next.push(cat);
    }
    const keep = new Set(next.filter(c => c.id).map(c => c.id));
    const removed = data.categories.filter(c => !keep.has(c.id));
    const orphaned = data.events.filter(e => removed.some(c => c.id === e.category));
    if (orphaned.length) {
      const names = removed.filter(c => orphaned.some(e => e.category === c.id)).map(c => `"${c.name}"`).join(", ");
      const yes = await ask({
        title: "حذف الأحداث أيضًا؟",
        message: `عدد الأحداث في ${names}: ${orphaned.length}. حذف التصنيف يحذفها معه.`,
        okLabel: `حذف الأحداث (${orphaned.length})`,
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
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: data.categories,
      events: [...data.events].sort(sortChrono),
      notes: notes.list // only the viewer's own notes
    };
    const json = JSON.stringify(payload, null, 2);
    const filename = `seerah-timeline-${new Date().toISOString().slice(0, 10)}.json`;
    if (window.claude && typeof window.claude.use === "function") {
      // Hosted pages can't start downloads themselves; the viewer confirms the save.
      const downloads = await window.claude.use("downloads").catch(() => null);
      if (downloads) {
        try {
          await downloads.save({ filename, data: json });
        } catch (err) {
          if (!err || err.code !== "declined") toast(`فشل التصدير: ${err && err.message ? err.message : "خطأ غير معروف"}.`, true);
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
      let next, importedNotes = null;
      try {
        const raw = JSON.parse(reader.result);
        next = normalizeData(raw);
        if (raw && Array.isArray(raw.notes)) importedNotes = raw.notes.map(normalizeNote).filter(Boolean);
      } catch (err) {
        toast(`تعذّر استيراد "${file.name}": ${err.message}`, true);
        return;
      }
      const yes = await ask({
        title: "استبدال كل الأحداث؟",
        message: `سيُستبدل بأحداثك الحالية (${data.events.length}) ما في الملف "${file.name}" (${next.events.length}).`
          + (importedNotes ? ` وستُستبدل ملاحظاتك (${notes.list.length}) بملاحظات الملف (${importedNotes.length}).` : ""),
        okLabel: "استبدال",
        danger: true
      });
      if (!yes) return;
      if (importedNotes) {
        const old = notes.list.map(n => n.id);
        notes.list = importedNotes;
        indexNotes();
        persistNotes({ set: importedNotes, del: old.filter(id => !importedNotes.some(n => n.id === id)) });
      }
      if (await replaceAll(next)) toast(`تم استيراد ${next.events.length} حدثًا.`);
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
      if (e.target.closest("[data-noted]")) {
        ui.onlyNoted = !ui.onlyNoted;
        savePrefs();
        render();
        return;
      }
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
    // Notes: shared handlers for the details panel and the notes view.
    const noteEvents = container => {
      container.addEventListener("input", e => {
        const t = e.target;
        if (t.dataset.focusKey === "composer") {
          ui.noteDrafts[t.dataset.event] = t.value;
          const add = t.closest(".note-composer").querySelector('[data-note-action="add"]');
          if (add) add.disabled = !t.value.trim();
          autoGrow(t);
        } else if (t.dataset.noteEdit) {
          ui.editDraft = t.value;
          autoGrow(t);
        }
      });
      container.addEventListener("keydown", e => {
        const t = e.target;
        if (t.tagName !== "TEXTAREA") return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          if (t.dataset.focusKey === "composer") addNote(t.dataset.event, t.value);
          else if (t.dataset.noteEdit) updateNote(t.dataset.noteEdit, t.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          if (t.dataset.focusKey === "composer") {
            ui.noteDrafts[t.dataset.event] = "";
            t.value = "";
            t.blur();
            render();
          } else if (t.dataset.noteEdit) {
            ui.editingNoteId = null;
            render();
          }
        }
      });
      container.addEventListener("click", e => {
        const open = e.target.closest("[data-open-event]");
        if (open) {
          ui.view = "timeline";
          savePrefs();
          select(open.dataset.openEvent, { scroll: true });
          return;
        }
        const btn = e.target.closest("[data-note-action]");
        if (!btn) return;
        e.stopPropagation();
        const action = btn.dataset.noteAction;
        if (action === "add") {
          const t = container.querySelector('[data-focus-key="composer"]');
          if (t) addNote(t.dataset.event, t.value);
          return;
        }
        const card = btn.closest("[data-note]");
        const id = card && card.dataset.note;
        if (!id) return;
        if (action === "edit") {
          const n = notes.list.find(x => x.id === id);
          ui.editingNoteId = id;
          ui.editDraft = n ? n.text : "";
          render();
          const t = document.querySelector(`[data-note-edit="${CSS.escape(id)}"]`);
          if (t) {
            t.focus();
            t.setSelectionRange(t.value.length, t.value.length);
            autoGrow(t);
          }
        } else if (action === "cancel") {
          ui.editingNoteId = null;
          render();
        } else if (action === "save") {
          updateNote(id, ui.editDraft);
        } else if (action === "delete") {
          deleteNote(id);
        }
      });
    };
    noteEvents(el.detailsContent);
    noteEvents(el.notesList);

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
    el.eventForm.addEventListener("input", e => {
      if (["surah", "ayahFrom", "ayahTo"].includes(e.target.name)) {
        syncQuranFields();
        autoQuranTitle();
      }
      el.formError.textContent = "";
      updateDatePreview();
    });
    el.categorySelect.addEventListener("change", async () => {
      if (el.categorySelect.value !== "__new") {
        el.categorySelect.dataset.prev = el.categorySelect.value;
        syncQuranFields();
        return;
      }
      const name = await ask({ title: "تصنيف جديد", input: { label: "الاسم", value: "" }, okLabel: "إضافة التصنيف" });
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
      const own = notesFor(ev.id).length;
      const yes = await ask({
        title: "حذف هذا الحدث؟",
        message: `سيُحذف "${ev.title}" من الخط الزمني.${own ? ` وستُحذف ملاحظاتك عليه (${own}).` : ""}`,
        okLabel: "حذف",
        danger: true
      });
      if (!yes) return;
      dropNotesFor([ev.id]);
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
        title: "استعادة البيانات النموذجية؟",
        message: "ستُستبدل كل أحداثك وتصنيفاتك بالبيانات النموذجية. صدّر نسخة أولًا إن أردت الاحتفاظ بتعديلاتك.",
        okLabel: "استعادة",
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
      if (e.code === "KeyN" && !e.ctrlKey && !e.metaKey && !e.altKey && ui.selectedId) {
        const composer = document.getElementById("note-composer");
        if (composer) {
          e.preventDefault();
          composer.focus();
        }
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && ui.selectedId) {
        const back = RTL ? e.key === "ArrowRight" : e.key === "ArrowLeft";
        const btn = el.detailsContent.querySelectorAll(".d-nav [data-goto]")[back ? 0 : 1];
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
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      measureCtx = null;
      if (ui.view === "timeline") renderTimeline();
    });
  }
})();
