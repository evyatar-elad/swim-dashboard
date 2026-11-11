"""עיבוד שחייה מנתוני גרמין גולמיים - אותו היגיון כמו ב-docs/app.js (תיקון בריכות מפוצלות)."""
from __future__ import annotations

import datetime as dt
import statistics


def _gmt(s: str | None):
    if not s:
        return None
    s = s.replace("Z", "")
    try:
        return dt.datetime.fromisoformat(s[:19])
    except ValueError:
        return None


def pool_length(summary: dict, default: float = 20) -> float:
    p = summary.get("poolLength")
    if not p:
        return default
    f = (summary.get("unitOfPoolLength") or {}).get("factor")
    p = p / f if f else (p / 100 if p > 100 else p)
    return round(p, 1)


def is_suspect(l: dict, ref: float, ref_strokes: float, main_stroke: str | None = None) -> bool:
    """קצרה מדי וגם עם מעט תנועות = חלק מבריכה. בריכה מהירה עם תנועות רגילות (למשל חתירה) היא מלאה.
    לא סומכים על זיהוי הסגנון של השעון."""
    if l["duration"] >= ref * 0.6:
        return False
    return not ref_strokes or l["strokes"] < ref_strokes * 0.6


def merge_lengths(lengths: list[dict], ref: float, ref_strokes: float, main_stroke: str | None = None) -> list[dict]:
    """מאחד חלקי בריכה קצרים, ומפצל "בריכה כפולה" (שתי בריכות שנרשמו כאחת)."""
    out: list[dict] = []
    buf = None

    def add(m, x):
        m["duration"] += x["duration"]
        m["strokes"] += x["strokes"]
        m["parts"] += x.get("parts", 1)

    for l in lengths:
        if not is_suspect(l, ref, ref_strokes, main_stroke):
            m = {"duration": l["duration"], "strokes": l["strokes"], "parts": 1}
            if buf:
                if buf["duration"] >= ref * 0.72:
                    out.append(buf)
                elif out:
                    add(out[-1], buf)
                else:
                    add(m, buf)
                buf = None
            out.append(m)
            continue
        if buf is None:
            buf = {"duration": 0.0, "strokes": 0, "parts": 0}
        add(buf, l)
        if buf["duration"] >= ref * 0.72:
            out.append(buf)
            buf = None
    if buf:
        if out and buf["duration"] < ref * 0.5:
            add(out[-1], buf)
        else:
            out.append(buf)
    final = []
    for m in out:
        if m["parts"] == 1 and m["duration"] > ref * 1.7 and ref_strokes and m["strokes"] > ref_strokes * 1.6:
            half = {"duration": m["duration"] / 2, "strokes": m["strokes"] / 2, "parts": 1}
            final += [half, dict(half)]
        else:
            final.append(m)
    return final


def is_idle(l: dict) -> bool:
    """"בריכה" שהיא בעצם מנוחה: גרמין רושם מנוחה כאורך בלי מרחק ובלי תנועות."""
    stroke = (l.get("swimStroke") or "").upper()
    return l.get("distance") == 0 or "REST" in stroke or (not l.get("totalNumberOfStrokes") and not l.get("distance"))


ZONE_NAMES = ["חימום", "קל", "אירובי", "מאמץ גבוה", "מקסימלי"]


def hr_zones(raw: dict) -> list[dict]:
    """אזורי הדופק בדיוק כמו בדשבורד: מספר אזור, שם, טווח פעימות, אחוז מהזמן."""
    zs = sorted(raw.get("hrZones") or [], key=lambda z: z.get("zoneNumber", 0))
    if zs:
        secs = [z.get("secsInZone") or 0 for z in zs]
        lows = [z.get("zoneLowBoundary") for z in zs]
    else:
        s = raw.get("summary", {})
        secs = [s.get(f"hrTimeInZone_{k}") or 0 for k in range(1, 6)]
        lows = [None] * 5
    tot = sum(secs) or 1
    out = []
    for i, sec in enumerate(secs[:5]):
        hi = (lows[i + 1] - 1) if i + 1 < len(lows) and lows[i + 1] else None
        out.append({"zone": i + 1, "name": ZONE_NAMES[i], "bpm_from": lows[i], "bpm_to": hi,
                    "pct": round(100 * sec / tot), "secs": round(sec)})
    return out


