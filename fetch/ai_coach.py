"""פרשנות מילולית הוליסטית + בדיקת מדידת הבריכות בעזרת Claude.

רץ מתוך fetch_garmin.py רק כשהנתונים השתנו (שחייה חדשה, תיקון ידני, בדיקת דם חדשה).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os

import anthropic

from swim_model import process_swim

MODEL = "claude-opus-5-5"
PROMPT_VERSION = 9

SYSTEM_TEMPLATE = """אתה מאמן שחייה אישי וחם, עם ידע בפיזיולוגיה של אימון ובבריאות הלב. אתה כותב בעברית בלבד, בגוף שני זכר, בשפה פשוטה, ברורה ולא טכנית מדי.
אל תשתמש במקף ארוך (—) או במקף בינוני (–), רק במקף רגיל (-).
כתוב "שחיה" ו"שחיות" ביו"ד אחת (לא "שחייה"). כשאתה מזכיר דופק, כתוב במפורש "דופק ממוצע X" ו"דופק שיא Y" ולא "X/Y".
כשאתה משווה, השווה גם לפעם הקודמת וגם לממוצע של כל השחיות הקודמות, ואמור במפורש אם זה טוב או פחות טוב ולמה.

{PROFILE}

משימה 1 - בדיקת מדידה: לכל שחייה ולכל סט קבע כמה בריכות הוא באמת שחה. השתמש במשך כל בריכה ובמספר התנועות שלה ביחס לבריכה טיפוסית (typical_length_secs, typical_strokes). auto_lengths הוא הצעה של אלגוריתם פשוט; השגרה (10 לסט) היא רמז חזק אבל לא ודאות. אם manual_lengths קיים - זה תיקון של השחיין עצמו, והוא קובע. תן רמת ביטחון והסבר קצר.

בדיקות דם (blood_tests, במ"ג/ד"ל): total = כולסטרול כללי, ldl, hdl, nonhdl = Non-HDL, tg = טריגליצרידים. בדיקה שתאריכה לפני השחיה הראשונה היא נקודת ההתחלה. אם יש בדיקות - התייחס לערכים שלו בפועל, הסבר כל ערך בפשטות מול היעדים המקובלים, ומה סביר לצפות שישתנה עם התמדה. אם אין - אל תכתוב שאין.

אזורי הדופק (hr_zones): אזור 1 חימום, אזור 2 קל, אזור 3 אירובי, אזור 4 מאמץ גבוה, אזור 5 מקסימלי - עם טווח הפעימות והאחוז מהזמן, בדיוק כפי שהם מוצגים לו בדשבורד. האזורים האירוביים הם 2 ו-3. כשאתה מזכיר אזור, השתמש במספר ובשם (למשל "אזור 3 - אירובי") ובאחוזים מהקלט, בלי לחשב אחרת.
כל שדה בתשובה עוסק בנושא אחר ומוצג בנפרד - אל תחזור על אותו מידע בשני שדות.

משימה 2 - פרשנות: כתוב ניתוח מילולי עשיר ואישי, כמו מאמן שמכיר אותו מהיום הראשון. התבסס על המרחקים המתוקנים (לא על מרחק השעון). התייחס לשחייה האחרונה, להשוואה לפעם הקודמת ולממוצע, למגמות מההתחלה, לעקביות, לדופק ולאזורי הדופק, למנוחות, לקצב בכל סט ולעייפות, ל-SWOLF ולתנועות. חבר את זה למטרות הבריאותיות שלו, כולל תוצאות בדיקות דם אם הוזנו. היה כן: אם משהו נחלש, אמור זאת בעדינות. אל תמציא נתונים שאינם בקלט. אל תיתן אבחנה רפואית; כשמדובר בבדיקות דם, הזכר שההחלטות הרפואיות הן עם הרופא.

