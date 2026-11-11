/* השחיה שלי - דשבורד שחיה מנתוני Garmin */
(() => {
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const DATA_URL = "data/activities.enc.json";
const USER_URL = "data/user.enc.json";
const LS = { pw: "swim.pw", settings: "swim.settings", user: "swim.user", sel: "swim.sel" };
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

const state = {
  raw: null, password: null, demo: false, swims: [], other: [], sel: 0,
  user: { corrections: {}, bloodTests: [], updatedAt: 0 },
  settings: Object.assign({ lengthsPerSet: 10, pool: 20, repo: guessRepo(), token: "" }, lsGet(LS.settings, {})),
};
if (!state.settings.repo) state.settings.repo = guessRepo();

function guessRepo() {
  const h = location.hostname;
  if (h.endsWith(".github.io")) {
    const seg = location.pathname.split("/").filter(Boolean)[0];
    return h.replace(".github.io", "") + "/" + (seg || h);
  }
  return "evyatar-elad/swim-dashboard"; // כתובת מותאמת (sport.evyatar-elad.com)
}

/* ---------- הצפנה (תואם ל-fetch/crypto_util.py) ---------- */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u8) => { let s = ""; u8.forEach((b) => (s += String.fromCharCode(b))); return btoa(s); };
async function deriveKey(pw, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function decryptEnv(env, pw) {
  const key = await deriveKey(pw, b64(env.salt), env.iter || 250000);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, key, b64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function encryptObj(obj, pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt, 250000);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iter: 250000, salt: toB64(salt), iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

/* ---------- עיצוב מספרים ---------- */
const pad = (n) => String(n).padStart(2, "0");
function mmss(sec) {
  if (sec == null || !isFinite(sec)) return "-";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
const n0 = (v) => (v == null || !isFinite(v) ? "-" : Math.round(v).toLocaleString("he-IL"));
const num = (s) => `<span class="num">${s}</span>`;
const HEB_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const HEB_MON = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const parseLocal = (s) => new Date((s || "").replace(" ", "T"));
const parseGMT = (s) => new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
const fmtDate = (d) => `יום ${HEB_DAYS[d.getDay()]}, ${d.getDate()} ב${HEB_MON[d.getMonth()]}`;
const fmtShort = (d) => `${d.getDate()}.${d.getMonth() + 1}`;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/* ---------- עיבוד שחיה ותיקון בריכות ---------- */
function poolLen(s) {
  let p = s.poolLength;
  if (!p) return state.settings.pool;
  const f = s.unitOfPoolLength && s.unitOfPoolLength.factor;
  if (f) p = p / f; else if (p > 100) p = p / 100;
  return Math.round(p * 10) / 10;
}

// מאחד "בריכות" קצרות מדי שנוצרו מעצירה/סידור משקפת באמצע בריכה אמיתית,
// ומפצל "בריכה כפולה" (שתי בריכות שנרשמו כאחת, פי 2 זמן ותנועות)
// בריכה "חשודה" = קצרה מדי וגם עם מעט תנועות (חלק מבריכה).
// בריכה מהירה עם מספר תנועות רגיל (למשל בריכה בחתירה) היא בריכה מלאה.
// לא סומכים על זיהוי הסגנון של השעון - הוא טועה הרבה בחזה.
function isSuspect(l, ref, refStrokes) {
  if (l.duration >= ref * 0.6) return false;
  return !refStrokes || l.strokes < refStrokes * 0.6;
}
function mergeLengths(lengths, ref, refStrokes, mainStroke) {
  const out = []; let buf = null;
  const add = (m, l) => { m.duration += l.duration; m.strokes += l.strokes; m.parts += l.parts || 1; };
  for (const l of lengths) {
    if (!isSuspect(l, ref, refStrokes)) {
      const m = { duration: l.duration, strokes: l.strokes, parts: 1 };
      if (buf) { if (buf.duration >= ref * 0.72) out.push(buf); else if (out.length) add(out[out.length - 1], buf); else add(m, buf); buf = null; }
      out.push(m); continue;
    }
    if (!buf) buf = { duration: 0, strokes: 0, parts: 0 };
    add(buf, l);
    if (buf.duration >= ref * 0.72) { out.push(buf); buf = null; }
  }
  if (buf) { if (out.length && buf.duration < ref * 0.5) add(out[out.length - 1], buf); else out.push(buf); }
  return out.flatMap((m) => m.parts === 1 && m.duration > ref * 1.7 && refStrokes && m.strokes > refStrokes * 1.6
    ? [{ ...m, duration: m.duration / 2, strokes: m.strokes / 2 }, { ...m, duration: m.duration / 2, strokes: m.strokes / 2 }] : [m]);
}

// "בריכה" שהיא בעצם מנוחה: אורך 0, סגנון REST, או בלי תנועות בכלל
const isIdle = (l) => l.distance === 0 || /REST|IDLE/i.test(l.swimStroke || "") || ((l.totalNumberOfStrokes || 0) === 0 && (l.distance || 0) === 0);

// מתאים את ספירת הסטים לסה"כ ידוע (למשל אחרי שערכת את המרחק באתר של גרמין)
function fitToTotal(counts, target, exp) {
  const c = counts.slice(); let guard = 200;
  while (c.reduce((a, b) => a + b, 0) > target && guard--) { let k = 0; c.forEach((v, i) => { if (v - exp > c[k] - exp) k = i; }); c[k]--; }
  while (c.reduce((a, b) => a + b, 0) < target && guard--) { let k = 0; c.forEach((v, i) => { if (v < c[k]) k = i; }); c[k]++; }
  return c;
}

function processSwim(id, raw) {
  const s = raw.summary || {};
  const pool = poolLen(s);
  const exp = +state.settings.lengthsPerSet || 10;
  const laps = (raw.laps || []).slice().sort((a, b) => parseGMT(a.startTimeGMT || "") - parseGMT(b.startTimeGMT || ""));
  const sets = []; let leadRest = 0;
  laps.forEach((lap) => {
    const all = lap.lengthDTOs || [];
    const lens = all.filter((l) => !isIdle(l));
    const idleSecs = all.filter(isIdle).reduce((a, l) => a + (l.duration || 0), 0);
    const active = lens.length > 0 || ((lap.distance || 0) > 0 && !all.length);
    if (!active) { const r = lap.duration || idleSecs || 0; if (sets.length) sets[sets.length - 1].rest += r; else leadRest += r; return; }
    let lengths = lens.map((l) => ({ duration: l.duration || l.movingDuration || 0, strokes: l.totalNumberOfStrokes || 0, hr: l.averageHR, maxHR: l.maxHR, stroke: l.swimStroke }));
    if (!lengths.length) {
      const n = Math.round((lap.distance || 0) / pool) || 1;
      lengths = Array.from({ length: n }, () => ({ duration: (lap.duration || 0) / n, strokes: (lap.totalNumberOfStrokes || 0) / n }));
    }
    const set = { lap, lengths, rest: idleSecs, idleInside: idleSecs, start: parseGMT(lap.startTimeGMT || ""), avgHR: lap.averageHR, maxHR: lap.maxHR };
    const prev = sets[sets.length - 1];
    if (prev && prev.rest === 0 && !isNaN(set.start) && !isNaN(prev.start)) {
      const gap = (set.start - prev.start) / 1000 - (prev.lap.duration || 0);
      if (gap > 3) prev.rest = gap;
    }
    sets.push(set);
  });
  const allDur = sets.flatMap((x) => x.lengths.map((l) => l.duration)).filter((d) => d > 0);
  const ref = pct(allDur, 0.65) || 35;
  const refStrokes = median(sets.flatMap((x) => x.lengths.filter((l) => l.duration >= ref * 0.6).map((l) => l.strokes)));
  const strokeCount = {}; sets.forEach((x) => x.lengths.forEach((l) => { if (l.stroke) strokeCount[l.stroke] = (strokeCount[l.stroke] || 0) + 1; }));
  const mainStroke = Object.keys(strokeCount).sort((a, b) => strokeCount[b] - strokeCount[a])[0];
  const corr = (state.user.corrections || {})[id] || {};
  const aiRev = ((state.raw && state.raw.ai && state.raw.ai.length_review) || []).find((r) => String(r.activity_id) === String(id));
  const aiOk = aiRev && aiRev.set_lengths && aiRev.set_lengths.length === sets.length;
  const watchLengths = sets.reduce((a, x) => a + x.lengths.length, 0);
  // מה שמופיע באתר של גרמין (אם ערכת שם את המרחק - זה הערך הערוך)
  const garminLengths = s.distance ? Math.round(s.distance / pool) : watchLengths;
  const garminEdited = sets.length > 0 && Math.abs(garminLengths - watchLengths) >= 1 && s.distance > 0;
  let algo = sets.map((x) => mergeLengths(x.lengths, ref, refStrokes, mainStroke).length);
  let source = "algo";
  if (aiOk) { algo = aiRev.set_lengths.slice(); source = "ai"; }
  else if (garminEdited) { algo = fitToTotal(algo, garminLengths, exp); source = "garmin"; }
  let swimTime = 0, restTime = 0, strokes = 0, corrLengths = 0;
  sets.forEach((set, i) => {
    set.idx = i + 1;
    set.watch = set.lengths.length;
    set.suspects = set.lengths.map((l) => isSuspect(l, ref, refStrokes));
    set.auto = algo[i];
    set.manual = corr[i + 1] != null ? corr[i + 1] : null;
    set.count = set.manual != null ? set.manual : set.auto;
    set.time = set.lengths.reduce((a, l) => a + l.duration, 0) || set.lap.duration || 0;
    set.strokes = set.lengths.reduce((a, l) => a + l.strokes, 0);
    set.dist = set.count * pool;
    set.pace = set.dist ? (set.time / set.dist) * 100 : null;
    set.swolf = set.count ? set.time / set.count + set.strokes / set.count : null;
    swimTime += set.time; restTime += set.rest; strokes += set.strokes; corrLengths += set.count;
  });
  if (sets.length) sets[sets.length - 1].rest = 0; // אחרי הסט האחרון אין "מנוחה"
  restTime = sets.reduce((a, x) => a + x.rest, 0);
  const start = parseLocal(s.startTimeLocal);
  const elapsed = s.elapsedDuration || s.duration || swimTime + restTime;
  if (!sets.length) { corrLengths = garminLengths || s.activeLengths || 0; swimTime = s.movingDuration || s.duration || 0; strokes = s.strokes || 0; }
  const rests = sets.slice(0, -1).map((x) => x.rest).filter((r) => r > 0);
  const dist = corrLengths * pool;
  let zones = null;
  if (Array.isArray(raw.hrZones) && raw.hrZones.length) zones = raw.hrZones.slice().sort((a, b) => a.zoneNumber - b.zoneNumber).map((z) => z.secsInZone || 0);
  else if (s.hrTimeInZone_1 != null) zones = [1, 2, 3, 4, 5].map((k) => s["hrTimeInZone_" + k] || 0);
  const zoneBounds = Array.isArray(raw.hrZones) ? raw.hrZones.slice().sort((a, b) => a.zoneNumber - b.zoneNumber).map((z) => z.zoneLowBoundary) : null;
  const peakSet = sets.filter((x) => x.maxHR).reduce((a, b) => (!a || b.maxHR > a.maxHR ? b : a), null);
  return {
    id, start, pool, sets, ref, zones, mainStroke, zoneBounds, source,
    watchLengths, garminLengths, garminEdited, lengths: corrLengths, dist,
    corrected: watchLengths !== corrLengths, manual: Object.keys(corr).length > 0, aiReview: aiOk ? aiRev : null,
    swimTime, restTime, rests, avgRest: rests.length ? rests.reduce((a, b) => a + b, 0) / rests.length : null,
    maxRest: rests.length ? Math.max(...rests) : null, elapsed,
    pace: dist ? (swimTime / dist) * 100 : null,
    avgHR: s.averageHR, maxHR: s.maxHR, peakSet: peakSet && peakSet.idx, calories: s.calories, bmr: s.bmrCalories,
    strokes, spl: corrLengths ? strokes / corrLengths : null,
    swolf: corrLengths ? swimTime / corrLengths + strokes / corrLengths : s.averageSwolf,
  };
}

function rebuild() {
  const raw = state.raw || { swims: {}, other: {} };
  // מסננים "שחיות" של בדיקה (פחות מ-100 מ', למשל כשרק ניסית את השעון)
  const all = Object.entries(raw.swims || {}).map(([id, r]) => processSwim(id, r)).filter((x) => !isNaN(x.start));
  state.hidden = all.filter((x) => x.dist < 100).length;
  state.swims = all.filter((x) => x.dist >= 100).sort((a, b) => a.start - b.start);
  state.other = Object.values(raw.other || {}).map((o) => ({ ...o.summary, start: parseLocal(o.summary.startTimeLocal) }));
  if (state.sel >= state.swims.length || state.sel < 0) state.sel = state.swims.length - 1;
}

const STROKE_HE = { BREASTSTROKE: "חזה", FREESTYLE: "חתירה", BACKSTROKE: "גב", BUTTERFLY: "פרפר", MIXED: "מעורב", DRILL: "תרגיל" };
/* ---------- השוואות ---------- */
const cur = () => state.swims[state.sel];
const prevOf = (i) => (i > 0 ? state.swims[i - 1] : null);
const ai = () => (state.raw && state.raw.ai) || null;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function avgBefore(i, k) {
  const v = state.swims.slice(0, i).map((s) => s[k]).filter((x) => x != null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
// האם זה שיא אישי (מבין כל השחיות עד עכשיו)
function isRecord(i, k, lowerBetter) {
  const v = state.swims[i][k]; if (v == null || i < 2) return false;
  const others = state.swims.slice(0, i).map((s) => s[k]).filter((x) => x != null && isFinite(x));
  return others.length >= 2 && (lowerBetter ? v < Math.min(...others) : v > Math.max(...others));
}
// משפט השוואה: "מהיר ב-0:03 מהפעם הקודמת"
const METRICS = {
  pace: { lower: true, fmt: mmss, better: "מהיר", worse: "איטי", thr: 1 },
  avgRest: { lower: true, fmt: mmss, better: "קצרה", worse: "ארוכה", thr: 2 },
  restTime: { lower: true, fmt: mmss, better: "קצר", worse: "ארוך", thr: 5 },
  elapsed: { lower: true, fmt: mmss, better: "קצר", worse: "ארוך", thr: 10 },
  swolf: { lower: true, fmt: (v) => Math.round(v), better: "יעיל", worse: "פחות יעיל", thr: 1 },
  avgHR: { fmt: (v) => Math.round(v), better: "גבוה", worse: "נמוך", thr: 2, neutral: true },
  maxHR: { fmt: (v) => Math.round(v), better: "גבוה", worse: "נמוך", thr: 2, neutral: true },
};
function cmp(k, v, ref) {
  const m = METRICS[k]; if (v == null || ref == null || !isFinite(v) || !isFinite(ref)) return null;
  const d = v - ref;
  if (Math.abs(d) < m.thr) return { same: true, txt: "כמעט זהה" };
  const up = d > 0, good = m.neutral ? null : (m.lower ? !up : up);
  const word = m.neutral ? (up ? "גבוה" : "נמוך") : (good ? m.better : m.worse);
  return { good, up, txt: `${word} ב-${m.fmt(Math.abs(d))}` };
}
function cmpPair(k, w, i) {
  const p = prevOf(i), a = avgBefore(i, k);
  return { prev: p ? cmp(k, w[k], p[k]) : null, avg: i >= 2 ? cmp(k, w[k], a) : null, prevV: p && p[k], avgV: a };
}
const tag = (c) => !c ? "" : c.same ? `<span class="pill same">${c.txt}</span>` : `<span class="pill ${c.good === true ? "good" : c.good === false ? "bad" : "same"}">${c.up ? "▲" : "▼"} ${c.txt}</span>`;

/* ---------- רינדור ---------- */
function render() {
  rebuild();
  const gen = state.raw && state.raw.generatedAt ? new Date(state.raw.generatedAt) : null;
  $("#updated").innerHTML = state.demo ? "מצב הדגמה" : (gen ? `עודכן: ${num(`${fmtShort(gen)} ${pad(gen.getHours())}:${pad(gen.getMinutes())}`)}` : "-")
    + (state.status && state.status.state === "error" ? ` <span class="status-err" title="${esc(state.status.message)}">הסנכרון האחרון נכשל</span>` : "");
  if (!state.swims.length) {
    $("#hero").innerHTML = `<h2>עוד אין שחיות</h2><p class="muted">לחץ על "משוך שחיה חדשה" כדי להביא את הנתונים מגרמין.</p>`;
    return;
  }
  renderHero(); renderCoach(); renderGoals(); renderSets(); renderInsights(); renderHeart(); renderTrends(); renderHealth(); renderHistory(); renderCheat();
}

function select(i) { state.sel = Math.max(0, Math.min(state.swims.length - 1, i)); lsSet(LS.sel, state.swims[state.sel].id); render(); window.scrollTo({ top: 0, behavior: "smooth" }); }

function kpi(label, value, k, w, sub) {
  const c = k ? cmpPair(k, w, state.sel) : null;
  const rec = k && !METRICS[k].neutral && isRecord(state.sel, k, METRICS[k].lower);
  const line = (lbl, x) => x ? `<div class="cmp">${x.same ? "" : `<span class="arr ${x.good === true ? "g" : x.good === false ? "b" : ""}">${x.up ? "▲" : "▼"}</span> `}${lbl}: <b>${x.txt}</b></div>` : "";
  return `<div class="kpi"><div class="k">${label}${rec ? ' <span class="rec">🏆 שיא</span>' : ""}</div><div class="v">${value}</div>
    ${sub ? `<div class="s">${sub}</div>` : ""}${c ? line("מהקודמת", c.prev) + line("מהממוצע", c.avg) : ""}</div>`;
}

function renderHero() {
  const w = cur();
  const srcTxt = { manual: "תיקנת ידנית", ai: "תוקן בבדיקת AI", garmin: "לפי העריכה שעשית באתר גרמין", algo: "תוקן אוטומטית" }[w.manual ? "manual" : w.source];
  const badge = w.corrected
    ? `🛠 השעון ספר ${w.watchLengths} בריכות - ${srcTxt}. <button class="linkbtn" data-goto="setsCard">למה?</button>`
    : `✓ הספירה של השעון נכונה`;
  $("#hero").innerHTML = `
    <div class="hero-top">
      <div>
        <div class="hero-date">${fmtDate(w.start)} · ${num(`${pad(w.start.getHours())}:${pad(w.start.getMinutes())}`)}${state.sel === state.swims.length - 1 ? " · השחיה האחרונה" : ""}</div>
        <div class="hero-dist">${num(n0(w.dist))} <span>מטר · ${w.lengths} בריכות של ${w.pool} מ'</span></div>
        <div class="fix-badge">${badge}</div>
      </div>
      <div class="hero-nav">
        <button class="btn sm" id="prevSwim" ${state.sel === 0 ? "disabled" : ""}>→ קודמת</button>
        <span class="navpos">שחיה ${num(state.sel + 1)} מתוך ${num(state.swims.length)}</span>
        <button class="btn sm" id="nextSwim" ${state.sel === state.swims.length - 1 ? "disabled" : ""}>הבאה ←</button>
      </div>
    </div>
    <div class="kpis">
      ${kpi("קצב ממוצע ל-100 מ'", num(mmss(w.pace)), "pace", w, "זמן שחיה ל-100 מטר")}
      ${kpi("מנוחה ממוצעת בין סטים", num(mmss(w.avgRest)), "avgRest", w, w.rests.length ? `${w.rests.length} מנוחות · הארוכה ${num(mmss(w.maxRest))}` : "")}
      ${kpi("זמן כולל בבריכה", num(mmss(w.elapsed)), "elapsed", w, `מתוכו שחיה ${num(mmss(w.swimTime))}`)}
      ${kpi("דופק ממוצע", num(n0(w.avgHR)), "avgHR", w, `שיא: ${num(n0(w.maxHR))}${w.peakSet ? ` (בסט ${w.peakSet})` : ""} · <button class="linkbtn" data-goto="heartCard">פירוט</button>`)}
    </div>`;
  $("#prevSwim").onclick = () => select(state.sel - 1);
  $("#nextSwim").onclick = () => select(state.sel + 1);
  bindGoto($("#hero"));
}
function bindGoto(root) { root.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = () => document.getElementById(b.dataset.goto).scrollIntoView({ behavior: "smooth", block: "start" }))); }

function renderCoach() {
  const el = $("#coachCard"), a = ai(), w = cur();
  if (!a || !a.latest) {
    el.innerHTML = `<div class="card-head"><h2>🧑‍🏫 המאמן שלי</h2></div>
      <p class="muted">כאן תופיע פרשנות מילולית מלאה על כל שחיה - מההתחלה ועד האחרונה, עם קשר לבריאות שלך.${state.demo ? "" : " כדי להפעיל אותה צריך להוסיף בגיטהאב את ה-Secret בשם ANTHROPIC_API_KEY."}</p>`;
    return;
  }
  const L = a.latest, isLatest = String(L.activity_id) === String(w.id);
  el.innerHTML = `<div class="card-head"><h2>🧑‍🏫 המאמן שלי</h2>${!isLatest ? `<button class="btn sm" id="toLatest">לשחיה האחרונה</button>` : ""}</div>
    ${!isLatest ? `<p class="muted small">הפרשנות נכתבה על השחיה האחרונה (${esc(fmtShort(state.swims[state.swims.length - 1].start))}). אתה צופה כרגע בשחיה מ-${esc(fmtShort(w.start))}.</p>` : ""}
    <div class="headline">${esc(L.headline)}</div>
    ${(L.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join("")}
    <div class="sub">
      ${L.vs_previous ? `<div><b>לעומת הפעם הקודמת</b>${esc(L.vs_previous)}</div>` : ""}
      ${L.vs_average ? `<div><b>לעומת הממוצע שלך</b>${esc(L.vs_average)}</div>` : ""}
      ${L.health ? `<div><b>מה זה אומר לבריאות</b>${esc(L.health)}</div>` : ""}
      ${L.watch_tip ? `<div><b>טיפ לשעון</b>${esc(L.watch_tip)}</div>` : ""}
    </div>
    <div class="ai-meta">נכתב ע"י Claude ב-${a.generatedAt ? esc(fmtShort(new Date(a.generatedAt))) : "-"} · מתעדכן אוטומטית אחרי כל שחיה חדשה או תיקון.</div>`;
  const b = $("#toLatest"); if (b) b.onclick = () => select(state.swims.length - 1);
}

function ruleGoals() {
  const sw = state.swims, last = sw[sw.length - 1], g = [], n = sw.length;
  if (last.avgRest) {
    const best = Math.min(...sw.map((s) => s.avgRest).filter(Boolean));
    const target = Math.max(25, Math.round(Math.min(last.avgRest - 5, best) / 5) * 5);
    g.push({ metric: "rest", title: "מנוחות קצרות יותר בין הסטים", now: `היום: ממוצע ${mmss(last.avgRest)} למנוחה`, target: `עד ${mmss(target)} בכל מנוחה`, detail: "מנוחה קצרה שומרת על הדופק באזור האירובי ובונה סיבולת." });
  }
  const ap = avgBefore(n, "pace");
  if (ap && last.pace) {
    const target = Math.min(ap, last.pace) - 2;
    g.push({ metric: "pace", title: "קצב קצת יותר מהיר", now: `היום: ${mmss(last.pace)} ל-100 מ' · ממוצע: ${mmss(ap)}`, target: `${mmss(target)} ל-100 מ'`, detail: "שתי שניות פחות ל-100 מ' זה כ-4 שניות פחות לכל סט של 10 בריכות." });
  }
  if (last.corrected) g.push({ metric: "clean_count", title: "ספירה נקייה של השעון", now: `היום: השעון ספר ${last.watchLengths} במקום ${last.lengths}`, target: `${last.lengths} בריכות בדיוק`, detail: "עוצר באמצע? לחיצה מיידית על הכפתור התחתון. בלי לחיצה - לא עוצרים." });
  g.push({ metric: "weekly", title: "לשחות גם בשבוע הבא", now: "", target: "שחיה אחת לפחות בשבוע", detail: "העקביות היא מה שמשפיע הכי הרבה על כושר הלב ובדיקות הדם." });
  return g.slice(0, 4);
}

function renderGoals() {
  const a = ai(), aiGoals = a && a.next_goals && a.next_goals.length ? a.next_goals : null, goals = aiGoals || ruleGoals();
  const icon = { rest: "⏱", pace: "🚀", set_pace: "🏁", heart_rate: "❤️", clean_count: "🎯", swolf: "🌊", weekly: "📅", other: "⭐" };
  $("#goalsCard").innerHTML = `<div class="card-head"><div><h2>🎯 יעדים לשחיה הבאה</h2><p class="muted">${aiGoals ? "לפי ניתוח כל השחיות שלך" : "מחושב מהשחיה האחרונה ומהממוצע שלך"}</p></div></div>
    <ul class="goals">${goals.map((x) => `<li><div class="gi">${icon[x.metric] || "⭐"}</div><div>
      <div class="gt">${esc(x.title)}</div>
      ${x.now ? `<div class="gn">${esc(x.now)}</div>` : ""}
      ${x.target ? `<div class="gv">🎯 היעד: ${esc(x.target)}</div>` : ""}
      <div class="gd">${esc(x.detail)}</div></div></li>`).join("")}</ul>`;
}

function renderSets() {
  const w = cur(), exp = +state.settings.lengthsPerSet || 10, el = $("#setsCard");
  if (!w.sets.length) { el.innerHTML = `<h2>הסטים</h2><p class="muted">לא התקבל פירוט בריכות לשחיה הזו.</p>`; return; }
  const srcTxt = { manual: "לפי התיקון הידני שלך", ai: "לפי בדיקת AI של כל בריכה", garmin: "לפי המרחק שערכת באתר של גרמין", algo: "לפי בדיקה של זמן ותנועות בכל בריכה" }[w.manual ? "manual" : w.source];
  const nSus = w.sets.reduce((a, s) => a + s.suspects.filter(Boolean).length, 0);
  const explain = w.corrected
    ? `השעון ספר <b>${w.watchLengths}</b> בריכות, ואחרי בדיקה יצא <b>${w.lengths}</b> (${srcTxt}).${nSus ? ` ${nSus} "בריכות" היו קצרות מדי ועם מעט תנועות (פחות מ-${Math.round(w.ref * 0.6)} שניות, בזמן שבריכה רגילה שלך לוקחת כ-${Math.round(w.ref)} שניות) - זה קורה כשעוצרים או מסדרים משקפת באמצע בריכה, והשעון חושב שהתחלת בריכה חדשה.` : ""}`
    : `השעון ספר <b>${w.watchLengths}</b> בריכות, והבדיקה מאשרת שזה נכון.`;
  const fastest = Math.min(...w.sets.map((s) => s.pace || Infinity));
  el.innerHTML = `
    <div class="card-head">
      <div><h2>הסטים של השחיה</h2><p class="muted">כל שורה היא רצף שחיה בין לחיצה ללחיצה על הכפתור התחתון. אם הספירה לא נכונה, תקן עם + / − בעמודת "בריכות", או בכפתור "שחיתי ${exp} בכל סט" שמתקן את כולם בבת אחת.</p></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn sm" id="allExp" title="תיקון מהיר: אם אתה יודע ששחית ${exp} בריכות בכל סט, לחיצה אחת מתקנת את כל הסטים">✋ שחיתי ${exp} בכל סט</button>
        ${w.manual ? `<button class="btn sm" id="resetCorr">ביטול התיקון הידני</button>` : ""}
      </div>
    </div>
    <div class="explain ${w.corrected ? "warn" : "ok"}">${explain}${w.aiReview && w.aiReview.note ? `<br>🤖 ${esc(w.aiReview.note)}` : ""}</div>
    <div class="scroll-x"><table class="t sets-t">
      <thead><tr><th>סט</th><th>בריכות</th><th>מרחק</th><th>זמן שחיה</th><th>קצב ל-100 מ'</th><th>דופק ממוצע</th><th>דופק שיא</th><th>מנוחה אחרי</th></tr></thead>
      <tbody>${w.sets.map((s) => `<tr class="${s.count !== s.watch ? "fixed" : ""}">
        <td><b>${s.idx}</b></td>
        <td><div class="stepper" data-set="${s.idx}"><button data-d="1" aria-label="הוסף בריכה">+</button><span class="cnt">${s.count}</span><button data-d="-1" aria-label="הורד בריכה">−</button></div>
          ${s.count !== s.watch ? `<div class="was">השעון: ${s.watch}</div>` : ""}</td>
        <td>${num(n0(s.dist))} מ'</td>
        <td>${num(mmss(s.time))}</td>
        <td>${num(mmss(s.pace))}${s.pace === fastest && w.sets.length > 1 ? ' <span class="pill good">הכי מהיר</span>' : ""}</td>
        <td>${s.avgHR ? num(n0(s.avgHR)) : "-"}</td>
        <td>${s.maxHR ? num(n0(s.maxHR)) : "-"}${s.idx === w.peakSet ? ' <span class="pill same">הכי גבוה</span>' : ""}</td>
        <td>${s.rest ? num(mmss(s.rest)) : "-"}</td></tr>`).join("")}</tbody>
    </table></div>
    <details class="len-details"><summary>להציג כל בריכה בנפרד (גובה העמודה = כמה זמן לקחה)</summary>
      ${w.sets.map((s) => `<div class="len-row"><span class="len-lbl">סט ${s.idx}</span><div class="lengths">${s.lengths.map((l, k) => `<div class="len ${s.suspects[k] ? "sus" : ""}" style="height:${Math.max(8, (l.duration / Math.max(...w.sets.flatMap((x) => x.lengths.map((y) => y.duration)), 1)) * 100)}%" data-tip="בריכה ${k + 1} בסט ${s.idx}: ${l.duration.toFixed(1)} שניות · ${l.strokes} תנועות${s.suspects[k] ? " · קצרה מדי ועם מעט תנועות - כנראה חלק מבריכה" : ""}"></div>`).join("")}</div></div>`).join("")}
      <div class="legend-row"><span><i class="sw" style="background:var(--series)"></i>בריכה מלאה</span><span><i class="sw" style="background:repeating-linear-gradient(45deg,var(--warn),var(--warn) 3px,#ffe3a1 3px,#ffe3a1 6px)"></i>קצרה מדי ועם מעט תנועות - כנראה חלק מבריכה</span></div>
      <p class="muted small">בריכה מהירה עם מספר תנועות רגיל (למשל בריכה בחתירה) נספרת כבריכה מלאה.</p>
    </details>`;
  el.querySelectorAll(".stepper").forEach((st) => st.querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const i = +st.dataset.set, set = w.sets[i - 1];
    setCorrection(w.id, i, Math.max(0, set.count + +b.dataset.d), set.auto);
  })));
  $("#allExp").onclick = () => { const c = {}; w.sets.forEach((s) => (c[s.idx] = exp)); state.user.corrections[w.id] = c; saveUser(); render(); };
  const r = $("#resetCorr"); if (r) r.onclick = () => { delete state.user.corrections[w.id]; saveUser(); render(); };
  bindTips(el);
}

function setCorrection(id, setIdx, value, auto) {
  const c = state.user.corrections[id] || {};
  if (value === auto) delete c[setIdx]; else c[setIdx] = value;
  if (Object.keys(c).length) state.user.corrections[id] = c; else delete state.user.corrections[id];
  saveUser(); render();
}

function renderInsights() {
  const w = cur(), i = state.sel, rows = [];
  const row = (icon, title, value, k, meaning) => {
    const c = k ? cmpPair(k, w, i) : {};
    rows.push(`<li><span class="e">${icon}</span><div><div class="it">${title}: <b>${value}</b></div>
      ${c.prev || c.avg ? `<div class="ic">${c.prev ? `לעומת הקודמת ${tag(c.prev)}` : ""} ${c.avg ? `לעומת הממוצע ${tag(c.avg)}` : ""}</div>` : ""}
      ${meaning ? `<div class="im">${meaning}</div>` : ""}</div></li>`);
  };
  const p = prevOf(i);
  const paceC = cmpPair("pace", w, i);
  row("🚀", "קצב ל-100 מ'", num(mmss(w.pace)), "pace", paceC.prev && paceC.prev.good ? "שחית מהר יותר - סימן לכושר ולטכניקה שמשתפרים." : paceC.prev && paceC.prev.good === false ? "קצת יותר איטי הפעם. זה טבעי מדי פעם, במיוחד אם קיצרת מנוחות." : "");
  const restC = cmpPair("avgRest", w, i);
  row("⏱", "מנוחה ממוצעת בין סטים", num(mmss(w.avgRest)), "avgRest", isRecord(i, "avgRest", true) ? "🏆 המנוחות הכי קצרות שעשית עד היום! האימון נעשה רציף ואירובי יותר." : restC.prev && restC.prev.good ? "מנוחות קצרות יותר = אימון רציף ואירובי יותר." : "");
  row("🕐", "זמן כולל בבריכה", num(mmss(w.elapsed)), "elapsed", "");
  row("🌊", "יעילות (SWOLF)", num(n0(w.swolf)), "swolf", "SWOLF = שניות לבריכה + תנועות לבריכה. מספר נמוך יותר אומר שחיה יעילה יותר (מתקדם יותר עם פחות מאמץ).");
  if (w.sets.length > 1) {
    const ps = w.sets.filter((s) => s.pace), f = ps[0], l = ps[ps.length - 1];
    const drop = l && f ? l.pace - f.pace : 0;
    rows.push(`<li><span class="e">🔋</span><div><div class="it">עייפות לאורך האימון</div><div class="im">${drop > 6 ? `הסט האחרון היה איטי ב-${num(mmss(drop))} ל-100 מ' מהראשון - העייפות הצטברה בסוף. נסה להתחיל קצת יותר רגוע.` : drop < -3 ? `סיימת מהר יותר משהתחלת (ב-${num(mmss(-drop))} ל-100 מ') - סיום חזק!` : "שמרת על קצב יציב מהסט הראשון עד האחרון - מצוין."}</div></div></li>`);
  }
  if (p) rows.push(`<li><span class="e">📅</span><div><div class="it">${Math.round((w.start - p.start) / 864e5)} ימים מאז השחיה הקודמת</div></div></li>`);
  $("#insightsCard").innerHTML = `<div class="card-head"><div><h2>מה רואים בשחיה הזו</h2><p class="muted">כל מדד מושווה לשחיה הקודמת ולממוצע של כל השחיות שלפניה. ירוק = טוב יותר, אדום = פחות טוב.</p></div></div><ul class="insights">${rows.join("")}</ul>`;
}

