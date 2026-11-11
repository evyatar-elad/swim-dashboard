"""שואב את אימוני השחייה (ואימוני הכוח) מ-Garmin Connect ושומר אותם מוצפנים לדשבורד.

משתני סביבה:
  DASHBOARD_PASSWORD  - הסיסמה שבה מוצפנים הנתונים (אותה מקלידים בדשבורד)
  GARMIN_TOKENS       - (מועדף) טוקנים בפורמט JSON שנוצרו בהתחברות ראשונה
  GARMIN_EMAIL / GARMIN_PASSWORD - חלופה: התחברות עם שם משתמש וסיסמה
  GARMIN_TOKENSTORE   - תיקייה לשמירת טוקנים מתחדשים (ברירת מחדל .garmin_tokens)
  START_DATE          - מאיזה תאריך לשאוב (ברירת מחדל 2024-01-01 - כל ההיסטוריה)
  REFRESH_DAYS        - אימונים מהימים האחרונים נשאבים מחדש (אם ערכת אותם בגרמין)
"""
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

from garminconnect import Garmin

sys.path.insert(0, str(Path(__file__).parent))
from crypto_util import decrypt_json, encrypt_json  # noqa: E402
import ai_coach  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "data" / "activities.enc.json"
USER = ROOT / "docs" / "data" / "user.enc.json"
STATUS = ROOT / "docs" / "data" / "status.json"
SCHEMA = ROOT / "docs" / "data" / "schema.json"
SWIM_TYPES = {"lap_swimming", "swimming", "open_water_swimming"}
STRENGTH_TYPES = {"strength_training", "indoor_cardio", "hiit", "fitness_equipment"}
SUMMARY_KEYS = [
    "activityId", "activityName", "startTimeLocal", "startTimeGMT", "distance", "duration",
    "elapsedDuration", "movingDuration", "averageHR", "maxHR", "calories", "bmrCalories",
    "averageSwimCadenceInStrokesPerMinute", "averageSwolf", "activeLengths", "strokes",
    "poolLength", "unitOfPoolLength", "avgStrokeDistance", "avgStrokes",
    "hrTimeInZone_1", "hrTimeInZone_2", "hrTimeInZone_3", "hrTimeInZone_4", "hrTimeInZone_5",
    "aerobicTrainingEffect", "anaerobicTrainingEffect", "trainingEffectLabel",
    "vO2MaxValue", "deviceId", "manufacturer", "totalSets", "activeSets", "totalReps",
    "moderateIntensityMinutes", "vigorousIntensityMinutes", "differenceBodyBattery",
]