משימה 3 - יעדים לשחיה הבאה: 2-4 יעדים מדידים, ריאליים ומאתגרים מעט, שנגזרים מהנתונים שלו. כל יעד חייב להיות דבר שהוא יכול לעשות בפועל במים ולבדוק בשעון או בדשבורד: מנוחה מקסימלית בין סטים, קצב יעד לסט מסוים, סט ראשון רגוע וסט אחרון חזק, ספירה נקייה בלי פיצולים, שחיה בכל שבוע. בכל יעד כתוב במשפט אחד מה לעשות ולמה זה טוב לו. אל תציב יעדים של אחוזי זמן באזורי דופק - זה לא דבר שאפשר לשלוט בו תוך כדי שחיה.
אזורי דופק: גם מאמץ בינוני (אזורים 2-3) וגם מאמץ חזק (אזור 4) מועילים ללב ולשומנים בדם; לפי ההמלצות, דקה של מאמץ חזק שווה בערך לשתי דקות של מאמץ בינוני. אל תציג זמן באזור 4 כבעיה, אלא אם רוב האימון היה באזורים 4-5.
watch_tip: טיפ מעשי לשימוש בשעון בזמן השחיה עצמה (כפתורים, לחיצה בקיר, מניעת פיצולים, רטט). לא טיפ על הגדרות באפליקציה ולא הסבר טכני על אזורי דופק. אם השחיה הייתה נקייה - טיפ קצר לשימור.
כתוב בשפה פשוטה של שיחה, בלי מונחים טכניים. אם השתמשת במונח (כמו SWOLF או אזור דופק), הסבר אותו בכמה מילים."""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["length_review", "latest", "journey", "next_goals"],
    "properties": {
        "length_review": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["activity_id", "set_lengths", "confidence", "note"],
                "properties": {
                    "activity_id": {"type": "string"},
                    "set_lengths": {"type": "array", "items": {"type": "integer"}},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "note": {"type": "string"},
                },
            },
        },
        "latest": {
            "type": "object", "additionalProperties": False,
            "required": ["activity_id", "headline", "paragraphs", "vs_previous", "vs_average", "health", "watch_tip"],
            "properties": {
                "activity_id": {"type": "string"},
                "headline": {"type": "string"},
                "paragraphs": {"type": "array", "items": {"type": "string"}},
                "vs_previous": {"type": "string"},
                "vs_average": {"type": "string"},
                "health": {"type": "string"},
                "watch_tip": {"type": "string"},
            },
        },
        "journey": {
            "type": "object", "additionalProperties": False,
            "required": ["summary", "consistency", "health_outlook", "blood_test_advice"],
            "properties": {
                "summary": {"type": "string", "description": "ההתקדמות בביצועים מהשחיה הראשונה עד היום (קצב, מנוחות, זמן, תנועות, דופק). 3-5 משפטים. בלי עקביות ובלי בדיקות דם."},
                "consistency": {"type": "string", "description": "רק העקביות: באילו שבועות שחה ובאילו לא, ומה ההמלצה לתדירות. 2-4 משפטים."},
                "health_outlook": {"type": "string", "description": "רק מה צפוי שישתנה בבדיקות הדם בזכות האימונים ומה עוד משפיע (תזונה וכו'). בלי לחזור על הערכים עצמם - הם מוצגים בטבלה. 2-4 משפטים."},
                "blood_test_advice": {"type": "string", "description": "רק מתי כדאי לעשות בדיקה חוזרת ואיך להתכונן. 1-3 משפטים."},
            },
        },
        "next_goals": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "detail", "metric", "target"],
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "metric": {"type": "string", "enum": ["rest", "pace", "set_pace", "heart_rate", "clean_count", "swolf", "weekly", "other"]},
                    "target": {"type": "string"},
                },
            },
        },
    },
}


# הפרופיל האישי (מטרות בריאות, שגרה) נשמר ב-GitHub Secret ולא בקוד הציבורי
DEFAULT_PROFILE = "על השחיין: שוחה בבריכה, בדרך כלל בסטים עם מנוחות קצרות. מטרתו לשפר כושר ובריאות."


def system_prompt() -> str:
    profile = os.getenv("COACH_PROFILE", "").strip() or DEFAULT_PROFILE
    return SYSTEM_TEMPLATE.replace("{PROFILE}", profile)


def build_input(payload: dict, user: dict) -> dict:
    corr = (user or {}).get("corrections", {})
    swims = [process_swim(aid, raw, corr.get(aid)) for aid, raw in payload.get("swims", {}).items()]
    # בלי ניסיונות קצרים (פחות מ-100 מ' לפי השעון)
    swims = [s for s in swims if (s["watch_distance_m"] or 0) >= 100]
    swims.sort(key=lambda x: x["date"] or "")
    weeks = sorted({dt.date.fromisoformat(s["date"][:10]).isocalendar()[:2] for s in swims if s["date"]})
    other = [{"date": o["summary"].get("startTimeLocal"), "type": o["summary"].get("type"),
              "minutes": round((o["summary"].get("duration") or 0) / 60)} for o in payload.get("other", {}).values()]
    return {
        "today": dt.date.today().isoformat(),
        "swims": swims,
        "weeks_with_swim": len(weeks),
        "other_watch_activities": other,
        "blood_tests": (user or {}).get("bloodTests", []),
    }


def input_hash(inp: dict) -> str:
    stable = dict(inp)
    stable.pop("today", None)
    prof = hashlib.sha256(os.getenv("COACH_PROFILE", "").encode()).hexdigest()[:8]
    raw = json.dumps({"v": PROMPT_VERSION, "m": MODEL, "p": prof, "i": stable}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def run(payload: dict, user: dict, previous: dict | None) -> dict | None:
    if not os.getenv("ANTHROPIC_API_KEY"):
        print("אין ANTHROPIC_API_KEY - מדלג על הפרשנות")
        return previous
    if not os.getenv("COACH_PROFILE", "").strip():
        print("אין COACH_PROFILE - משאיר את הפרשנות הקיימת (הוסף את ה-Secret כדי לעדכן)")
        return previous
    inp = build_input(payload, user)
    if not inp["swims"]:
        return previous
    h = input_hash(inp)
    if previous and previous.get("hash") == h:
        print("הפרשנות עדכנית - אין צורך לקרוא ל-Claude")
        return previous
    client = anthropic.Anthropic()
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system_prompt(),
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": "הנתונים שלי (JSON):\n" + json.dumps(inp, ensure_ascii=False)}],
        )
    except anthropic.RateLimitError:
        print("Claude: חריגה ממגבלת קצב - ננסה בפעם הבאה")
        return previous
    except anthropic.APIStatusError as e:
        print(f"Claude: שגיאת API {e.status_code}")
        return previous
    except anthropic.APIConnectionError:
        print("Claude: בעיית רשת - ננסה בפעם הבאה")
        return previous
    if resp.stop_reason in ("refusal", "max_tokens"):
        print(f"Claude: התשובה לא הושלמה ({resp.stop_reason})")
        return previous
    text = next((b.text for b in resp.content if b.type == "text"), "")
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        print("Claude: התשובה אינה JSON תקין")
        return previous
    result["hash"] = h
    result["generatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    result["model"] = resp.model
    print(f"Claude: פרשנות חדשה ({resp.usage.input_tokens} טוקנים בקלט, {resp.usage.output_tokens} בפלט)")
    return result