function renderHeart() {
  const w = cur(), i = state.sel, el = $("#heartCard");
  if (!w.avgHR) { el.innerHTML = `<h2>❤️ הלב בשחיה</h2><p class="muted">אין נתוני דופק לשחיה הזו.</p>`; return; }
  const a = cmpPair("avgHR", w, i), m = cmpPair("maxHR", w, i), p = prevOf(i);
  const allMax = state.swims.slice(0, i + 1).map((s) => s.maxHR).filter(Boolean);
  const allAvg = state.swims.slice(0, i + 1).map((s) => s.avgHR).filter(Boolean);
  const facts = [];
  if (allMax.length > 2 && w.maxHR === Math.max(...allMax)) facts.push("זה דופק השיא הכי גבוה שנמדד אצלך בשחיה.");
  if (allMax.length > 2 && w.maxHR === Math.min(...allMax)) facts.push("זה דופק השיא הכי נמוך שנמדד אצלך בשחיה.");
  // פרשנות: דופק ביחס לקצב ולמנוחות
  let story = "";
  if (p && p.maxHR && p.pace && w.pace) {
    const dMax = w.maxHR - p.maxHR, faster = w.pace < p.pace - 1, shorterRest = w.avgRest && p.avgRest && w.avgRest < p.avgRest - 3;
    if (dMax <= -5 && !(w.pace > p.pace + 2)) story = `דופק השיא ירד ב-${-dMax} פעימות${faster ? " למרות שהקצב היה מהיר יותר" : " בקצב דומה"}. זה סימן טוב: הלב עושה את אותה עבודה בפחות מאמץ - ככה נראה שיפור בכושר.`;
    else if (dMax <= -5) story = `דופק השיא ירד ב-${-dMax} פעימות, אבל גם הקצב היה איטי יותר - כלומר מאמץ קל יותר באופן כללי.`;
    else if (dMax >= 5 && shorterRest) story = `דופק השיא עלה ב-${dMax} פעימות - הגיוני, כי המנוחות היו קצרות יותר והלב לא הספיק לרדת בין הסטים. זה בדיוק מה שבונה סיבולת.`;
    else if (dMax >= 5 && faster) story = `דופק השיא עלה ב-${dMax} פעימות כי שחית מהר יותר. מאמץ גבוה יותר - תקין.`;
    else if (dMax >= 5) story = `דופק השיא עלה ב-${dMax} פעימות בלי שהקצב או המנוחות השתנו הרבה. יכול להיות עייפות, שינה לא טובה או חום. אם זה חוזר - שווה לשים לב.`;
    else story = "הדופק דומה לפעם הקודמת - מאמץ יציב ומבוקר.";
  }
  let zonesHtml = "";
  if (w.zones && w.zones.some((z) => z > 0)) {
    const tot = w.zones.reduce((x, y) => x + y, 0), pc = w.zones.map((z) => Math.round((z / tot) * 100));
    const names = ["חימום", "קל", "אירובי", "מאמץ גבוה", "מקסימלי"];
    const b = w.zoneBounds || [];
    const range = (k) => b[k] ? (b[k + 1] ? `${b[k]}-${b[k + 1] - 1}` : `${b[k]}+`) : "";
    const aer = pc[1] + pc[2], hard = pc[3] + pc[4];
    const zn = (k) => `אזור ${k + 1} (${names[k]}${range(k) ? `, ${range(k)}` : ""})`;
    const rng = (k1, k2) => b[k1] && b[k2 + 1] ? ` (${b[k1]}-${b[k2 + 1] - 1} פעימות)` : "";
    let zText = `<b>${aer}%</b> מהזמן הדופק היה באזורים 2-3${rng(1, 2)} - קצב נוח שאפשר להחזיק לאורך זמן, ובונה סיבולת.`;
    if (hard >= 5) zText += ` <b>${hard}%</b> מהזמן הוא היה באזורים 4-5${b[3] ? ` (${b[3]} פעימות ומעלה)` : ""} - מאמץ חזק, בדרך כלל לקראת סוף הסטים.`;
    zText += hard > 45 ? " רוב האימון היה במאמץ חזק. זה בסדר מדי פעם, אבל אם אתה מרגיש גמור בסוף - אפשר להתחיל את הסטים קצת יותר רגוע."
      : " שני סוגי המאמץ מועילים ללב ולשומנים בדם, והחלוקה שלך מאוזנת. 👍";
    zonesHtml = `<h3 class="h3">זמן באזורי דופק</h3>
      <div class="zones-t">${w.zones.map((z, k) => `<div class="zr"><span class="zn"><i class="sw" style="background:var(--z${k + 1})"></i>אזור ${k + 1} · ${names[k]}</span><span class="zb">${range(k) ? num(range(k)) + " פעימות" : ""}</span>
        <span class="zt"><span class="zfill" style="width:${pc[k]}%;background:var(--z${k + 1})"></span></span><span class="zp">${num(pc[k] + "%")}</span><span class="zs">${num(mmss(z))}</span></div>`).join("")}</div>
      <p class="im">${zText}</p>`;
  }
  const line = (lbl, v, c, extra) => `<div class="hr-box"><div class="k">${lbl}</div><div class="v">${num(n0(v))}</div><div class="s">פעימות לדקה${extra || ""}</div>
    ${c.prev ? `<div class="cmp">מהקודמת (${num(n0(c.prevV))}): ${tag(c.prev)}</div>` : ""}${c.avg ? `<div class="cmp">מהממוצע (${num(n0(c.avgV))}): ${tag(c.avg)}</div>` : ""}</div>`;
  el.innerHTML = `<div class="card-head"><div><h2>❤️ הלב בשחיה</h2><p class="muted">הדופק נמדד בשורש כף היד. במים המדידה פחות מדויקת, אז חשובה בעיקר המגמה.</p></div></div>
    <div class="hr-grid">${line("דופק ממוצע", w.avgHR, a, "")}${line("דופק שיא", w.maxHR, m, w.peakSet ? ` · בסט ${w.peakSet}` : "")}</div>
    ${story || facts.length ? `<p class="im" style="margin-top:12px">${story} ${facts.join(" ")}</p>` : ""}
    ${allAvg.length > 1 ? `<p class="muted small">הטווח שלך עד היום: דופק ממוצע ${num(Math.min(...allAvg))}-${num(Math.max(...allAvg))}, דופק שיא ${num(Math.min(...allMax))}-${num(Math.max(...allMax))}.</p>` : ""}
    ${zonesHtml}`;
  bindTips(el);
}

