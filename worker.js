// blackjack.ly-systems.co.il: serves the site from public/ and the /api/* endpoints.
// Every paid-looking piece degrades to a free one: no GEMINI_KEY → Workers AI, no RESEND_KEY → no email step.
const BUILD = "2026-10-25 v3 brandon-style";
const ORIGIN = "https://blackjack.ly-systems.co.il";
const ORIGINS = [ORIGIN, "https://yossi.ly-systems.co.il"];
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
// Free fallbacks, best Hebrew first (compared on the same chat, 2026-10-25). budget = characters of chat sent.
const CF_MODELS = [
  {id: "@cf/openai/gpt-oss-120b", budget: 45000, responses: true},
  {id: "@cf/meta/llama-4-scout-17b-16e-instruct", budget: 45000},
  {id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", budget: 20000},
];
const GEMINI_BUDGET = 70000;
const REPORT_TTL = 30 * 86400;
const LIMITS = {codePerIpHour: 6, codePerEmailHour: 3, reportPerEmailDay: 5, reportPerIpDay: 8, codeTries: 5};

const CONTEXTS = {
  partner: "זוגיות או משהו רומנטי (בן/בת זוג, משהו לא מוגדר, אקס)",
  group: "קבוצת חברים",
  friend: "חבר או חברה קרובים",
  family: "משפחה",
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
  const {lines, statsText, context, me, questions, people} = input;
  const chat = trimLines(lines, budget);
  const isGroup = people.length > 2;
  const other = people.filter(p => p !== me);
  return `אתה "בלאק ג'ק", מנתח צ'אטים. ישיר, שנון וחם: אכזרי, הוגן, ומוזר-חביב. אתה קורא את כל השיחה ואומר מה באמת קורה בה, בלי לייפות ובלי להתחנף.

ההקשר: ${CONTEXTS[context] || CONTEXTS.other}.
${me ? `מי ששלח לך את הצ'אט: "${me}". פנה אליו בגוף שני רבים ("אתם", "כתבתם"), ול${isGroup ? "אחרים" : `"${other[0] || "הצד השני"}"`} בשמם.` : "מי ששלח את הצ'אט לא משתתף בו. כתוב עליהם בגוף שלישי, בשמם."}
${questions ? `מה מעניין אותו במיוחד: ${questions}\nתקדיש לזה סעיף משלו ותענה ישירות.` : ""}

איך כותבים:
- כל כותרת סעיף ספציפית וסקרנית, ונשענת על פרט אמיתי מהשיחה: רגע, שבוע, מילה, הודעה. לדוגמה (רק לסגנון): "השבוע שבו הכול השתנה", "מה בעצם מסתתר מאחורי ה'חחח' של דנה", "ההודעה שנכתבה מחדש ארבע פעמים". אסור כותרות גנריות כמו "דפוסי תקשורת" או "סיכום".
- כל סעיף 2–3 פסקאות קצרות. צטטו הודעה אמיתית קצרה במירכאות, עם התאריך, כראיה.
- משפטים קצרים. הומור יבש. בלי מילים גבוהות ובלי סימני קריאה מיותרים.
- רק מה שכתוב בשיחה ובנתונים. אל תמציא ציטוטים או אירועים. מה שלא ברור, תגיד שלא ברור. אתה לא קורא מחשבות.
- בלי אבחנות פסיכולוגיות ובלי תוויות קליניות.
- 5 עד 7 סעיפים.${isGroup ? "\n- בקבוצה: תן 4–6 פרסים (awards), כל אחד עם עקיצה שמצטטת הודעה אמיתית." : ""}

החזר JSON בלבד, בלי שום טקסט מסביב, במבנה הזה:
{"headline":"משפט אחד חד שמסכם הכול","score":${isGroup ? "null" : "מספר 1-10 לבריאות הקשר"},"score_label":"${isGroup ? "" : "2-4 מילים שמסבירות את הציון"}","sections":[{"emoji":"🔥","title":"...","body":"פסקה\\n\\nפסקה"}],"awards":[${isGroup ? '{"emoji":"🏆","title":"שם הפרס","winner":"שם","why":"..."}' : ""}],"bottom_line":"2-3 משפטים: השורה התחתונה ועצה אחת קונקרטית"}

נתונים שחושבו על כל השיחה:
${statsText}

השיחה${chat.partial ? " (קטע: ההתחלה והחלק האחרון)" : ""}:
${chat.text}`;
}

// Free models often emit almost-JSON; repair the common slips before giving up.
function looseJson(raw){
  const tries = [raw, raw.replace(/}\s*}\s*,\s*{/g, "},{").replace(/:\s*\\"/g, ': "').replace(/,\s*([}\]])/g, "$1")];
  for (const t of tries){ try { return JSON.parse(t); } catch {} }
  // last resort: pull the fields out one by one
  const str = re => { const m = re.exec(raw); return m ? JSON.parse('"' + m[1] + '"') : ""; };
  const sections = [];
  const rx = /"emoji"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"title"\s*:\s*\\?"((?:[^"\\]|\\.)*)"\s*,\s*"body"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = rx.exec(raw))) try { sections.push({emoji: JSON.parse('"' + m[1] + '"'), title: JSON.parse('"' + m[2] + '"'), body: JSON.parse('"' + m[3] + '"')}); } catch {}
  if (!sections.length) return null;
  const score = /"score"\s*:\s*(\d+)/.exec(raw);
  try {
    return {headline: str(/"headline"\s*:\s*"((?:[^"\\]|\\.)*)"/), score: score ? +score[1] : null,
      score_label: str(/"score_label"\s*:\s*"((?:[^"\\]|\\.)*)"/), bottom_line: str(/"bottom_line"\s*:\s*"((?:[^"\\]|\\.)*)"/), sections, awards: []};
  } catch { return {sections, awards: []}; }
}

function parseReport(text){
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s){
    try {
      const r = looseJson(text.slice(s, e + 1));
      if (r && Array.isArray(r.sections) && r.sections.length) return {
        headline: String(r.headline || ""), score: Number.isFinite(+r.score) && r.score !== null ? Math.max(1, Math.min(10, +r.score)) : null,
        score_label: String(r.score_label || ""), bottom_line: String(r.bottom_line || ""),
        sections: r.sections.slice(0, 9).map(x => ({emoji: String(x.emoji || "•").slice(0, 8), title: String(x.title || ""), body: String(x.body || "")})),
        awards: Array.isArray(r.awards) ? r.awards.slice(0, 8).map(a => ({emoji: String(a.emoji || "🏆").slice(0, 8), title: String(a.title || ""), winner: String(a.winner || ""), why: String(a.why || "")})) : [],
      };
    } catch {}
  }
  return {headline: "", score: null, score_label: "", bottom_line: "", awards: [], sections: [{emoji: "📝", title: "מה בלאק ג'ק חושב", body: text.replace(/[{}"]/g, "")}]};
}

async function viaGemini(env, prompt){
  let last;
  for (const model of GEMINI_MODELS){
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY},
      body: JSON.stringify({contents: [{role: "user", parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.9, maxOutputTokens: 6000, responseMimeType: "application/json"}}),
    });
    const data = await r.json().catch(() => ({}));
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (r.ok && text) return {text, engine: model};
    last = `${model}: ${r.status} ${JSON.stringify(data.error || {}).slice(0, 160)}`;
  }
  throw new Error(last);
}

async function viaWorkersAI(env, input, errors){
  for (const m of CF_MODELS){
    try {
      const prompt = buildPrompt(input, m.budget);
      let text;
      if (m.responses){
        // gpt-oss speaks the Responses format; keep only the final message, not its reasoning
        const out = await env.AI.run(m.id, {input: prompt, reasoning: {effort: "low"}});
        text = (out?.output || []).filter(o => o.type === "message").flatMap(o => o.content || []).map(c => c.text || "").join("");
      } else {
        const out = await env.AI.run(m.id, {messages: [{role: "user", content: prompt}], max_tokens: 3500, temperature: 0.8});
        text = typeof out?.response === "string" ? out.response : JSON.stringify(out?.response || "");
      }
      const report = parseReport(text || "");
      if (report.sections.length >= 3) return {text, engine: m.id, report};
      errors.push(m.id + ": unusable");
    } catch (e){ errors.push(m.id + ": " + e.message); }
  }
  throw new Error(errors.join(" | "));
}

async function writeReport(env, input){
  const errors = [];
  if (env.GEMINI_KEY){
    try { const r = await viaGemini(env, buildPrompt(input, GEMINI_BUDGET)); return {...r, report: parseReport(r.text)}; }
    catch (e){ errors.push(e.message); console.log("gemini failed:", e.message); }
  }
  return viaWorkersAI(env, input, errors);
}

/* ---------- routes ---------- */

async function api(req, env, ctx, path){
  const ip = req.headers.get("CF-Connecting-IP") || "?";
  const emailOn = !!env.RESEND_KEY;

  if (path === "/api/config") return json({build: BUILD, email: emailOn, engine: env.GEMINI_KEY ? "gemini" : "workers-ai"});

  if (req.method === "GET" && path.startsWith("/api/r/")){
    const id = path.slice(7);
    const rep = await env.YOSSI.get("rep:" + id, "json");
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

    const lines = Array.isArray(body.lines) ? body.lines.map(String).slice(-6000) : [];
    if (lines.length < 5) return fail("השיחה קצרה מדי לניתוח.");
    const input = {
      lines, statsText: String(body.statsText || "").slice(0, 6000), context: String(body.context || "other"),
      me: body.me ? String(body.me).slice(0, 60) : "", questions: String(body.questions || "").slice(0, 500),
      people: Array.isArray(body.people) ? body.people.map(String).slice(0, 40) : [],
    };
    let out;
    try { out = await writeReport(env, input); }
    catch (e){
      console.log("AI failed:", e.message);
      return fail("בלאק ג'ק עמוס כרגע. נסו שוב בעוד כמה דקות.", 503);
    }
    const id = randomId(10), owner = randomId(20);
    const rec = {id, created: Date.now(), title: String(body.title || "").slice(0, 80), context: input.context, me: input.me,
      stats: body.stats || null, report: out.report, engine: out.engine, owner: await sha256(owner)};
    await env.YOSSI.put("rep:" + id, JSON.stringify(rec), {expirationTtl: REPORT_TTL});
    if (email){
      ctx.waitUntil(sendMail(env, email, "בלאק ג'ק סיים לקרוא. הנה מה שהוא חושב 👀", mailShell(`<h2 style="margin:12px 0">הדוח שלכם מוכן</h2>
        <p style="font-size:18px">"${out.report.headline.replace(/[<>&]/g, "")}"</p>
        <p><a href="${ORIGIN}/r/${id}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:12px;text-decoration:none;font-weight:bold">לקריאת הדוח המלא ←</a></p>
        <p style="color:#666">הלינק פעיל 30 יום.</p>`)).catch(e => console.log(e.message)));
    }
    delete rec.owner;
    return json({...rec, owner});
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
