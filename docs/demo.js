// נתוני הדגמה בדויים לגמרי (לא של אף אדם אמיתי) - מוצגים רק כשאין נתונים מוצפנים.
// בנויים באותו מבנה שגרמין מחזיר (lapDTOs / lengthDTOs), כולל בריכות "מפוצלות" כמו שקורה בשעון.
window.DEMO_DATA = (function () {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const swim = (id, date, hour, sets, restSecs, hrBase, hrMax) => {
    let t = new Date(date + "T" + hour + ":00Z").getTime();
    const laps = [];
    let strokesAll = 0, dist = 0, moving = 0;
    sets.forEach((s, i) => {
      const lengths = [];
      const start = t;
      for (let k = 0; k < 10; k++) {
        const d = s.pace * 0.2 * (0.94 + rnd() * 0.12);
        const st = Math.round(15 + rnd() * 2);
        const split = s.splits.includes(k) ? (s.splits3 && s.splits3.includes(k) ? 3 : 2) : 1;
        for (let p = 0; p < split; p++) {
          const frac = split === 1 ? 1 : p === 0 ? 0.6 : 0.4 / (split - 1);
          const dur = split === 1 ? d : Math.max(11, d * frac);
          const strokes = Math.max(4, Math.round(st * (dur / d)));
          lengths.push({ lengthIndex: lengths.length + 1, distance: 20, duration: +dur.toFixed(1),
            totalNumberOfStrokes: strokes, averageSWOLF: Math.round(dur + strokes), swimStroke: "BREASTSTROKE",
            averageHR: Math.round(hrBase + i * 3 + rnd() * 6), startTimeGMT: new Date(t).toISOString() });
          t += dur * 1000; strokesAll += strokes;
        }
      }
      const dur = (t - start) / 1000;
      moving += dur; dist += lengths.length * 20;
      laps.push({ lapIndex: laps.length + 1, startTimeGMT: new Date(start).toISOString(), distance: lengths.length * 20,
        duration: dur, movingDuration: dur, averageHR: Math.round(hrBase + i * 3), maxHR: Math.round(hrBase + 18 + i * 4),
        totalNumberOfStrokes: lengths.reduce((a, l) => a + l.totalNumberOfStrokes, 0), numberOfActiveLengths: lengths.length,
        lengthDTOs: lengths });
      if (i < sets.length - 1) {
        laps.push({ lapIndex: laps.length + 1, startTimeGMT: new Date(t).toISOString(), distance: 0, duration: restSecs[i], numberOfActiveLengths: 0, lengthDTOs: [{ duration: restSecs[i], lengthIndex: 1 }] });
        t += restSecs[i] * 1000;
      }
    });
    const elapsed = moving + restSecs.reduce((a, b) => a + b, 0);
    const cal = Math.round(elapsed / 60 * 7.6);
    return [String(id), {
      summary: { activityId: id, activityName: "שחיה בבריכה", type: "lap_swimming", startTimeLocal: date + " " + hour + ":00",
        distance: dist, duration: elapsed, elapsedDuration: elapsed, movingDuration: moving, averageHR: hrBase + 6, maxHR: hrMax,
        calories: cal, bmrCalories: Math.round(elapsed / 60 * 1.5), strokes: strokesAll, poolLength: 2000,
        unitOfPoolLength: { unitKey: "meter", factor: 100 }, activeLengths: dist / 20,
        hrTimeInZone_1: elapsed * 0.18, hrTimeInZone_2: elapsed * 0.34, hrTimeInZone_3: elapsed * 0.32, hrTimeInZone_4: elapsed * 0.13, hrTimeInZone_5: elapsed * 0.03 },
      laps,
    }];
  };
  const S = (pace, splits = [], splits3 = []) => ({ pace, splits, splits3 });
  const swims = Object.fromEntries([
    swim(8001, "2026-09-06", "07:10", [S(152, [3]), S(150), S(149, [6]), S(151), S(153)], [130, 120, 125, 118], 124, 158),
    swim(8002, "2026-09-13", "07:05", [S(150), S(148, [2], [2]), S(147), S(149), S(151)], [110, 105, 100, 98], 125, 157),
    swim(8003, "2026-09-20", "07:20", [S(149), S(147), S(146), S(148, [5]), S(150)], [95, 90, 88, 85], 126, 159),
    swim(8004, "2026-10-04", "07:15", [S(148, [1]), S(146), S(145), S(147), S(148)], [85, 80, 78, 75], 127, 160),
    swim(8005, "2026-10-11", "07:10", [S(147), S(145), S(144), S(146, [4, 7]), S(147)], [72, 70, 66, 64], 127, 158),
    swim(8006, "2026-10-18", "07:05", [S(146), S(144), S(143), S(145), S(146)], [62, 60, 58, 55], 128, 160),
    swim(8007, "2026-10-25", "07:10", [S(145), S(143, [6]), S(142), S(144), S(144)], [55, 52, 50, 48], 128, 159),
    swim(8008, "2026-11-01", "07:00", [S(144), S(142), S(141), S(143), S(143, [3])], [48, 46, 45, 44], 129, 158),
    swim(8009, "2026-11-08", "07:05", [S(143, [5], [5]), S(141), S(140), S(141), S(139)], [42, 40, 38, 36], 129, 156),
  ]);
  Object.values(swims).forEach((sw) => {
    const e = sw.summary.elapsedDuration;
    sw.summary.maxHR = Math.max(...sw.laps.map((l) => l.maxHR || 0));
    sw.hrZones = [[1, 96, 0.12], [2, 115, 0.24], [3, 134, 0.41], [4, 152, 0.21], [5, 171, 0.02]].map(([n, lo, f]) => ({ zoneNumber: n, zoneLowBoundary: lo, secsInZone: e * f }));
  });
  const other = {
    
  };
  const ai = {
    generatedAt: "2026-11-08T08:00:00Z",
    length_review: [{ activity_id: "8009", set_lengths: [10, 10, 10, 10, 10], confidence: "high", note: "בסט 1 השעון פיצל בריכה אחת לשלושה קטעים קצרים (עצירה קצרה באמצע, כנראה סידור משקפת). בפועל 10 בריכות בכל סט." }],
    latest: {
      activity_id: "8009",
      headline: "שלושה שיאים בבוקר אחד: הקצב הכי מהיר, המנוחות הכי קצרות והאימון הכי קצר",
      paragraphs: [
        "זו השחיה הטובה ביותר שלך מאז שהתחלת. שחית 1,000 מטר בקצב ממוצע של 2:22 ל-100 מטר, והאימון כולו לקח 26 דקות. בתחילת ספטמבר אותו מרחק לקח 33 דקות. רוב השיפור הגיע מהמנוחות: הן ירדו מכשתי דקות בין סט לסט לפחות מ-40 שניות.",
        "הסט הראשון היה האיטי ביותר (2:28), ומשם התחממת: הסט השלישי היה המהיר ביותר (2:18), והסט האחרון כמעט באותו קצב. זה בדיוק מה שרוצים לראות - בלי קריסה בסוף, גם אחרי מנוחות קצרות.",
      ],
      vs_previous: "לעומת השבוע שעבר: מהיר ב-2 שניות ל-100 מטר, המנוחות קצרות ב-7 שניות בממוצע, והדופק הממוצע כמעט זהה. כלומר עשית יותר עבודה באותו מאמץ של הלב.",
      vs_average: "לעומת הממוצע שלך: מהיר ב-5 שניות ל-100 מטר, ונחת פחות מחצי מהזמן. זה שיפור עקבי ולא יום טוב מקרי - הקו בגרף יורד כבר תשעה שבועות ברציפות.",
      health: "הדופק עלה בהדרגה מסט לסט (ממוצע 129 בסט הראשון, 141 באחרון) - תגובה טבעית למנוחות קצרות, והוא לא זינק לאזור המקסימלי. כ-65% מהזמן היית באזורים 2-3, מאמץ שאפשר להחזיק לאורך זמן, וכ-20% במאמץ חזק בסופי הסטים. השילוב הזה מצוין לסיבולת הלב ולשומנים בדם.",
      watch_tip: "בסט הראשון השעון פיצל בריכה לשלושה קטעים - כנראה עצרת רגע לסדר את המשקפת. בפעם הבאה: אם צריך לעצור, לחיצה מיידית על הכפתור התחתון, ושוב לחיצה כשממשיכים.",
    },
    journey: {
      summary: "בתשעה שבועות הקצב השתפר מ-2:30 ל-2:22 ל-100 מטר, והמנוחות ירדו מכשתי דקות לפחות מ-40 שניות. האימון כולו התקצר בשבע דקות, והדופק הממוצע עלה רק בקצת - הלב מתמודד עם אימון צפוף יותר בלי מאמץ חריג.",
      consistency: "שחית ב-9 מתוך 10 שבועות, עם שבוע אחד בלבד בלי שחיה בתחילת אוקטובר. זו עקביות מצוינת, והיא הסיבה העיקרית לשיפור. להמשיך בדיוק ככה.",
      health_outlook: "הירידה בטריגליצרידים והעלייה ב-HDL הן בדיוק מה שפעילות קבועה עושה, והן כבר נראות בבדיקות. ה-LDL ירד מעט; עליו משפיעים בעיקר תזונה ולפעמים החלטה עם הרופא, אז כדאי לדבר איתו על הצעד הבא.",
      blood_test_advice: "הבדיקה האחרונה נעשתה לפני שלושה ימים. בדיקה חוזרת בעוד כשלושה חודשים, בפברואר, תראה אם המגמה נמשכת. כדאי להיבדק באותה מעבדה ובצום.",
    },
    next_goals: [
      { metric: "rest", title: "מנוחות של עד 35 שניות", detail: "המנוחות ירדו כבר ל-0:39. עוד 4 שניות בכל מנוחה יהפכו את האימון לכמעט רציף.", target: "כל מנוחה עד 0:35" },
      { metric: "set_pace", title: "סט ראשון מהיר יותר", detail: "הסט הראשון היה איטי ב-10 שניות מהשלישי. חימום קצר לפני ההתחלה יעזור לך להתחיל חזק יותר.", target: "סט 1 בקצב 2:24 או מהיר יותר" },
      { metric: "clean_count", title: "ספירה נקייה", detail: "השעון פיצל בריכה בסט הראשון. עוצרים באמצע? לחיצה מיידית על הכפתור התחתון.", target: "50 בריכות בדיוק לפי השעון" },
      { metric: "weekly", title: "שבוע עשירי ברציפות", detail: "העקביות היא מה שמזיז את בדיקות הדם.", target: "שחיה אחת השבוע" },
    ],
  };
  return { generatedAt: "2026-10-14T00:00:00Z", demo: true, swims, other, ai };
})();