/* ---------- גרפים (SVG ידני) - ישן משמאל, חדש מימין ---------- */
function lineChart(box, pts, o) {
  const W = Math.max(240, box.clientWidth - 24), H = 150, pl = 40, pr = 12, pt = 18, pb = 22;
  const ys = pts.map((p) => p.y).filter((v) => v != null && isFinite(v));
  if (!ys.length) { box.querySelector(".plot").innerHTML = `<p class="muted small">אין מספיק נתונים</p>`; return; }
  let lo = Math.min(...ys), hi = Math.max(...ys);
  const padv = (hi - lo) * 0.2 || Math.abs(hi) * 0.1 || 1; lo -= padv; hi += padv;
  const X = (i) => pts.length === 1 ? (pl + W - pr) / 2 : pl + (i / (pts.length - 1)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const ticks = [lo + padv, hi - padv];
  const valid = pts.map((p, i) => ({ ...p, i })).filter((p) => p.y != null && isFinite(p.y));
  const d = valid.map((p, k) => `${k ? "L" : "M"}${X(p.i).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
  const avg = ys.reduce((a, b) => a + b, 0) / ys.length;
  const step = Math.ceil(pts.length / 6);
  const first = valid[0], last = valid[valid.length - 1];
  box.querySelector(".plot").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px" direction="ltr">
    ${ticks.map((t) => `<line class="gridline" x1="${pl}" x2="${W - pr}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${pl - 6}" y="${Y(t) + 3}" text-anchor="end">${o.fmt(t)}</text>`).join("")}
    <line class="avgline" x1="${pl}" x2="${W - pr}" y1="${Y(avg)}" y2="${Y(avg)}"/><text class="avgtxt" x="${W - pr}" y="${Y(avg) - 4}" text-anchor="end">ממוצע ${o.fmt(avg)}</text>
    <path class="ln" d="${d}"/>
    ${pts.map((p, i) => (i % step === 0 || i === pts.length - 1) ? `<text x="${X(i)}" y="${H - 6}" text-anchor="middle">${p.label}</text>` : "").join("")}
    <line class="cross" y1="${pt}" y2="${H - pb}" x1="-10" x2="-10"/>
    ${valid.map((p) => `<circle class="dot ${p.i === state.sel ? "last" : ""}" cx="${X(p.i)}" cy="${Y(p.y)}" r="${p.i === state.sel ? 6 : 4}"/>`).join("")}
    ${valid.length > 1 ? `<text class="ptlbl" x="${X(first.i)}" y="${Y(first.y) - 9}" text-anchor="start">${o.fmt(first.y)}</text>` : ""}
    <text class="ptlbl" x="${X(last.i)}" y="${Y(last.y) - 9}" text-anchor="end">${o.fmt(last.y)}</text>
    ${pts.map((p, i) => `<rect x="${X(i) - (W / pts.length) / 2}" y="0" width="${W / pts.length}" height="${H}" fill="transparent" data-i="${i}"/>`).join("")}
  </svg>`;
  const svg = box.querySelector("svg"), cross = svg.querySelector(".cross");
  svg.querySelectorAll("rect").forEach((r) => {
    const p = pts[+r.dataset.i];
    r.addEventListener("mousemove", (e) => { cross.setAttribute("x1", X(+r.dataset.i)); cross.setAttribute("x2", X(+r.dataset.i)); showTip(e, `${p.full}<br><b>${p.y == null ? "-" : o.fmt(p.y)}</b> ${o.unit || ""}<br><small>לחיצה = לפתוח את השחיה</small>`); });
    r.addEventListener("mouseleave", () => { cross.setAttribute("x1", -10); cross.setAttribute("x2", -10); hideTip(); });
    r.addEventListener("click", () => select(+r.dataset.i));
  });
}

function barChart(box, pts, o) {
  const W = Math.max(240, box.clientWidth - 24), H = 160, pl = 30, pr = 8, pt = 16, pb = 22;
  const hi = Math.max(o.goal || 0, ...pts.map((p) => p.y)) * 1.15 || 1;
  const bw = (W - pl - pr) / pts.length;
  const X = (i) => pl + i * bw;
  const Y = (v) => pt + (1 - v / hi) * (H - pt - pb);
  box.querySelector(".plot").innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" style="height:${H}px" direction="ltr">
    <line class="gridline" x1="${pl}" x2="${W - pr}" y1="${Y(0)}" y2="${Y(0)}"/>
    ${pts.map((p, i) => { const h = Math.max(p.y ? 3 : 0, H - pb - Y(p.y)); const x = X(i) + 3, w = Math.max(3, bw - 6), y = H - pb - h, r = Math.min(4, w / 2, h);
      return h ? `<path class="bar ${o.goal && p.y >= o.goal ? "met" : ""}" d="M${x},${H - pb}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - pb}Z"/><text class="ptlbl" x="${x + w / 2}" y="${y - 4}" text-anchor="middle">${p.y}</text>` : ""; }).join("")}
    ${o.goal ? `<line class="goal" x1="${pl}" x2="${W - pr}" y1="${Y(o.goal)}" y2="${Y(o.goal)}"/><text class="goaltxt" x="${pl}" y="${Y(o.goal) - 4}" text-anchor="start">יעד ${o.goal} דק'</text>` : ""}
    ${pts.map((p, i) => (i % Math.ceil(pts.length / 8) === 0 || i === pts.length - 1) ? `<text x="${X(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${p.label}</text>` : "").join("")}
    ${pts.map((p, i) => `<rect x="${X(i)}" y="0" width="${bw}" height="${H}" fill="transparent" data-i="${i}"/>`).join("")}
  </svg>`;
  box.querySelectorAll("rect").forEach((r) => {
    const p = pts[+r.dataset.i];
    r.addEventListener("mousemove", (e) => showTip(e, p.tip));
    r.addEventListener("mouseleave", hideTip);
  });
}

const TRENDS = [
  { k: "pace", t: "קצב ל-100 מטר", fmt: mmss, unit: "דקות", lower: true, what: "כמה זמן לוקח לך לשחות 100 מטר. קו שיורד = אתה שוחה מהר יותר." },
  { k: "avgRest", t: "מנוחה ממוצעת בין סטים", fmt: mmss, unit: "דקות", lower: true, what: "כמה נחת בממוצע בין סט לסט. קו שיורד = אימון רציף יותר." },
  { k: "elapsed", t: "זמן כולל בבריכה", fmt: mmss, unit: "דקות", lower: true, what: "מהלחיצה הראשונה עד האחרונה, כולל מנוחות. קו שיורד = אותו מרחק בפחות זמן." },
  { k: "avgHR", t: "דופק ממוצע", fmt: (v) => Math.round(v), unit: "פעימות לדקה", what: "הדופק הממוצע לאורך האימון. עלייה קלה כשמקצרים מנוחות היא טבעית." },
];
function renderTrends() {
  const el = $("#trends"), sw = state.swims;
  el.innerHTML = TRENDS.map((t, i) => {
    const vals = sw.map((s) => s[t.k]).filter((v) => v != null);
    let verdict = "";
    if (vals.length > 1) {
      const firstV = vals[0], lastV = vals[vals.length - 1], d = lastV - firstV;
      if (t.lower !== undefined) verdict = Math.abs(d) < (METRICS[t.k].thr || 1) ? "בערך כמו בהתחלה" : (d < 0 ? `<span class="pill good">השתפרת ב-${t.fmt(-d)} מאז השחיה הראשונה</span>` : `<span class="pill bad">${t.fmt(d)} יותר מבשחיה הראשונה</span>`);
      else verdict = `מ-${t.fmt(firstV)} בשחיה הראשונה ל-${t.fmt(lastV)} באחרונה`;
    }
    return `<div class="chart-box" id="tr${i}"><h3>${t.t}</h3><p class="what">${t.what}</p><div class="verdict">${verdict}</div><div class="plot"></div></div>`;
  }).join("");
  TRENDS.forEach((t, i) => lineChart($("#tr" + i), sw.map((s) => ({ y: s[t.k], label: fmtShort(s.start), full: fmtDate(s.start) })), { fmt: t.fmt, unit: t.unit }));
}

const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - x.getDay()); return x; };
function renderWeekly() {
  const el = $("#weeklyCard"), sw = state.swims;
  const now = weekStart(new Date()), weeks = [];
  const first = weekStart(sw[0].start);
  const nWeeks = Math.min(16, Math.max(6, Math.round((now - first) / 6048e5) + 1));
  for (let i = nWeeks - 1; i >= 0; i--) { const s = new Date(now); s.setDate(s.getDate() - i * 7); weeks.push({ s, min: 0, swims: 0 }); }
  const find = (d) => weeks.find((w) => w.s.getTime() === weekStart(d).getTime());
  sw.forEach((s) => { const w = find(s.start); if (w) { w.min += s.elapsed / 60; w.swims++; } });
  const goal = 150, thisW = weeks[weeks.length - 1];
  const missing = Math.max(0, goal - thisW.min);
  const avgSwim = sw.reduce((a, s) => a + s.elapsed / 60, 0) / sw.length;
  el.innerHTML = `<div class="card-head"><div><h2>כמה שחית בכל שבוע</h2>
    <p class="muted">כל עמודה היא שבוע (ראשון עד שבת), והמספר מעליה הוא דקות בבריכה. שחיה אחת שלך היא כ-${num(Math.round(avgSwim))} דקות.
    הקו הירוק המקווקו הוא 150 דקות - ההמלצה של ארגוני הבריאות לפעילות אירובית בשבוע, לבריאות הלב והכולסטרול.</p></div></div>
    <div class="plot"></div>
    <div class="callout">השבוע: <b>${num(Math.round(thisW.min))}</b> דקות שחיה (${thisW.swims} שחיות)${missing ? `. כדי להגיע ל-150 חסרות ${num(Math.round(missing))} דקות - למשל ${num(Math.ceil(missing / 30))} הליכות מהירות של חצי שעה. השעון לא מודד הליכות, זה לידיעה בלבד.` : " - עמדת ביעד! 🎉"}</div>`;
  barChart(el, weeks.map((w) => ({ y: Math.round(w.min), label: fmtShort(w.s), tip: `שבוע שמתחיל ב-${fmtShort(w.s)}<br><b>${Math.round(w.min)}</b> דקות · ${w.swims} שחיות` })), { goal });
}

function renderHealth() {
  const el = $("#healthCard"), sw = state.swims, a = ai();
  const first = weekStart(sw[0].start), now = weekStart(new Date());
  const totalWeeks = Math.round((now - first) / 6048e5) + 1;
  const swimWeeks = new Set(sw.map((s) => weekStart(s.start).getTime()));
  const strip = Array.from({ length: totalWeeks }, (_, i) => { const d = new Date(first); d.setDate(d.getDate() + i * 7); return { on: swimWeeks.has(d.getTime()), d }; });
  const km = sw.reduce((acc, s) => acc + s.dist, 0) / 1000;
  const months = (Date.now() - sw[0].start) / (30.4 * 864e5);
  const tests = (state.user.bloodTests || []).slice().sort((x, y) => x.date.localeCompare(y.date));
  const lastTest = tests[tests.length - 1];
  const sinceTest = lastTest ? (Date.now() - new Date(lastTest.date)) / (30.4 * 864e5) : months;
  let call;
  if (a && a.journey && a.journey.blood_test_advice) call = "🩸 " + esc(a.journey.blood_test_advice);
  else if (sinceTest >= 2.5) call = `🩸 עברו כ-${num(Math.round(sinceTest))} חודשים ${lastTest ? "מהבדיקה האחרונה" : "מאז שהתחלת לשחות"}, ושחית ב-${num(swimWeeks.size)} מתוך ${num(totalWeeks)} שבועות. אפשר לבדוק שומנים בדם כדי לראות מגמה - עם יותר עקביות התמונה תהיה ברורה יותר.`;
  else call = `⏳ מומלץ לצבור עוד כמה שבועות של שחיה סדירה לפני בדיקת דם חוזרת.`;
  const f = (v) => (v == null || v === "" ? "-" : num(v));
  const dl = (k, lower) => { if (tests.length < 2) return ""; const x = tests[0][k], y = lastTest[k]; if (x == null || y == null || x === "" || y === "") return ""; const d = Math.round((y - x) * 10) / 10; const good = lower ? d < 0 : d > 0; return ` <small style="color:var(${good ? "--good-ink" : "--muted"})">(${d > 0 ? "+" : ""}${d})</small>`; };
  el.innerHTML = `<div class="card-head"><div><h2>🧭 המסע שלך</h2><p class="muted">מהשחיה הראשונה ועד היום</p></div></div>
    <div class="journey">
      <div class="jbox"><div class="v">${num(swimWeeks.size)}</div><div class="k">שבועות עם שחיה מתוך ${num(totalWeeks)}</div></div>
      <div class="jbox"><div class="v">${num(sw.length)}</div><div class="k">שחיות</div></div>
      <div class="jbox"><div class="v">${num(km.toFixed(1))}</div><div class="k">ק"מ בסך הכול</div></div>
    </div>
    <div class="muted small">כל ריבוע הוא שבוע מאז השחיה הראשונה (מימין לשמאל). מלא = שחית באותו שבוע.</div>
    <div class="weeks-strip">${strip.map((x) => `<i class="${x.on ? "on" : ""}" title="שבוע ${fmtShort(x.d)}"></i>`).join("")}</div>
    ${a && a.journey ? `
      ${a.journey.summary ? `<div class="jsec"><h3>📈 ההתקדמות שלך מההתחלה</h3><p>${esc(a.journey.summary)}</p></div>` : ""}
      ${a.journey.consistency ? `<div class="jsec"><h3>📅 עקביות</h3><p>${esc(a.journey.consistency)}</p></div>` : ""}` : ""}
  `;
  const bl = $("#bloodCard");
  bl.innerHTML = `<div class="card-head"><div><h2>🩸 בדיקות דם</h2><p class="muted">שחיה אירובית קבועה + אימוני כוח עוזרים להעלות HDL ולהוריד טריגליצרידים ו-LDL</p></div></div>
    <div class="callout"><b>מתי לבדוק שוב:</b> ${call.replace(/^🩸 |^⏳ /, "")}</div>
    ${a && a.journey && a.journey.health_outlook ? `<div class="jsec"><h3>מה צפוי להשתנות</h3><p>${esc(a.journey.health_outlook)}</p></div>` : ""}
    <h3 class="h3">התוצאות שהזנת</h3>
    ${tests.length ? `<div class="scroll-x"><table class="t"><thead><tr><th>תאריך</th><th>כולסטרול כללי</th><th>LDL</th><th>HDL</th><th>Non-HDL</th><th>טריגליצרידים</th><th></th></tr></thead><tbody>
      ${tests.map((t, i) => `<tr><td>${num(t.date.split("-").reverse().join("."))}</td><td>${f(t.total)}${i === tests.length - 1 ? dl("total", true) : ""}</td><td>${f(t.ldl)}${i === tests.length - 1 ? dl("ldl", true) : ""}</td><td>${f(t.hdl)}${i === tests.length - 1 ? dl("hdl", false) : ""}</td><td>${f(t.nonhdl)}${i === tests.length - 1 ? dl("nonhdl", true) : ""}</td><td>${f(t.tg)}${i === tests.length - 1 ? dl("tg", true) : ""}</td><td><button class="btn sm" data-del="${t.date}" aria-label="מחיקה">✕</button></td></tr>`).join("")}
    </tbody></table></div>` : `<p class="muted small">עוד לא הוזנו תוצאות. כדאי להזין את הבדיקה האחרונה שעשית לפני שהתחלת לשחות, ואז נוכל לראות שינוי.</p>`}
    <form class="bt-form" id="btForm">
      <label>תאריך<input type="date" name="date" required></label>
      <label>כללי<input type="number" name="total" step="any" inputmode="decimal"></label>
      <label>LDL<input type="number" name="ldl" step="any" inputmode="decimal"></label>
      <label>HDL<input type="number" name="hdl" step="any" inputmode="decimal"></label>
      <label>Non-HDL<input type="number" name="nonhdl" step="any" inputmode="decimal"></label>
      <label>טריגליצ'<input type="number" name="tg" step="any" inputmode="decimal"></label>
      <button class="btn primary sm" type="submit">הוספה</button>
    </form>
    ${bloodExplain(tests)}
    <p class="muted small">הערכים נשמרים מוצפנים, ביחידות מ"ג/ד"ל.</p>`;
  const el2 = bl;
  $("#btForm").onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target), t = { date: fd.get("date") };
    ["total", "ldl", "hdl", "nonhdl", "tg"].forEach((k) => { const v = fd.get(k); if (v !== "") t[k] = +v; });
    state.user.bloodTests = (state.user.bloodTests || []).filter((x) => x.date !== t.date).concat(t);
    saveUser(); render();
  };
  el2.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { state.user.bloodTests = state.user.bloodTests.filter((x) => x.date !== b.dataset.del); saveUser(); render(); }));
}

// טווחי יעד מקובלים למבוגרים (מ"ג/ד"ל). הרופא קובע את היעד האישי.
const LIPIDS = [
  { k: "ldl", n: "LDL (הכולסטרול ה\"רע\")", ok: (v) => v < 100, mid: (v) => v < 130, okTxt: "מתחת ל-100", lower: true },
  { k: "nonhdl", n: "Non-HDL (כל הכולסטרול חוץ מה\"טוב\")", ok: (v) => v < 130, mid: (v) => v < 160, okTxt: "מתחת ל-130", lower: true },
  { k: "total", n: "כולסטרול כללי", ok: (v) => v < 200, mid: (v) => v < 240, okTxt: "מתחת ל-200", lower: true },
  { k: "hdl", n: "HDL (הכולסטרול ה\"טוב\")", ok: (v) => v >= 40, mid: (v) => v >= 35, okTxt: "40 ומעלה (ככל שגבוה יותר - טוב יותר)", lower: false },
  { k: "tg", n: "טריגליצרידים", ok: (v) => v < 150, mid: (v) => v < 200, okTxt: "מתחת ל-150", lower: true },
];
function bloodExplain(tests) {
  if (!tests.length) return "";
  const last = tests[tests.length - 1], first = tests[0], firstSwim = state.swims[0] && state.swims[0].start;
  const baseline = tests.length === 1;
  const rows = LIPIDS.filter((L) => last[L.k] != null && last[L.k] !== "").map((L) => {
    const v = last[L.k], st = L.ok(v) ? ["good", "בטווח היעד"] : L.mid(v) ? ["warn", "מעט מעל היעד"] : ["bad", "מעל היעד"];
    const status = L.k === "hdl" ? (L.ok(v) ? ["good", "בטווח הרצוי"] : ["bad", "נמוך מהרצוי"]) : st;
    let change = "";
    if (!baseline && first[L.k] != null && first[L.k] !== "") { const d = +(v - first[L.k]).toFixed(1); const good = L.lower ? d < 0 : d > 0; change = d === 0 ? " · ללא שינוי" : ` · <span class="pill ${good ? "good" : "bad"}">${d > 0 ? "▲" : "▼"} ${Math.abs(d)} מהבדיקה הראשונה</span>`; }
    return `<li><b>${L.n}: ${num(v)}</b> <span class="pill ${status[0]}">${status[1]}</span>${change}<div class="im">יעד מקובל: ${L.okTxt}.</div></li>`;
  });
  const when = firstSwim && new Date(last.date) <= firstSwim ? "הבדיקה נעשתה לפני שהתחלת לשחות, ולכן היא נקודת ההתחלה שלך." : "";
  return `<h3 class="h3">${baseline ? "מה אומרת הבדיקה (נקודת ההתחלה)" : "מה השתנה מאז הבדיקה הראשונה"}</h3>
    <p class="im">${baseline ? `${when} בבדיקה הבאה נראה כאן איך השחיה ואימוני הכוח משפיעים על כל ערך.` : ""}</p>
    <ul class="lipids">${rows.join("")}</ul>
    <p class="muted small">הטווחים הם יעדים כלליים מקובלים. היעד האישי שלך תלוי בגורמי סיכון, וכדאי לקבוע אותו עם הרופא.</p>`;
}

function renderHistory() {
  const rows = state.swims.map((s, i) => ({ s, i })).reverse();
  $("#historyCard").innerHTML = `<div class="card-head"><div><h2>כל השחיות</h2><p class="muted">המרחק אחרי בדיקה ותיקון. לחיצה על שורה פותחת את השחיה למעלה.${state.hidden ? ` (${state.hidden} ניסיונות קצרים של פחות מ-100 מ' הוסתרו)` : ""}</p></div></div>
    <div class="scroll-x"><table class="t"><thead><tr><th>תאריך</th><th>מרחק</th><th>השעון ספר</th><th>קצב ל-100 מ'</th><th>מנוחה ממוצעת</th><th>זמן כולל</th><th>דופק ממוצע</th><th>דופק שיא</th></tr></thead><tbody>
    ${rows.map(({ s, i }) => `<tr data-i="${i}" class="${i === state.sel ? "sel" : ""}"><td>${num(fmtShort(s.start))}</td><td><b>${num(n0(s.dist))}</b></td><td>${s.corrected ? `<span class="pill warn">${num(n0(s.watchLengths * s.pool))}</span>` : `<span class="pill good">✓</span>`}</td><td>${num(mmss(s.pace))}</td><td>${num(mmss(s.avgRest))}</td><td>${num(mmss(s.elapsed))}</td><td>${num(n0(s.avgHR))}</td><td>${num(n0(s.maxHR))}</td></tr>`).join("")}
    </tbody></table></div>`;
  $("#historyCard").querySelectorAll("tbody tr").forEach((tr) => (tr.onclick = () => select(+tr.dataset.i)));
}

function renderCheat() {
  const exp = state.settings.lengthsPerSet;
  $("#cheatCard").innerHTML = `<div class="card-head"><div><h2>מה ללחוץ בשעון</h2><p class="muted">להציץ לפני שנכנסים למים</p></div></div>
    <div class="cheat">
      <div class="step"><div class="b up">עליון</div><div><b>התחלה:</b> עומד בקיר, מוכן - לחיצה על הכפתור העליון.</div></div>
      <div class="step"><div class="b dn">תחתון</div><div><b>סוף סט (${exp} בריכות):</b> נוגע בקיר - <u>מיד</u> לחיצה על התחתון. מנוחה מתחילה.</div></div>
      <div class="step"><div class="b dn">תחתון</div><div><b>יוצא לסט הבא:</b> לחיצה על התחתון ודחיפה חזקה מהקיר.</div></div>
      <div class="step"><div class="b up">עליון</div><div><b>סיום הכול:</b> אחרי הבריכה האחרונה - לחיצה על העליון.</div></div>
      <div class="step"><div class="b tap">✓</div><div><b>שמירה:</b> מנגב מסך ואצבע במגבת ונוגע בעיגול הירוק.</div></div>
    </div>
    <div class="rules"><b>כללי ברזל נגד בריכות מיותרות</b><ul>
      <li>מנוחה = תחתון · חזרה לשחות = תחתון · סיום = עליון.</li>
      <li>עצרת באמצע (משקפת, עומס)? לחץ תחתון מיד. בלי לחיצה - לא עוצרים.</li>
      <li>דחיפה טובה מהקיר עם ידיים מתוחות בתחילת כל בריכה.</li>
      <li>הרטט כל ${exp * state.settings.pool} מ' יכול להגיע מוקדם אם השעון פיצל בריכה - סמוך על הספירה שלך, והדשבורד יתקן.</li>
    </ul></div>`;
}

/* ---------- טולטיפ ---------- */
const tip = $("#tip");
function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; const x = Math.min(window.innerWidth - tip.offsetWidth - 8, Math.max(8, e.clientX - tip.offsetWidth / 2)); tip.style.left = x + "px"; tip.style.top = Math.max(8, e.clientY - tip.offsetHeight - 14) + "px"; }
function hideTip() { tip.hidden = true; }
function bindTips(root) { root.querySelectorAll("[data-tip]").forEach((n) => { n.onmousemove = (e) => showTip(e, n.dataset.tip); n.onmouseleave = hideTip; n.onclick = (e) => showTip(e, n.dataset.tip); }); }
let toastT;
function toast(msg, ms = 4000) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

/* ---------- GitHub ---------- */
const gh = (path, opt = {}) => fetch(`https://api.github.com/repos/${state.settings.repo}${path}`, {
  ...opt, headers: { Authorization: `Bearer ${state.settings.token}`, Accept: "application/vnd.github+json", ...(opt.headers || {}) },
});
const canGH = () => state.settings.token && state.settings.repo;

async function loadFile(url, repoPath) {
  if (canGH()) {
    try {
      const r = await gh(`/contents/${repoPath}?ref=main&t=${Date.now()}`, { headers: { Accept: "application/vnd.github.raw+json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
  }
  const r = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  return r.ok ? r.json() : null;
}

let saveT;
function saveUser() {
  state.user.updatedAt = Date.now();
  lsSet(LS.user, state.user);
  if (state.demo || !state.password || !canGH()) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try {
      const path = "docs/data/user.enc.json";
      const head = await gh(`/contents/${path}?ref=main`);
      const sha = head.ok ? (await head.json()).sha : undefined;
      const env = await encryptObj(state.user, state.password);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(env))));
      const r = await gh(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: "עדכון נתונים מוצפנים", content, sha, branch: "main", author: { name: "swim-dashboard", email: "swim-bot@users.noreply.github.com" }, committer: { name: "swim-dashboard", email: "swim-bot@users.noreply.github.com" } }) });
      toast(r.ok ? "נשמר ✓" : "השמירה ל-GitHub נכשלה - נשמר רק במכשיר הזה");
    } catch { toast("השמירה ל-GitHub נכשלה - נשמר רק במכשיר הזה"); }
  }, 1200);
}

