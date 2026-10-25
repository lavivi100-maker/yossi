// blackjack.ly-systems.co.il: serves the site from public/ and the /api/* endpoints.
// Every paid-looking piece degrades to a free one: no GEMINI_KEY → Workers AI, no RESEND_KEY → no email step.
const BUILD = "2026-10-26 v5 roast-flash";
const ORIGIN = "https://blackjack.ly-systems.co.il";
const ORIGINS = [ORIGIN, "https://yossi.ly-systems.co.il"];
// Gemini reads the whole chat (1M-token context). Pro has no free quota (429), so Flash leads;
// Flash is sometimes briefly overloaded (503), so it gets a second try before falling to Lite.
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-latest", "gemini-flash-lite-latest"];
const GEMINI_BUDGET = 400000;          // characters of chat
// Free fallbacks when Gemini is missing or out of quota. budget = characters of chat they can take.
const CF_MODELS = [
  {id: "@cf/openai/gpt-oss-120b", budget: 60000, responses: true},
  {id: "@cf/meta/llama-4-scout-17b-16e-instruct", budget: 60000},
  {id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", budget: 20000},
];
const REPORT_TTL = 30 * 86400;
const LIMITS = {codePerIpHour: 6, codePerEmailHour: 3, reportPerEmailDay: 5, reportPerIpDay: 8, codeTries: 5};

const CONTEXTS = {
  partner: "זוגיות או משהו רומנטי (בן/בת זוג, משהו לא מוגדר, אקס)",
  group: "קבוצת חברים",
  friend: "חבר או חברה קרובים",
  family: "קבוצת משפחה",
  work: "עבודה / צוות",
  other: "קשר אחר",
};

/* ---------- helpers ---------- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {status, headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
const fail = (message, status = 400, extra = {}) => json({error: true, message, ...extra}, status);

async function sha256(s){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomId(len = 12){
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const a = crypto.getRandomValues(new Uint8Array(len));
  return [...a].map(x => abc[x % abc.length]).join("");
}
// Best-effort counter: KV is eventually consistent, good enough to stop casual abuse.
async function bump(env, key, ttl, max){
  const n = +(await env.YOSSI.get(key) || 0);
  if (n >= max) return false;
  await env.YOSSI.put(key, String(n + 1), {expirationTtl: ttl});
  return true;
}
const normEmail = e => String(e || "").trim().toLowerCase();
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e);

async function sendMail(env, to, subject, html){
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {"Authorization": `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json"},
    body: JSON.stringify({from: env.MAIL_FROM || "בלאק ג'ק <blackjack@ly-systems.co.il>", to: [to], subject, html}),
  });
  if (!r.ok) throw new Error("mail " + r.status + " " + (await r.text()).slice(0, 200));
}
const mailShell = inner => `<div dir="rtl" style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111">
  <div style="font-size:40px">🃏😎</div>${inner}
  <p style="color:#888;font-size:12px;margin-top:32px">בלאק ג'ק · blackjack.ly-systems.co.il</p></div>`;

/* ---------- AI ---------- */

function trimLines(lines, budget){
  let total = 0;
  for (const l of lines) total += l.length + 1;
  if (total <= budget) return {text: lines.join("\n"), partial: false};
  const head = [], tail = [];
  let used = 0;
  for (const l of lines){ if (used + l.length > budget * .2) break; head.push(l); used += l.length + 1; }
  for (let i = lines.length - 1; i >= head.length; i--){ if (used + lines[i].length > budget) break; tail.unshift(lines[i]); used += lines[i].length + 1; }
  return {text: head.join("\n") + "\n[...חלק מהאמצע הושמט...]\n" + tail.join("\n"), partial: true};
}

function buildPrompt(input, budget){
  const {lines, statsText, context, me, questions, people, title} = input;
  const chat = trimLines(lines, budget);
  const isGroup = people.length > 2;
  const count = lines.length;
  const arc = isGroup ? `
1. פתיחה: פנה לכל הקבוצה בשם מצחיק שמתאים לה. הצג את עצמך ("קוראים לי בלאק ג'ק") וצחק על שם הקבוצה${title ? ` ("${title}")` : ""}. סכם את החיים שלהם ב-3 "מצבי צבירה" ברשימה, ואז משפט מעבר כמו "בואו נפתח את התיקים".
2. סעיף על ההיררכיה: מי מנהל פה מה. לכל אחד מהמשתתפים הפעילים (עד 8) כותרת משנה: שם, כינוי מצחיק ו-1–2 אימוג'ים. אחריה 2–4 פסקאות עליו, עם 1–3 ציטוטים אמיתיים שלו ותגובות של אחרים אליו.
3. סעיף אחד או שניים על הנושאים שחוזרים בקבוצה, עם ציטוטים.
4. "רגע של אמת": רגע אמיתי ורגשי מהשיחה (משהו קשה, מרגש או אמיתי). תכתוב עליו בכבוד ובלי בדיחות, תסביר מה הוא אומר על הקשר ביניהם, ואז משפט שחוזר לצחוק.
5. "מצעד המחדלים": 3–5 תקריות קצרות ומצחיקות מהשיחה, כל אחת עם כותרת מודגשת וציטוטים.
6. "התחזית": איפה כל אחד יהיה בעוד שלוש שנים, ברשימה. מוגזם, אבל נשען על מה שהם באמת.
7. סגירה: פסקה חמה ועוקצנית שחוזרת לבדיחה פנימית או לשם הקבוצה, ומסתיימת בשורה חזקה.` : `
1. פתיחה: פנה ישירות ("אתם") והצג את עצמך. משפט שמסכם את הסיפור של השניים, ו-3 "מצבי צבירה" של הקשר ברשימה.
2. תיק לכל אחד מהשניים: כותרת משנה עם שם, כינוי ואימוג'י. מה הוא עושה בצ'אט, עם ציטוטים.
3. "מי רוצה את זה יותר": עם הנתונים (מי פותח, מי עונה מהר, מי רודף) וציטוטים.
4. רגע או שבוע שבו משהו השתנה, עם ציטוטים.
5. "רגע של אמת": רגע אמיתי, בכבוד.
6. "מצעד המחדלים": 3–4 תקריות מצחיקות.
7. התחזית ועצה אחת כנה, ואז שורת סגירה.`;

  return `אתה "בלאק ג'ק", קומיקאי שעושה רוסט לצ'אטים של וואטסאפ. קראת מיליוני צ'אטים, ואתה כותב כמו סטנדאפיסט ישראלי חד: מגזים, ספציפי, מצחיק מאוד, ובסוף גם חם ואוהב. אתה יורד על אנשים כי אכפת לך מהם.

ההקשר: ${CONTEXTS[context] || CONTEXTS.other}${title ? `, שם הצ'אט: "${title}"` : ""}.
${me ? `מי ששלח לך את הצ'אט: "${me}". גם הוא חוטף, לא פחות מאחרים.` : ""}
${questions ? `מה מעניין אותו במיוחד: ${questions}. תתייחס לזה בתוך הדוח.` : ""}

מבנה הדוח:${arc}

איך כותבים:
- ספציפי, ספציפי, ספציפי. כל בדיחה נשענת על פרט אמיתי מהשיחה: מקום, אירוע, ביטוי שחוזר, הרגל, טעות כתיב, שם של מישהו. בלי בדיחות כלליות שמתאימות לכל קבוצה.
- ציטוטים: העתק הודעות אמיתיות מילה במילה, כולל שגיאות כתיב ואימוג'ים. אסור להמציא ציטוט. ציטוט כותבים בשורה נפרדת שמתחילה ב-"> ", ואפשר כמה שורות ברצף (גם של כמה אנשים: "> שם: טקסט").
- השוואות מוגזמות ודימויים מצחיקים ("כאילו עבר תרגום מגוגל טרנסלייט מיידיש"), שאלות רטוריות, ושורות מחץ קצרות בסוף פסקה.
- עברית מדוברת וישראלית, עם סלנג במידה. פסקאות קצרות.
- ${isGroup ? "אורך: 1,800–3,000 מילים." : "אורך: 1,200–2,000 מילים."}
- גבולות: לא צוחקים על מוות, פציעה, מחלה או אובדן אמיתיים. אותם מכבדים. בלי עלבונות על מראה, מוצא, מגדר או נטייה, ובלי תוכן מיני על אף אחד.

פורמט (Markdown פשוט בלבד):
- השורה הראשונה: "! " ואחריו משפט מחץ אחד שמסכם את כל הצ'אט (ישמש לשיתוף).
- כותרת סעיף: "## " ואחריה אימוג'י ואז הכותרת.
- כותרת משנה לאדם: "### ".
- ציטוטים: "> ". רשימות: "- ". הדגשה: **כך**.
- בלי טבלאות, בלי קישורים ובלי קוד.

נתונים שחושבו על כל ${count} ההודעות:
${statsText}

השיחה${chat.partial ? " (קטע: ההתחלה והחלק האחרון)" : " המלאה"}:
${chat.text}`;
}

// Report = Markdown with a "! headline" first line; anything else is kept as-is.
function parseMd(text){
  let md = String(text || "").replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/, "").trim();
  let headline = "";
  const m = /^!\s*(.+)\n/.exec(md);
  if (m){ headline = m[1].trim(); md = md.slice(m[0].length).trim(); }
  if (!headline){
    const first = md.split("\n").find(l => l.trim() && !/^[#>-]/.test(l.trim())) || "";
    headline = first.slice(0, 160);
  }
  return {format: "md", headline, md};
}
const usable = r => r.md.length > 1500 && (r.md.match(/^## /gm) || []).length >= 3;

async function viaGemini(env, prompt, errors){
  for (const [i, model] of GEMINI_MODELS.entries()){
    if (i && GEMINI_MODELS[i - 1] === model) await new Promise(r => setTimeout(r, 4000));
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY},
      body: JSON.stringify({contents: [{role: "user", parts: [{text: prompt}]}], generationConfig: {temperature: 1, maxOutputTokens: 30000}}),
    });
    const data = await r.json().catch(() => ({}));
    const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("").trim();
    if (r.ok && text){
      const report = parseMd(text);
      if (usable(report)) return {engine: model, report};
      errors.push(model + ": short answer");
    } else errors.push(`${model}: ${r.status} ${JSON.stringify(data.error?.message || data.candidates?.[0]?.finishReason || "").slice(0, 160)}`);
  }
  return null;
}

async function viaWorkersAI(env, input, errors){
  for (const m of CF_MODELS){
    try {
      const prompt = buildPrompt(input, m.budget);
      let text;
      if (m.responses){
        // gpt-oss speaks the Responses format; keep only the final message, not its reasoning
        const out = await env.AI.run(m.id, {input: prompt, reasoning: {effort: "low"}, max_output_tokens: 9000});
        text = (out?.output || []).filter(o => o.type === "message").flatMap(o => o.content || []).map(c => c.text || "").join("");
      } else {
        const out = await env.AI.run(m.id, {messages: [{role: "user", content: prompt}], max_tokens: 6000, temperature: 0.9});
        text = typeof out?.response === "string" ? out.response : "";
      }
      const report = parseMd(text);
      if (usable(report)) return {engine: m.id, report};
      errors.push(m.id + ": unusable");
    } catch (e){ errors.push(m.id + ": " + e.message); }
  }
  return null;
}

async function writeReport(env, input){
  const errors = [];
  const out = (env.GEMINI_KEY && await viaGemini(env, buildPrompt(input, GEMINI_BUDGET), errors)) || await viaWorkersAI(env, input, errors);
  if (errors.length) console.log("AI fallbacks:", errors.join(" | "));
  if (!out) throw new Error(errors.join(" | "));
  return {...out, fallbacks: errors};
}

// A long report takes minutes; keep the connection alive with whitespace until the JSON is ready.
function slowJson(ctx, work){
  const {readable, writable} = new TransformStream();
  const w = writable.getWriter(), enc = new TextEncoder();
  const beat = setInterval(() => w.write(enc.encode(" ")).catch(() => {}), 8000);
  const job = work().then(obj => obj, e => ({error: true, message: e.message || "שגיאה בשרת."}))
    .then(async obj => { clearInterval(beat); await w.write(enc.encode(JSON.stringify(obj))); await w.close(); });
  ctx.waitUntil(job);
  return new Response(readable, {headers: {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
}

/* ---------- routes ---------- */

async function api(req, env, ctx, path){
  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const emailOn = !!env.RESEND_KEY;

  if (path === "/api/config") return json({build: BUILD, email: emailOn, engine: env.GEMINI_KEY ? "gemini" : "workers-ai"});

  if (req.method === "GET" && path.startsWith("/api/r/")){
    const rep = await env.YOSSI.get("rep:" + path.slice(7), "json");
    if (!rep) return fail("הדוח הזה לא קיים או שפג תוקפו.", 404);
    delete rep.owner;
    return json(rep);
  }
  if (req.method === "DELETE" && path.startsWith("/api/r/")){
    const id = path.slice(7);
    const rep = await env.YOSSI.get("rep:" + id, "json");
    const {owner} = await req.json().catch(() => ({}));
    if (!rep || !owner || rep.owner !== await sha256(owner)) return fail("אין הרשאה.", 403);
    await env.YOSSI.delete("rep:" + id);
    return json({ok: true});
  }

  if (req.method !== "POST") return fail("method", 405);
  if (!ORIGINS.includes(req.headers.get("Origin") || ORIGIN) && !/^http:\/\/localhost(:\d+)?$/.test(req.headers.get("Origin") || "")) return fail("origin", 403);
  const body = await req.json().catch(() => null);
  if (!body) return fail("bad json");

  if (path === "/api/code"){
    if (!emailOn) return json({skip: true});
    const email = normEmail(body.email);
    if (!validEmail(email)) return fail("כתובת המייל לא נראית תקינה.");
    if (!await bump(env, "ipc:" + ip, 3600, LIMITS.codePerIpHour) || !await bump(env, "emc:" + email, 3600, LIMITS.codePerEmailHour))
      return fail("ביקשתם יותר מדי קודים. נסו שוב בעוד שעה.", 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
    await env.YOSSI.put("code:" + email, JSON.stringify({h: await sha256(code + email), tries: 0}), {expirationTtl: 600});
    try {
      await sendMail(env, email, `הקוד שלכם: ${code}`, mailShell(`<h2 style="margin:12px 0">הקוד שלכם לבלאק ג'ק</h2>
        <div style="font-size:36px;font-weight:bold;letter-spacing:8px;direction:ltr;text-align:center;background:#f3f3f3;border-radius:12px;padding:16px">${code}</div>
        <p>הקוד בתוקף ל-10 דקות. אם לא ביקשתם אותו, פשוט התעלמו מהמייל.</p>`));
    } catch (e){
      console.log(e.message);
      return fail("שליחת המייל נכשלה. נסו שוב בעוד רגע.", 502);
    }
    return json({sent: true});
  }

  if (path === "/api/verify"){
    const email = normEmail(body.email), code = String(body.code || "").replace(/\D/g, "");
    const rec = await env.YOSSI.get("code:" + email, "json");
    if (!rec) return fail("הקוד פג תוקף. בקשו קוד חדש.");
    if (rec.tries >= LIMITS.codeTries) return fail("יותר מדי ניסיונות. בקשו קוד חדש.", 429);
    if (rec.h !== await sha256(code + email)){
      rec.tries++;
      await env.YOSSI.put("code:" + email, JSON.stringify(rec), {expirationTtl: 600});
      return fail("הקוד לא נכון. נסו שוב.");
    }
    await env.YOSSI.delete("code:" + email);
    const token = randomId(24);
    await env.YOSSI.put("tok:" + token, email, {expirationTtl: 3 * 3600});
    return json({token});
  }

  if (path === "/api/report"){
    let email = null;
    if (emailOn){
      email = body.token ? await env.YOSSI.get("tok:" + body.token) : null;
      if (!email) return fail("צריך לאמת את המייל קודם.", 401, {needEmail: true});
      if (!await bump(env, "emr:" + email + ":" + new Date().toISOString().slice(0, 10), 86400, LIMITS.reportPerEmailDay))
        return fail("הגעתם למכסת הדוחות להיום. נסו שוב מחר.", 429);
    }
    if (!await bump(env, "ipr:" + ip + ":" + new Date().toISOString().slice(0, 10), 86400, LIMITS.reportPerIpDay))
      return fail("הגעתם למכסת הדוחות להיום. נסו שוב מחר.", 429);

    const lines = Array.isArray(body.lines) ? body.lines.map(String).slice(-20000) : [];
    if (lines.length < 5) return fail("השיחה קצרה מדי לניתוח.");
    const input = {
      lines, statsText: String(body.statsText || "").slice(0, 8000), context: String(body.context || "other"),
      me: body.me ? String(body.me).slice(0, 60) : "", questions: String(body.questions || "").slice(0, 500),
      people: Array.isArray(body.people) ? body.people.map(String).slice(0, 40) : [], title: String(body.title || "").slice(0, 80),
    };
    return slowJson(ctx, async () => {
      let out;
      try { out = await writeReport(env, input); }
      catch (e){
        console.log("AI failed:", e.message);
        return {error: true, message: "בלאק ג'ק עמוס כרגע. נסו שוב בעוד כמה דקות."};
      }
      const id = randomId(10), owner = randomId(20);
      const rec = {id, created: Date.now(), title: input.title, context: input.context, me: input.me,
        stats: body.stats || null, report: out.report, engine: out.engine, fallbacks: out.fallbacks, owner: await sha256(owner)};
      await env.YOSSI.put("rep:" + id, JSON.stringify(rec), {expirationTtl: REPORT_TTL});
      if (email){
        ctx.waitUntil(sendMail(env, email, "בלאק ג'ק סיים לקרוא. הנה מה שהוא חושב 👀", mailShell(`<h2 style="margin:12px 0">הדוח שלכם מוכן</h2>
          <p style="font-size:18px">"${out.report.headline.replace(/[<>&]/g, "")}"</p>
          <p><a href="${ORIGIN}/r/${id}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:bold">לקריאת הדוח המלא ←</a></p>
          <p style="color:#666">הלינק פעיל 30 יום.</p>`)).catch(e => console.log(e.message)));
      }
      delete rec.owner;
      return {...rec, owner};
    });
  }

  return fail("not found", 404);
}

export default {
  async fetch(req, env, ctx){
    const path = new URL(req.url).pathname;
    if (path.startsWith("/api/")){
      try { return await api(req, env, ctx, path); }
      catch (e){ console.log(e.stack || e.message); return fail("שגיאה בשרת. נסו שוב.", 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
