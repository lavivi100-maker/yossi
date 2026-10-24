// Serves the site and relays /api/report to Gemini, so the API key never reaches the page.
const BUILD = "2026-10-24 21:05 v2 ai-relay";
const MODEL = "gemini-flash-latest";
const ALLOWED_ORIGINS = ["https://yossi.ly-systems.co.il"];
const MAX_PROMPT = 120000;           // characters
const PER_IP_PER_HOUR = 6;           // best effort: counts live per isolate, not globally

const hits = new Map();

function cors(origin){
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const json = (obj, status, headers) =>
  new Response(JSON.stringify(obj), {status, headers: {...headers, "Content-Type": "application/json; charset=utf-8"}});

export default {
  async fetch(req, env){
    if (!new URL(req.url).pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    const origin = req.headers.get("Origin") || "";
    const h = cors(origin);
    if (req.method === "OPTIONS") return new Response(null, {headers: h});
    if (req.method === "GET") return json({ok: true, build: BUILD}, 200, h);
    if (req.method !== "POST") return json({error: "method"}, 405, h);
    if (h["Access-Control-Allow-Origin"] !== origin) return json({error: "origin"}, 403, h);

    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const now = Date.now();
    const list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
    if (list.length >= PER_IP_PER_HOUR) return json({error: "rate", message: "יותר מדי דוחות בשעה האחרונה. נסו שוב מאוחר יותר."}, 429, h);
    list.push(now); hits.set(ip, list);

    let prompt;
    try { ({prompt} = await req.json()); } catch { return json({error: "bad json"}, 400, h); }
    if (typeof prompt !== "string" || prompt.length < 50) return json({error: "empty"}, 400, h);
    if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT);

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: {"Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY},
      body: JSON.stringify({
        contents: [{role: "user", parts: [{text: prompt}]}],
        generationConfig: {temperature: 0.9, maxOutputTokens: 4096},
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok){
      const busy = r.status === 429;
      return json({error: "upstream", status: r.status,
        message: busy ? "יוסי עמוס כרגע (הגענו למכסה החינמית). נסו שוב בעוד כמה דקות."
                      : "משהו השתבש מול שירות הבינה המלאכותית. נסו שוב."}, busy ? 429 : 502, h);
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (!text) return json({error: "empty answer", message: "לא התקבלה תשובה. ייתכן שהתוכן נחסם על ידי מסנן הבטיחות."}, 502, h);
    return json({text}, 200, h);
  },
};