async function refresh() {
  const btn = $("#refreshBtn");
  if (!canGH()) {
    if (state.settings.repo) {
      window.open(`https://github.com/${state.settings.repo}/actions/workflows/sync.yml`, "_blank");
      toast('נפתח דף GitHub - לחץ שם על "Run workflow". אפשר להגדיר טוקן בהגדרות כדי שהכפתור יעבוד ישירות.', 8000);
    } else { toast("צריך להגדיר את הריפו בהגדרות"); $("#settingsBtn").click(); }
    return;
  }
  btn.disabled = true; btn.classList.add("spin"); const lbl = btn.querySelector(".lbl"), orig = lbl.textContent;
  const before = state.swims.length, t0 = Date.now();
  try {
    lbl.textContent = "מתחבר לגרמין...";
    const r = await gh(`/actions/workflows/sync.yml/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main" }) });
    if (!r.ok) throw new Error("dispatch " + r.status);
    let run = null;
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 4000));
      const rr = await gh(`/actions/workflows/sync.yml/runs?event=workflow_dispatch&per_page=1`);
      const j = await rr.json(); const x = j.workflow_runs && j.workflow_runs[0];
      if (x && new Date(x.created_at).getTime() > t0 - 60000) run = x;
      if (run) lbl.textContent = run.status === "completed" ? "מסיים..." : "שואב נתונים...";
      if (run && run.status === "completed") break;
    }
    if (!run || run.conclusion !== "success") throw new Error(run ? run.conclusion : "timeout");
    await loadData(true);
    render();
    const added = state.swims.length - before;
    toast(added > 0 ? `🎉 נמצאה ${added === 1 ? "שחיה חדשה" : added + " שחיות חדשות"}!` : "הנתונים מעודכנים - אין שחיה חדשה");
    if (added > 0) select(state.swims.length - 1);
  } catch (e) {
    toast("המשיכה נכשלה (" + e.message + "). אפשר לבדוק בלשונית Actions בגיטהאב.", 8000);
  } finally { btn.disabled = false; btn.classList.remove("spin"); lbl.textContent = orig; }
}

/* ---------- טעינה ---------- */
async function loadData(fresh) {
  const env = await loadFile(DATA_URL, "docs/data/activities.enc.json");
  if (!env) return false;
  state.raw = await decryptEnv(env, state.password);
  state.demo = false;
  try {
    const uenv = await loadFile(USER_URL, "docs/data/user.enc.json");
    const remote = uenv ? await decryptEnv(uenv, state.password) : null;
    const local = lsGet(LS.user, null);
    const best = [remote, local].filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (best) state.user = Object.assign({ corrections: {}, bloodTests: [] }, best);
  } catch {}
  return true;
}

function showApp() {
  $("#lock").hidden = true; $("#app").hidden = false;
  const selId = lsGet(LS.sel, null);
  rebuild();
  const i = state.swims.findIndex((s) => s.id === selId);
  state.sel = i >= 0 && i === state.swims.length - 1 ? i : state.swims.length - 1;
  render();
}

async function unlock(pw, remember) {
  state.password = pw;
  try {
    const ok = await loadData();
    if (!ok) return startDemo();
    if (remember) lsSet(LS.pw, pw);
    showApp();
  } catch {
    lsDel(LS.pw); state.password = null;
    $("#lock").hidden = false; $("#app").hidden = true; $("#lockErr").hidden = false;
  }
}

function startDemo() {
  state.demo = true; state.raw = window.DEMO_DATA;
  state.user = Object.assign({ corrections: {}, bloodTests: [] }, lsGet(LS.user, {}));
  const b = $("#banner"); b.hidden = false;
  b.innerHTML = "👋 אלה <b>נתוני הדגמה</b>. אחרי שהשאיבה הראשונה מגרמין תצליח, יופיעו כאן השחיות האמיתיות שלך.";
  showApp();
}

async function loadStatus() {
  try { const r = await fetch(`data/status.json?t=${Date.now()}`, { cache: "no-store" }); state.status = r.ok ? await r.json() : null; } catch { state.status = null; }
}

async function init() {
  loadStatus().then(() => state.swims.length && render());
  let env = null;
  try { const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" }); env = r.ok ? await r.json() : null; } catch {}
  if (!env && !canGH()) return startDemo();
  const saved = lsGet(LS.pw, null);
  if (saved) return unlock(saved, true);
  $("#lock").hidden = false;
}

$("#lockForm").onsubmit = (e) => { e.preventDefault(); $("#lockErr").hidden = true; unlock($("#lockPass").value, $("#lockRemember").checked); };
$("#refreshBtn").onclick = refresh;
$("#settingsBtn").onclick = () => {
  $("#setLengths").value = state.settings.lengthsPerSet; $("#setPool").value = state.settings.pool;
  $("#setRepo").value = state.settings.repo; $("#setToken").value = state.settings.token;
  $("#settings").showModal();
};
$("#saveSettings").onclick = () => {
  Object.assign(state.settings, { lengthsPerSet: +$("#setLengths").value || 10, pool: +$("#setPool").value || 20, repo: $("#setRepo").value.trim(), token: $("#setToken").value.trim() });
  lsSet(LS.settings, state.settings); render(); toast("ההגדרות נשמרו");
};
$("#logoutBtn").onclick = () => { lsDel(LS.pw); lsDel(LS.user); location.reload(); };
let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => state.swims.length && renderTrends(), 200); });
init();
})();