def process_swim(aid: str, raw: dict, corrections: dict | None = None) -> dict:
    s = raw.get("summary", {})
    pool = pool_length(s)
    laps = sorted(raw.get("laps", []), key=lambda l: l.get("startTimeGMT", ""))
    sets: list[dict] = []
    for lap in laps:
        all_lens = lap.get("lengthDTOs") or []
        lens = [l for l in all_lens if not is_idle(l)]
        idle = sum(l.get("duration") or 0 for l in all_lens if is_idle(l))
        active = lens or ((lap.get("distance") or 0) > 0 and not all_lens)
        if not active:
            if sets:
                sets[-1]["rest"] += lap.get("duration") or idle
            continue
        lengths = [{"duration": l.get("duration") or l.get("movingDuration") or 0,
                    "strokes": l.get("totalNumberOfStrokes") or 0, "stroke": l.get("swimStroke")} for l in lens]
        if not lengths:
            n = round((lap.get("distance") or 0) / pool) or 1
            lengths = [{"duration": (lap.get("duration") or 0) / n,
                        "strokes": (lap.get("totalNumberOfStrokes") or 0) / n}] * n
        st = _gmt(lap.get("startTimeGMT"))
        if sets and sets[-1]["rest"] == 0 and st and sets[-1]["start"]:
            gap = (st - sets[-1]["start"]).total_seconds() - (sets[-1]["lap_dur"] or 0)
            if gap > 3:
                sets[-1]["rest"] = gap
        sets.append({"lengths": lengths, "rest": float(idle), "start": st, "lap_dur": lap.get("duration"),
                     "avg_hr": lap.get("averageHR"), "max_hr": lap.get("maxHR")})
    durs = sorted(l["duration"] for x in sets for l in x["lengths"] if l["duration"] > 0)
    ref = durs[min(len(durs) - 1, int(0.65 * len(durs)))] if durs else 35
    good = [l["strokes"] for x in sets for l in x["lengths"] if l["duration"] >= ref * 0.6]
    ref_strokes = statistics.median(good) if good else 0
    counts: dict = {}
    for x in sets:
        for l in x["lengths"]:
            if l.get("stroke"):
                counts[l["stroke"]] = counts.get(l["stroke"], 0) + 1
    main_stroke = max(counts, key=counts.get) if counts else None
    corrections = corrections or {}
    if sets:
        sets[-1]["rest"] = 0.0
    out_sets = []
    for i, x in enumerate(sets, 1):
        auto = len(merge_lengths(x["lengths"], ref, ref_strokes, main_stroke))
        manual = corrections.get(str(i), corrections.get(i))
        t = sum(l["duration"] for l in x["lengths"])
        out_sets.append({
            "set": i, "watch_lengths": len(x["lengths"]), "auto_lengths": auto, "manual_lengths": manual,
            "length_secs": [round(l["duration"], 1) for l in x["lengths"]],
            "length_strokes": [l["strokes"] for l in x["lengths"]],
            "swim_secs": round(t), "rest_after_secs": round(x["rest"]),
            "avg_hr": x["avg_hr"], "max_hr": x["max_hr"],
        })
    return {
        "activity_id": aid, "date": s.get("startTimeLocal"), "pool_m": pool,
        "watch_distance_m": s.get("distance"), "elapsed_secs": s.get("elapsedDuration") or s.get("duration"),
        "moving_secs": s.get("movingDuration"), "avg_hr": s.get("averageHR"), "max_hr": s.get("maxHR"),
        "calories": s.get("calories"), "bmr_calories": s.get("bmrCalories"), "strokes": s.get("strokes"),
        "garmin_avg_swolf": s.get("averageSwolf"), "aerobic_te": s.get("aerobicTrainingEffect"),
        "hr_zones": hr_zones(raw),
        "typical_length_secs": round(ref, 1), "typical_strokes": ref_strokes, "sets": out_sets,
    }