def clean(obj):
    """מסיר שדות ריקים כדי שהקובץ יהיה קטן."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items() if v not in (None, [], {}, "")}
    if isinstance(obj, list):
        return [clean(v) for v in obj]
    return obj


TOKEN_FILE = ROOT / ".garmin_tokens" / "tokens.enc.json"


def save_tokens(g: Garmin) -> None:
    """הטוקנים נשמרים ב-cache של Actions מוצפנים (AES-256) - גם אם מישהו ניגש ל-cache, אין לו מה לקרוא."""
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    for f in TOKEN_FILE.parent.iterdir():  # מוחק קבצי טוקנים ישנים לא מוצפנים מה-cache
        if f != TOKEN_FILE and f.is_file():
            f.unlink()
    TOKEN_FILE.write_text(json.dumps(encrypt_json({"t": g.client.dumps()}, os.environ["DASHBOARD_PASSWORD"])))


def login() -> Garmin:
    tokens_json = os.getenv("GARMIN_TOKENS", "").strip()
    if TOKEN_FILE.exists():
        try:
            cached = decrypt_json(json.loads(TOKEN_FILE.read_text()), os.environ["DASHBOARD_PASSWORD"])["t"]
            g = Garmin()
            g.login(cached)
            print("התחברות עם טוקנים שמורים (cache מוצפן)")
            return g
        except Exception as e:  # noqa: BLE001
            print(f"הטוקנים השמורים לא עבדו ({type(e).__name__})")
    if tokens_json:
        g = Garmin()
        g.login(tokens_json)
        print("התחברות עם GARMIN_TOKENS")
        return g
    email, pw = os.getenv("GARMIN_EMAIL"), os.getenv("GARMIN_PASSWORD")
    if not (email and pw):
        sys.exit("חסרים פרטי התחברות: GARMIN_TOKENS או GARMIN_EMAIL + GARMIN_PASSWORD")
    g = Garmin(email, pw)
    g.login()
    print("התחברות עם שם משתמש וסיסמה")
    return g


def type_key(a: dict) -> str:
    return (a.get("activityType") or {}).get("typeKey", "")


def main() -> None:
    password = os.getenv("DASHBOARD_PASSWORD")
    if not password:
        sys.exit("חסר DASHBOARD_PASSWORD")
    start = os.getenv("START_DATE") or "2024-01-01"
    refresh_days = int(os.getenv("REFRESH_DAYS", "3"))

    existing = {"swims": {}, "other": {}}
    if OUT.exists():
        try:
            existing = decrypt_json(json.loads(OUT.read_text()), password)
        except Exception as e:  # noqa: BLE001
            print(f"לא ניתן לפענח את הקובץ הקיים ({type(e).__name__}) - שואב הכול מחדש")

    g = login()
    save_tokens(g)
    today = dt.date.today().isoformat()
    acts = g.get_activities_by_date(start, today)
    print(f"נמצאו {len(acts)} פעילויות מאז {start}")
    cutoff = (dt.datetime.now() - dt.timedelta(days=refresh_days)).strftime("%Y-%m-%d")

    swims, other = dict(existing.get("swims", {})), dict(existing.get("other", {}))
    new_count = 0
    for a in acts:
        aid, tk = str(a["activityId"]), type_key(a)
        summary = clean({k: a.get(k) for k in SUMMARY_KEYS})
        summary["type"] = tk
        if tk in SWIM_TYPES:
            recent = (a.get("startTimeLocal") or "")[:10] >= cutoff
            if aid in swims and not recent:
                continue
            splits = g.get_activity_splits(aid)
            try:
                zones = g.get_activity_hr_in_timezones(aid)
            except Exception:  # noqa: BLE001
                zones = None
            swims[aid] = {"summary": summary, "laps": clean((splits or {}).get("lapDTOs", [])),
                          "hrZones": clean(zones)}
            new_count += aid not in existing.get("swims", {})
            time.sleep(0.5)
        else:
            other[aid] = {"summary": summary}

    user = {}
    if USER.exists():
        try:
            user = decrypt_json(json.loads(USER.read_text()), password)
        except Exception as e:  # noqa: BLE001
            print(f"לא ניתן לפענח את קובץ התיקונים ({type(e).__name__})")
    payload = {"swims": swims, "other": other}
    payload["ai"] = ai_coach.run(payload, user, existing.get("ai"))
    write_schema(swims)
    changed = any(payload.get(k) != existing.get(k) for k in ("swims", "other", "ai"))
    write_status("ok", f"{len(swims)} שחיות, {new_count} חדשות", len(swims), new_count, bool(payload["ai"]))
    if not changed:
        print("אין נתונים חדשים")
        return
    payload["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(encrypt_json(payload, password)))
    print(f"נשמר: {len(swims)} שחיות ({new_count} חדשות), {len(other)} פעילויות אחרות")


def write_status(state: str, message: str, swims: int = 0, new: int = 0, ai: bool = False) -> None:
    """קובץ סטטוס לא רגיש (בלי נתוני בריאות) - מוצג בדשבורד ועוזר לאבחן תקלות."""
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps({
        "state": state, "message": message, "swims": swims, "new": new, "ai": ai,
        "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }, ensure_ascii=False, indent=1))


def _shape(v):
    if isinstance(v, dict):
        return {k: _shape(x) for k, x in sorted(v.items())}
    if isinstance(v, list):
        return [_shape(v[0]), f"x{len(v)}"] if v else []
    return type(v).__name__


def write_schema(swims: dict) -> None:
    """שמות שדות וסוגים בלבד (בלי ערכים) - לאבחון הפורמט של גרמין."""
    if not swims:
        return
    last = swims[max(swims, key=lambda k: swims[k]["summary"].get("startTimeLocal", ""))]
    SCHEMA.write_text(json.dumps(_shape(last), ensure_ascii=False, indent=1))


def safe_main() -> None:
    try:
        main()
    except SystemExit as e:
        write_status("error", str(e))
        raise
    except Exception as e:  # noqa: BLE001
        # בקובץ הציבורי רק סוג השגיאה, בלי הודעה שעלולה להכיל פרטים
        write_status("error", type(e).__name__)
        raise


if __name__ == "__main__":
    safe_main()
