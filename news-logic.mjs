// Pure helpers for the analytics endpoints (/news/alerts/check, /news/summary, /news/top-topics).
// No I/O, no external LLM: everything is deterministic and extractive so it can be unit-tested on news.jsonl.

const ts = (it) => Date.parse(it.published_at) || 0;

// Same matching as /news/search: case-insensitive, all words must match, leading '#' optional.
export function parseTerms(q) {
  return String(q).toLowerCase().split(/\s+/).map((t) => t.replace(/^#+/, "")).filter(Boolean);
}
export const matchesTerms = (text, terms) => { const t = text.toLowerCase(); return terms.every((w) => t.includes(w)); };

// Numeric query param: undefined/"" -> default; non-number -> null (caller returns 400); number -> clamped.
export function parseNumParam(raw, { def, min, max }) {
  if (raw === undefined) return def;
  if (typeof raw !== "string" || !/^\s*\d+(\.\d+)?\s*$/.test(raw)) return null;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

export const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const human = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// ---------- text cleanup ----------
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u200D\u20E3]/gu;
const stripEmoji = (s) => s.replace(EMOJI_RE, " ").replace(/[ \t]+/g, " ").trim();
const isTagLine = (s) => s.split(/\s+/).every((w) => /^#[\p{L}\p{N}_]+$/u.test(w));

// Headline = first meaningful line (emoji removed, leading hashtag run removed when real text follows);
// a very short headline ("CRWV = -6%", "UNITED AIRLINES") is completed with the next line.
export function headlineOf(text) {
  const lines = text.split(/\n+/).map(stripEmoji).filter((l) => l && !isTagLine(l) && /[\p{L}\p{N}]/u.test(l));
  if (!lines.length) return "";
  const clean = (l) => {
    const m = /^((?:#[\p{L}\p{N}_]+\s+)+)(.*)$/u.exec(l);
    if (m && m[2].split(/\s+/).length >= 3 && /^["«(\p{L}\p{N}]/u.test(m[2])) l = m[2];
    return l.replace(/#([\p{L}\p{N}_]+)/gu, "$1").replace(/^[\s—–\-:;,.=|]+/, "").trim();
  };
  let h = clean(lines[0]);
  if (h.length < 25 && lines[1] && !/[.!?]$/.test(h)) h = `${h.replace(/[\s:,;–—-]+$/, "")}: ${clean(lines[1])}`;
  return h;
}

export function firstSentence(s, max = 220) {
  let out = s.split(/(?<=[.!?])\s+(?=["«(\p{Lu}])/u)[0].trim();
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, "") + "…";
  out = out.replace(/[\s,;:–—-]+$/, "");
  if (!/[.!?…]$/.test(out)) out += ".";
  return out;
}

const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase();
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

// items: matching items, newest first, already capped to `limit`.
// Summary = lead sentence + up to 4 de-duplicated headline sentences (high-importance first, then newest),
// padded with a "latest item" sentence so it always has 3-5 sentences when anything matched.
export function buildSummary(q, items) {
  if (!items.length) return `No recent news matched "${q}".`;
  const high = items.filter((i) => i.importance === "high");
  const oldest = Math.min(...items.map(ts));
  const n = items.length;
  const lead = `${n} matching item${n === 1 ? "" : "s"} for "${q}" since ${human(oldest)}; ${high.length} high-importance.`;
  const picked = [];
  for (const it of [...high, ...items.filter((i) => i.importance !== "high")]) {
    if (picked.length >= 4) break;
    const h = headlineOf(it.text_en);
    if (!h) continue;
    const s = firstSentence(h);
    if (picked.some((p) => similar(p, s))) continue;
    picked.push(s);
  }
  const sentences = [lead, ...picked];
  if (sentences.length < 3) sentences.push(`Most recent matching item published ${human(ts(items[0]))}.`);
  if (sentences.length < 3) sentences.push(`Source: MarketTwits (t.me/markettwits), translated to English.`);
  return sentences.join(" ");
}

// ---------- top topics ----------
export const STOPWORDS = new Set((
  "a about above after again against all almost also although am among an and another any anyone are aren't around as at back " +
  "be because been before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't done down during " +
  "each either else even ever every few for from further get gets getting give given go goes going got had hadn't has hasn't have haven't having " +
  "he her here hers herself him himself his how however i if in into is isn't it it's its itself just last least less let like likely made make " +
  "makes many may maybe me might more most much must my myself near need needs never new next no nor not now of off often on once one only or other " +
  "others our ours ourselves out over own per put rather really same say said says see seen she should shouldn't since so some still such than that " +
  "that's the their theirs them themselves then there there's these they they're this those though through thus to too toward towards under until up " +
  "upon us very via was wasn't way we we're were weren't what when where whether which while who whom whose why will with within without won't would " +
  "wouldn't yet you your yours yourself yourselves yes " +
  // news-feed noise
  "according amid already announced ahead almost asked expected exp prev previous est estimate estimates msk utc today tomorrow yesterday week weeks " +
  "month months year years day days time times first second third two three four five six seven eight nine ten hundred thousand million billion " +
  "bln mln percent report reports reported told says statement source sources news update image snapshot part level levels number end start " +
  "event coming want wants well high low new big"
).split(/\s+/));

const TOKEN_RE = /#?[\p{L}][\p{L}\p{N}_'’&-]*/gu;
function displayForm(forms) {
  const list = [...forms.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const title = list.find((f) => /^\p{Lu}[\p{Ll}\p{N}]/u.test(f) || /^\p{Lu}+$/u.test(f) && f.length <= 5);
  const f = title || list[0];
  return /^\p{Lu}+$/u.test(f) && f.length > 5 ? f[0] + f.slice(1).toLowerCase() : f;
}

// Frequency of hashtags + words (stopwords and <3-char tokens dropped), each counted at most once per item.
function countTopics(items) {
  const counts = new Map(), forms = new Map(), lastSeen = new Map(), rank = new Map(), latest = new Map(); // rank: 2 hashtag, 1 Capitalized, 0 plain
  for (const it of items) {
    const seen = new Set();
    for (let tok of stripEmoji(it.text_en).match(TOKEN_RE) || []) {
      const r = tok.startsWith("#") ? 2 : /^\p{Lu}/u.test(tok) ? 1 : 0;
      tok = tok.replace(/^#+/, "").replace(/['’]s$/i, "").replace(/[-'’&]+$/, "");
      const key = tok.toLowerCase();
      if (key.length < 3 || STOPWORDS.has(key) || !/\p{L}/u.test(key)) continue;
      rank.set(key, Math.max(rank.get(key) || 0, r));
      if (!forms.has(key)) forms.set(key, new Map());
      forms.get(key).set(tok, (forms.get(key).get(tok) || 0) + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
      if (!latest.has(key) || ts(it) > ts(latest.get(key))) latest.set(key, it);
      lastSeen.set(key, Math.max(lastSeen.get(key) || 0, ts(it)));
    }
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || rank.get(b[0]) - rank.get(a[0]) || lastSeen.get(b[0]) - lastSeen.get(a[0]) || a[0].localeCompare(b[0]));
  return { counts, forms, latest, ranked };
}

// Frequency of hashtags + words (stopwords and <3-char tokens dropped), each counted at most once per item.
export function topTopics(items, k = 5) {
  const { forms, ranked } = countTopics(items);
  return ranked.slice(0, k).map(([key, count]) => ({ topic: displayForm(forms.get(key)), count }));
}

// Same ranking as topTopics, plus momentum vs. a previous set of items (equal-length earlier window).
export function trendingTopics(nowItems, prevItems, k = 5) {
  const now = countTopics(nowItems), prev = countTopics(prevItems);
  return now.ranked.slice(0, k).map(([key, count]) => {
    const prev_count = prev.counts.get(key) || 0, it = now.latest.get(key);
    return { topic: displayForm(now.forms.get(key)), count, prev_count, change: count - prev_count,
      latest_id: it.id, latest_source_url: it.source_url };
  });
}

// ---------- route-level pure functions (items: all items, newest first; nowMs injectable for tests) ----------
const H = 3600e3;
const inWindow = (items, fromMs, toMs = Infinity) => items.filter((it) => ts(it) >= fromMs && ts(it) < toMs);

// /news/summary/recent
export function recentSummary(items, q, hours, nowMs = Date.now(), max = 50) {
  const terms = parseTerms(q), sinceMs = nowMs - hours * H;
  const hits = inWindow(items, sinceMs).filter((it) => matchesTerms(it.text_en, terms)).slice(0, max);
  return { query: q, hours, since: isoSec(sinceMs), count: hits.length,
    high_count: hits.filter((i) => i.importance === "high").length,
    summary: hits.length ? buildSummary(q, hits) : `No news matched "${q}" in the last ${hours} hours.`,
    items: hits.map(({ id, published_at, importance, source_url }) => ({ id, published_at, importance, source_url })) };
}

// /news/alerts/new
export function alertsNew(items, q, hours, nowMs = Date.now()) {
  const terms = parseTerms(q), sinceMs = nowMs - hours * H;
  const hits = inWindow(items, sinceMs).filter((it) => it.importance === "high" && matchesTerms(it.text_en, terms));
  const l = hits[0];
  return { query: q, hours, since: isoSec(sinceMs), has_new: hits.length > 0, count: hits.length,
    latest: l ? { id: l.id, published_at: l.published_at, text_en: l.text_en, source_url: l.source_url } : null };
}

// /news/topics/trending: high items in [now-h, now) vs. [now-2h, now-h). Empty window -> last 20 high items
// (same fallback as /news/top-topics), compared with the 20 high items before them.
export function trending(items, hours, nowMs = Date.now()) {
  const high = items.filter((it) => it.importance === "high");
  let cur = inWindow(high, nowMs - hours * H), prev = inWindow(high, nowMs - 2 * hours * H, nowMs - hours * H);
  const fallback = cur.length === 0;
  if (fallback) { cur = high.slice(0, 20); prev = high.slice(20, 40); }
  return { hours, items_considered: cur.length, fallback, topics: trendingTopics(cur, prev, 5),
    ...(fallback ? { note: `No high-importance items in the last ${hours}h; used the last ${cur.length} high-importance items, compared with the ${prev.length} before them.` } : {}) };
}

// =====================================================================================================
// News endpoints v3: /news/since, /news/movers, /news/country, /news/data-surprises, /news/sentiment, /news/digest
// (all deterministic regex/lexicon logic over text_en; items = all items, newest first; nowMs injectable)
// =====================================================================================================
const idNum = (it) => Number(it.id);
const brief = ({ id, published_at, importance, source_url, text_en }) => ({ id, published_at, importance, headline: headlineOf(text_en), source_url });

// Non-negative decimal param (e.g. min_pct=2.5): undefined -> def; invalid -> null; clamped to [min, max].
export function parseFloatParam(raw, { def, min, max }) {
  if (raw === undefined) return def;
  if (typeof raw !== "string" || !/^\s*\d+([.,]\d+)?\s*$/.test(raw)) return null;
  return Math.min(Math.max(Number(raw.trim().replace(",", ".")), min), max);
}
// Cursor id for /news/since: non-negative integer string, else null.
export const parseCursorId = (raw) => (typeof raw === "string" && /^\s*\d{1,15}\s*$/.test(raw) ? Number(raw) : null);

// ---------- /news/since ----------
export function newsSince(items, sinceId, limit) {
  const newer = items.filter((it) => idNum(it) > sinceId).sort((a, b) => idNum(a) - idNum(b)); // oldest first
  const page = newer.slice(0, limit);
  return { since_id: sinceId, count: page.length, has_more: newer.length > page.length,
    next_id: page.length ? idNum(page[page.length - 1]) : sinceId, latest_id: items.length ? Math.max(...items.map(idNum)) : null, items: page };
}

// ---------- flags / countries ----------
export const flagOf = (code) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const FLAG_RE = /([\u{1F1E6}-\u{1F1FF}]{2})/gu;
const codeOfFlag = (f) => [...f].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join("");
const COUNTRY_WORDS = {
  US: ["usa", "u.s.", "united states", "american", "washington", "white house", "fed", "fomc", "powell", "trump"],
  RU: ["russia", "russian", "kremlin", "moscow", "putin", "peskov", "bank of russia", "cbr", "moex", "imoex"],
  CN: ["china", "chinese", "beijing", "pboc", "xi jinping"], UA: ["ukraine", "ukrainian", "kyiv", "kiev", "zelensky"],
  IR: ["iran", "iranian", "tehran"], GB: ["uk", "britain", "british", "boe", "bank of england", "bailey"],
  EU: ["eu", "eurozone", "euro area", "ecb", "lagarde", "brussels"], DE: ["germany", "german"], JP: ["japan", "japanese", "boj"],
  IL: ["israel", "israeli", "netanyahu"], IN: ["india", "indian"], KZ: ["kazakhstan"], SA: ["saudi"], TR: ["turkey", "turkish"],
};
export const COUNTRY_ALIASES = { UK: "GB" };
export function normalizeCountryCode(raw) {
  if (typeof raw !== "string" || !/^\s*[A-Za-z]{2}\s*$/.test(raw)) return null;
  const c = raw.trim().toUpperCase();
  return COUNTRY_ALIASES[c] || c;
}
// "#tag" entries match only the hashtag; plain words match with or without a leading '#'.
const wordRe = (w) => w.startsWith("#") ? new RegExp(`${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu") : new RegExp(`(^|[^\\p{L}\\p{N}])#?${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");
const countryRes = Object.fromEntries(Object.entries(COUNTRY_WORDS).map(([c, ws]) => [c, ws.map(wordRe)]));
export function mentionsCountry(text, code) {
  if ((text.match(FLAG_RE) || []).some((f) => codeOfFlag(f) === code)) return "flag";
  return (countryRes[code] || []).some((re) => re.test(text)) ? "keyword" : null;
}
// ---------- /news/country ----------
export function countryNews(items, code, hours, importance = "all", nowMs = Date.now()) {
  const sinceMs = nowMs - hours * H;
  const win = inWindow(items, sinceMs).filter((it) => importance === "all" || it.importance === importance);
  const hits = win.map((it) => ({ it, by: mentionsCountry(it.text_en, code) })).filter((x) => x.by);
  return { code, flag: code === "EU" || /^[A-Z]{2}$/.test(code) ? flagOf(code) : null, hours, importance, since: isoSec(sinceMs),
    count: hits.length, high_count: hits.filter((x) => x.it.importance === "high").length,
    by_flag: hits.filter((x) => x.by === "flag").length, share_of_window: win.length ? Math.round((hits.length / win.length) * 1000) / 10 : 0,
    top_topics: topTopics(hits.map((x) => x.it), 5), latest: hits.slice(0, 10).map((x) => brief(x.it)) };
}

// ---------- /news/movers ----------
// "⬇️🇺🇸#CRWV = -6%", "🇷🇺 #CHMF Severstal = -1%", "🇺🇸#SPCX SpaceX = +8%", "✴️ #DOGE = +3%"
const MOVER_RE = /(?:([⬆⬇])\uFE0F?)?((?:[\u{1F1E6}-\u{1F1FF}]{2})*)[^\S\n]*#([A-Z][A-Z0-9.]{1,9})\b((?:[^\S\n]+[\p{Lu}][\p{L}\p{N}&.'-]*){0,3})[^\S\n]*=[^\S\n]*([+\-−–]?)[^\S\n]*(\d+(?:[.,]\d+)?)[^\S\n]*%(?![^\S\n]*[my]\/[my])/gu;
export function parseMovers(text) {
  const out = [];
  for (const m of text.matchAll(MOVER_RE)) {
    const sign = m[5] === "+" ? 1 : m[5] ? -1 : m[1] === "⬇" ? -1 : 1;
    const pct = sign * Number(m[6].replace(",", "."));
    const flags = m[2] ? m[2].match(FLAG_RE) : null;
    out.push({ ticker: m[3], name: m[4].trim() || null, pct, country: flags ? codeOfFlag(flags[flags.length - 1]) : null });
  }
  return out;
}
export function movers(items, hours, minPct = 0, nowMs = Date.now(), k = 10) {
  const sinceMs = nowMs - hours * H, latest = new Map(); // newest mention per ticker wins
  for (const it of inWindow(items, sinceMs)) for (const mv of parseMovers(it.text_en)) {
    if (!latest.has(mv.ticker)) latest.set(mv.ticker, { ...mv, id: it.id, published_at: it.published_at, importance: it.importance,
      source_url: it.source_url, headline: headlineOf(it.text_en) });
  }
  const all = [...latest.values()].filter((x) => Math.abs(x.pct) >= minPct && x.pct !== 0);
  return { hours, min_pct: minPct, since: isoSec(sinceMs), tickers_found: latest.size,
    gainers: all.filter((x) => x.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, k),
    losers: all.filter((x) => x.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, k) };
}

// ---------- /news/data-surprises ----------
const NUM = "([+\\-−–]?\\s?\\$?\\d+(?:[.,]\\d+)?)";
const UNIT = "((?:%|bln|b|mln|m|k|trln|t|bp)?(?:\\s?[my]\\/[my])?)";
// macro: "<label> = A[unit] (exp[.|ected] E[unit] / prev[.|ious] P[unit])"
const MACRO_RE = new RegExp(`([^=;\\n()]{1,90}?(?:\\([^)\\n]{1,20}\\)[^=;\\n()]{0,40})?)=\\s*${NUM}\\s*${UNIT}\\s*\\(\\s*(?:exp(?:ected)?|est(?:imate)?|forecast|f'?cast)\\.?\\s*${NUM}\\s*${UNIT}\\s*(?:[/;,]\\s*prev(?:ious)?\\.?\\s*${NUM}\\s*${UNIT})?\\s*\\)`, "giu");
// earnings: "3Q ADJ EPS $2.54, EST. $2.61" / "3Q REV. $14.58B, EST. $12.87B"
const EARN_RE = new RegExp(`(?:^|[;:.]\\s|,\\s|\\n|\\s)((?:[1-4]Q|FY|Q[1-4]|H[12])[A-Z0-9 .&'/-]{2,50}?)\\s+${NUM}\\s*${UNIT},\\s*EST\\.?\\s*${NUM}\\s*${UNIT}(?=[;,.\\s]|$)`, "giu");
const toNum = (s) => Number(String(s).replace(/[\s$]/g, "").replace(/[−–]/, "-").replace(",", "."));
const normUnit = (u) => { const x = String(u || "").toLowerCase().replace(/\s+/g, " ").trim();
  return x.replace(/^bln/, "B").replace(/^b\b/, "B").replace(/^mln/, "M").replace(/^m\b(?!\/)/, "M").replace(/^k\b/, "K").replace(/^trln|^t\b/, "T") || null; };
const cleanLabel = (s) => stripEmoji(s).replace(/#[\p{L}\p{N}_]+/gu, " ").replace(/\s+/g, " ").replace(/^[\s\-–—:;,/|.]+|[\s\-–—:;,/|]+$/g, "").trim();
function surpriseOf(actual, expected) {
  const s = Math.round((actual - expected) * 10000) / 10000;
  return { surprise: s, surprise_pct: expected !== 0 ? Math.round((s / Math.abs(expected)) * 1000) / 10 : null,
    direction: s > 0 ? "above" : s < 0 ? "below" : "inline" };
}
export function parseSurprises(text) {
  const out = [];
  for (const line of text.split(/\n+/)) {
    let header = null;
    for (const m of line.matchAll(MACRO_RE)) {
      let label = m[1], ctx = null;
      const colon = label.lastIndexOf(":");
      if (colon >= 0) { ctx = cleanLabel(label.slice(0, colon)); label = label.slice(colon + 1); }
      label = cleanLabel(label);
      if (ctx) header = ctx;
      if (!label && !header) continue;
      const short = !label || /^(?:[my]\/[my]|core\b.*|[a-z\s/]{1,6})$/i.test(label);
      const indicator = short && header && header !== label ? `${header} — ${label || "value"}` : ctx && ctx !== label && label.length < 12 ? `${ctx} — ${label}` : label || header;
      const actual = toNum(m[2]), expected = toNum(m[4]);
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) continue;
      out.push({ kind: "macro", indicator, actual, expected, previous: m[6] !== undefined ? toNum(m[6]) : null,
        unit: normUnit(m[3]) || normUnit(m[5]), ...surpriseOf(actual, expected) });
    }
    for (const m of line.matchAll(EARN_RE)) {
      const actual = toNum(m[2]), expected = toNum(m[4]);
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) continue;
      out.push({ kind: "earnings", indicator: cleanLabel(m[1]), actual, expected, previous: null,
        unit: normUnit(m[3]) || normUnit(m[5]) || (/\$/.test(m[2]) ? "$" : null), ...surpriseOf(actual, expected) });
    }
  }
  return out;
}
export function dataSurprises(items, hours, q = null, nowMs = Date.now(), max = 50) {
  const sinceMs = nowMs - hours * H, terms = q ? parseTerms(q) : null, rows = [];
  for (const it of inWindow(items, sinceMs)) {
    if (terms && !matchesTerms(it.text_en, terms)) continue;
    const company = (/#([A-Z][A-Z0-9.]{1,9})\b/.exec(it.text_en) || [])[1] || null;
    for (const s of parseSurprises(it.text_en)) rows.push({ ...s, ...(s.kind === "earnings" && company ? { ticker: company } : {}),
      id: it.id, published_at: it.published_at, importance: it.importance, source_url: it.source_url });
  }
  return { hours, query: q, since: isoSec(sinceMs), count: Math.min(rows.length, max),
    above: rows.filter((r) => r.direction === "above").length, below: rows.filter((r) => r.direction === "below").length,
    items: rows.slice(0, max) };
}

// ---------- /news/sentiment (heuristic lexicon, NOT a model) ----------
const BULL = ["rise", "rises", "rose", "rising", "gain", "gains", "gained", "jump", "jumps", "jumped", "surge", "surges", "surged", "soar", "soars", "soared",
  "rally", "rallies", "rallied", "climb", "climbs", "climbed", "beat", "beats", "upgrade", "upgraded", "upgrades", "record high", "all-time high", "strong",
  "stronger", "profit", "raised its", "raises", "growth", "grew", "rebound", "rebounds", "recovery", "boost", "boosts", "expand", "expands", "deal", "agreement",
  "ceasefire", "peace", "constructive", "bullish", "outperform", "buy rating", "approval", "approved"];
const BEAR = ["fall", "falls", "fell", "falling", "drop", "drops", "dropped", "plunge", "plunges", "plunged", "slump", "slumps", "slumped", "decline", "declines",
  "declined", "diving", "dive", "dives", "tumble", "tumbles", "tumbled", "sink", "sinks", "sank", "miss", "misses", "missed", "downgrade", "downgraded", "loss",
  "losses", "lowest", "record low", "weak", "weaker", "sanctions", "strike", "strikes", "attack", "attacks", "war", "escalation", "default", "bankruptcy",
  "layoffs", "recession", "bearish", "underperform", "sell rating", "crisis", "threat", "threatens", "tariff", "tariffs", "ban", "halt", "halted"];
const lexRe = (ws) => new RegExp(`(?:^|[^\\p{L}])(${ws.join("|")})(?=$|[^\\p{L}])`, "giu");
const BULL_RE = lexRe(BULL), BEAR_RE = lexRe(BEAR);
export function scoreText(text) {
  const t = text.toLowerCase();
  let bull = (t.match(BULL_RE) || []).length, bear = (t.match(BEAR_RE) || []).length;
  bull += (text.match(/⬆|🟢|📈/gu) || []).length; bear += (text.match(/⬇|🔴|📉/gu) || []).length;
  for (const mv of parseMovers(text)) mv.pct > 0 ? (bull += 2) : mv.pct < 0 ? (bear += 2) : 0; // explicit price moves weigh double
  const score = bull + bear ? Math.round(((bull - bear) / (bull + bear)) * 100) / 100 : 0;
  return { bull, bear, score, label: score > 0.2 ? "bullish" : score < -0.2 ? "bearish" : "neutral" };
}
export function sentiment(items, q, hours, nowMs = Date.now()) {
  const terms = parseTerms(q), sinceMs = nowMs - hours * H;
  const hits = inWindow(items, sinceMs).filter((it) => matchesTerms(it.text_en, terms)).map((it) => ({ it, s: scoreText(it.text_en) }));
  const n = (l) => hits.filter((x) => x.s.label === l).length;
  const bullish = n("bullish"), bearish = n("bearish"), neutral = n("neutral");
  const ex = (l) => hits.filter((x) => x.s.label === l).sort((a, b) => Math.abs(b.s.score) - Math.abs(a.s.score)).slice(0, 3)
    .map((x) => ({ ...brief(x.it), score: x.s.score }));
  return { query: q, hours, since: isoSec(sinceMs), count: hits.length, bullish, bearish, neutral,
    score: hits.length ? Math.round(((bullish - bearish) / hits.length) * 100) / 100 : 0,
    label: !hits.length ? "no_data" : bullish - bearish > hits.length * 0.2 ? "bullish" : bearish - bullish > hits.length * 0.2 ? "bearish" : "neutral",
    method: "heuristic", note: "Heuristic keyword/emoji lexicon plus explicit '= ±X%' moves; not a language model. score = (bullish - bearish) / count.",
    examples: { bullish: ex("bullish"), bearish: ex("bearish") } };
}

// ---------- /news/digest ----------
export const DIGEST_SECTIONS = {
  central_banks: ["central bank", "bank of russia", "key rate", "rate cut", "rate hike", "fed", "fomc", "powell", "ecb", "lagarde", "boe", "bailey", "boj",
    "pboc", "nabiullina", "monetarypolicy", "monetary policy", "interest rate"],
  macro: ["inflation", "cpi", "ppi", "gdp", "pmi", "payrolls", "unemployment", "jobless", "retail sales", "home sales", "economy", "#reports", "#data", "#economy", "#inflation",
    "industrial production", "trade balance", "budget", "consumer confidence"],
  energy: ["oil", "brent", "wti", "crude", "opec", "gas", "lng", "eia", "api inventories", "gasoline", "diesel", "fuel", "pipeline", "refinery"],
  equities: ["earnings", "shares", "stock", "stocks", "ipo", "imoex", "s&p", "nasdaq", "dow", "dividend", "dividends", "eps", "revenue", "buyback"],
  crypto: ["crypto", "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "doge", "stablecoin", "blockchain", "defi", "etf flows"],
  geopolitics: ["ukraine", "iran", "israel", "war", "sanctions", "putin", "zelensky", "witkoff", "kushner", "missile", "strike", "drone", "ceasefire",
    "negotiations", "talks", "geopolitics", "nato", "military", "aircraft carrier", "peskov", "rubio"],
};
const sectionRes = Object.fromEntries(Object.entries(DIGEST_SECTIONS).map(([k, ws]) => [k, ws.map(wordRe)]));
export function sectionsOf(text) {
  return Object.keys(DIGEST_SECTIONS).filter((k) => sectionRes[k].some((re) => re.test(text)) || (k === "equities" && parseMovers(text).length > 0));
}
export function digest(items, hours, nowMs = Date.now(), perSection = 5) {
  const sinceMs = nowMs - hours * H, win = inWindow(items, sinceMs);
  const buckets = Object.fromEntries(Object.keys(DIGEST_SECTIONS).map((k) => [k, []]));
  let unclassified = 0;
  for (const it of win) { const s = sectionsOf(it.text_en); if (!s.length) unclassified++; for (const k of s) buckets[k].push(it); }
  const rank = (a, b) => (a.importance === "high" ? 0 : 1) - (b.importance === "high" ? 0 : 1) || ts(b) - ts(a);
  const sections = Object.fromEntries(Object.entries(buckets).map(([k, list]) => [k, { count: list.length,
    high_count: list.filter((i) => i.importance === "high").length, items: [...list].sort(rank).slice(0, perSection).map(brief) }]));
  return { hours, since: isoSec(sinceMs), count: win.length, high_count: win.filter((i) => i.importance === "high").length,
    sections, unclassified_count: unclassified, top_topics: topTopics(win.filter((i) => i.importance === "high"), 5),
    note: "Items can appear in several sections; each section lists up to 5 (high-importance first, then newest)." };
}
