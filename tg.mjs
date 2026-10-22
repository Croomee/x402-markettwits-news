// Public Telegram channel reader via the t.me/s/<channel> web preview (no login, no API key).
// Only public channels with the web preview enabled work; a missing/private channel -> 404 (not settled).
import { upstream, cached, NotFoundError, UpstreamError, isoNow } from "./upstream.mjs";

// Telegram usernames: 5-32 chars, letters/digits/underscore, starting with a letter; '@name' and t.me links accepted.
export function normalizeChannel(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?(t|telegram)\.me\//i, "").replace(/^s\//i, "").replace(/^@/, "").replace(/\/+$/, "");
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) && !/__/.test(s) && !s.endsWith("_") ? s.toLowerCase() : null;
}
export function parseChannelList(raw, { max = 5 } = {}) {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > max) return null;
  const list = parts.map(normalizeChannel);
  return list.every(Boolean) ? [...new Set(list)] : null;
}
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
export function htmlToText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|blockquote)>/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function parseViews(raw) {
  if (typeof raw !== "string") return null;
  const m = /^\s*([\d.,]+)\s*([KM])?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Math.round(n * (m[2] ? (m[2].toUpperCase() === "K" ? 1e3 : 1e6) : 1));
}
const between = (s, startRe) => { const m = startRe.exec(s); if (!m) return null; const i = m.index + m[0].length; const j = s.indexOf("</div>", i); return j < 0 ? null : s.slice(i, j); };
export function parseTgPage(html, channel) {
  const title = (/class="tgme_channel_info_header_title"[^>]*>(?:<span[^>]*>)?([^<]+)/.exec(html) || [])[1];
  const subs = (/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">subscribers?<\/span>/.exec(html) || [])[1];
  const prev = (/<link rel="prev" href="[^"]*[?&]before=(\d+)/.exec(html) || [])[1];
  const messages = [];
  for (const part of html.split(/<div class="tgme_widget_message_wrap[^"]*">/).slice(1)) {
    const post = (/data-post="([^"/]+)\/(\d+)"/.exec(part) || []);
    if (!post[2]) continue;
    const textHtml = between(part, /<div class="tgme_widget_message_text js-message_text"[^>]*>/);
    const media = [];
    if (/tgme_widget_message_photo_wrap/.test(part)) media.push("photo");
    if (/tgme_widget_message_video/.test(part)) media.push("video");
    if (/tgme_widget_message_document/.test(part)) media.push("document");
    if (/tgme_widget_message_poll/.test(part)) media.push("poll");
    const fwd = (/tgme_widget_message_forwarded_from_name"[^>]*>(?:<span[^>]*>)?([^<]+)/.exec(part) || [])[1];
    const viewsRaw = (/<span class="tgme_widget_message_views">([^<]+)<\/span>/.exec(part) || [])[1] ?? null;
    messages.push({ id: Number(post[2]), channel: post[1].toLowerCase(), date: (/<time datetime="([^"]+)"/.exec(part) || [])[1] ?? null,
      text: textHtml ? htmlToText(textHtml) : "", views: parseViews(viewsRaw), views_raw: viewsRaw,
      link: `https://t.me/${post[1]}/${post[2]}`, media, edited: /tgme_widget_message_meta">\s*edited/.test(part),
      ...(fwd ? { forwarded_from: decodeEntities(fwd.trim()) } : {}) });
  }
  return { channel, title: title ? decodeEntities(title.trim()) : null, subscribers_raw: subs ?? null, subscribers: parseViews(subs ?? ""),
    has_preview: Boolean(title) || messages.length > 0, before: prev ? Number(prev) : null, messages };
}
async function tgPage(channel, { before = null, q = null } = {}) {
  const qs = new URLSearchParams(); if (before) qs.set("before", String(before)); if (q) qs.set("q", q);
  const url = `https://t.me/s/${channel}${qs.size ? "?" + qs : ""}`;
  return cached(`tg:${url}`, 120e3, async () => {
    const r = await upstream(url, { label: "t.me", manual: true, timeoutMs: 8000 });
    if (r.status >= 300) throw new NotFoundError(`channel @${channel} not found or has no public web preview`);
    const page = parseTgPage(r.buf.toString("utf8"), channel);
    if (!page.has_preview) {
      if (/tgme_page|tgme_channel_info/.test(r.buf.toString("utf8"))) throw new NotFoundError(`channel @${channel} not found or has no public web preview`);
      throw new UpstreamError("t.me: unexpected page (no messages, no channel header)", r.attempts);
    }
    return { ...page, via: r.via };
  }, { staleMs: 30 * 60e3 });
}
export async function channelLatest(channel, { limit = 20 } = {}) {
  const first = await tgPage(channel);
  const byId = new Map(first.value.messages.map((m) => [m.id, m]));
  let before = first.value.messages.length ? Math.min(...first.value.messages.map((m) => m.id)) : null, pages = 1;
  while (byId.size < limit && before && before > 1 && pages < 4) {
    let p; try { p = await tgPage(channel, { before }); } catch { break; }
    pages++;
    if (!p.value.messages.length) break;
    for (const m of p.value.messages) byId.set(m.id, m);
    const nb = Math.min(...p.value.messages.map((m) => m.id)); if (nb >= before) break; before = nb;
  }
  const items = [...byId.values()].sort((a, b) => b.id - a.id).slice(0, limit);
  return { channel, title: first.value.title, subscribers: first.value.subscribers, subscribers_raw: first.value.subscribers_raw,
    count: items.length, items, source: `https://t.me/s/${channel} (public web preview)`, pages, cached: first.cached, fetched_at: isoNow() };
}
export async function channelSearch(q, channels, { limit = 20 } = {}) {
  const per = await Promise.all(channels.map(async (ch) => {
    try { const p = await tgPage(ch, { q }); return { channel: ch, title: p.value.title, count: p.value.messages.length, messages: p.value.messages }; }
    catch (e) { return { channel: ch, error: e instanceof NotFoundError ? "not_found" : "upstream_unavailable", detail: e.detail || e.message, messages: [] }; }
  }));
  if (per.every((p) => p.error)) {
    if (per.every((p) => p.error === "not_found")) throw new NotFoundError(`none of the channels exist or have a public web preview: ${channels.join(", ")}`);
    throw new UpstreamError("t.me search unavailable", per.map((p) => `${p.channel}: ${p.detail}`));
  }
  const items = per.flatMap((p) => p.messages).sort((a, b) => (String(b.date) > String(a.date) ? 1 : String(b.date) < String(a.date) ? -1 : b.id - a.id)).slice(0, limit);
  return { query: q, channels, count: items.length, items,
    per_channel: per.map(({ channel, title, count, error, detail }) => ({ channel, title: title ?? null, count: count ?? 0, ...(error ? { error, detail } : {}) })),
    note: "Telegram's own channel search (t.me/s/<channel>?q=): up to 20 newest matches per channel, merged newest first.",
    source: "https://t.me/s/<channel>?q= (public web preview)", fetched_at: isoNow() };
}
