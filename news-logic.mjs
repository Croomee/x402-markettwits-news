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
