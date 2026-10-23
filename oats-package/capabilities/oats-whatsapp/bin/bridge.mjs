// oats.whatsapp bridge: one adapter in (wacli poll | kapso webhook), routing by binding, aweb mail out
// (as the deployment's root identity), and a local HTTP API (127.0.0.1:<port>) for replies and status.
//
// Runs on the host as `oats whatsapp bridge --dir <deployment> --soul <soul>` (dotfiles installs the unit).
// No dependencies beyond node and the `aw`, `wacli` or `kapso` CLIs on PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readBindings, ensureDir } from "../lib/common.mjs";

const DEBOUNCE_MS = 2000;
const WACLI_POLL_MS = 3000;
const SENT_KEEP = 500;

export async function runBridge(settings) {
  const state = {
    state: "starting",
    adapter: settings.adapter,
    since: new Date().toISOString(),
    identity: settings.identityHome || path.join(process.env.OATS_TEAM_SCOPE || process.env.OATS_WORKSPACE || process.cwd(), ".aw"),
    problems: [],
    perChat: {},          // label → { lastInboundAt, lastOutboundAt, inbound, outbound }
    pending: new Map(),   // label → { timer, items: [] }
  };
  ensureDir(settings.stateDir);
  const log = makeLog(path.join(settings.stateDir, "bridge.log"));
  const sent = loadSent(settings);
  if (!fs.existsSync(path.join(state.identity, "signing.key"))) {
    state.problems.push(`aweb identity ${state.identity} not found: inbound messages cannot be mailed (set settings.oats.whatsapp.identityHome)`);
  }

  const chatId = (label) => settings.chats[label];
  const labelOf = (id) => Object.keys(settings.chats).find((l) => sameChat(settings.chats[l], id));

  // ── inbound: adapter → debounce → mail to every instance bound to the chat ──
  function inbound(label, msg) {
    if (!label) return;
    const pc = (state.perChat[label] ??= { inbound: 0, outbound: 0 });
    pc.inbound++; pc.lastInboundAt = msg.at;
    let p = state.pending.get(label);
    if (!p) { p = { items: [], timer: null }; state.pending.set(label, p); }
    p.items.push(msg);
    clearTimeout(p.timer);
    p.timer = setTimeout(() => { state.pending.delete(label); flush(label, p.items).catch((e) => log("error", `flush ${label}: ${e.message}`)); }, DEBOUNCE_MS);
  }

  async function flush(label, items) {
    const targets = readBindings(settings).filter((b) => b.chat === label);
    if (!targets.length) {
      note(`WhatsApp message on chat "${label}" but no instance is bound to it (settings.oats.whatsapp.bindings)`);
      log("warn", `chat ${label}: ${items.length} message(s), nobody bound`);
      return;
    }
    const first = items[0];
    const lines = items.map((m) => m.text);
    const head = lines.join(" ").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").slice(0, 60);   // a subject is one clean line
    const subject = `[whatsapp] ${settings.human}: ${head}${lines.join(" ").length > 60 ? "…" : ""}`;
    const body = [
      `WhatsApp from ${settings.human} · chat ${label} · via ${settings.adapter} · ${first.at} · id ${items.map((m) => m.id).join(", ")}`,
      ...lines,
      "--",
      `Reply: oats whatsapp send --text "…" (or --body-file <f>), from your home. Phone-sized: a few lines, full URLs, no tables.`,
    ].join("\n") + "\n";
    for (const t of targets) {
      try {
        await mail(state.identity, t.alias, subject, body);
        log("info", `chat ${label} → ${t.alias}: ${items.length} message(s) mailed`);
      } catch (e) {
        note(`mail to ${t.alias} failed: ${e.message}`);
        log("error", `chat ${label} → ${t.alias}: ${e.message}`);
      }
    }
  }

  // ── outbound: an instance's reply → the chat it is bound to ──
  async function outbound(instance, text) {
    const b = readBindings(settings).find((x) => x.instance === instance);
    if (!b) throw httpError(403, "E_NOT_BOUND", `${instance} is not bound to a WhatsApp chat on this host`);
    const id = chatId(b.chat);
    if (!id) throw httpError(500, "E_CHAT_UNKNOWN", `chat label "${b.chat}" has no id in settings.oats.whatsapp.chats`);
    // Remember the text before the send: under wacli the delegated send can land in the mirror, and be polled,
    // before `wacli send` returns its id; the id is remembered too once known.
    sent.texts.push({ text: text.trim(), at: Date.now() }); sent.texts = sent.texts.filter((o) => Date.now() - o.at < 120_000);
    const r = settings.adapter === "kapso" ? await kapsoSend(settings, id, text) : await wacliSend(id, text);
    if (r.id) rememberSent(settings, sent, r.id);
    const pc = (state.perChat[b.chat] ??= { inbound: 0, outbound: 0 });
    pc.outbound++; pc.lastOutboundAt = new Date().toISOString();
    log("info", `${instance} → chat ${b.chat}: sent${r.id ? ` (${r.id})` : ""}`);
    return { chat: b.chat, adapter: settings.adapter, id: r.id ?? null };
  }

  function note(p) { if (!state.problems.includes(p)) { state.problems.push(p); if (state.problems.length > 20) state.problems.shift(); } }

  // ── the local API ──
  const api = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/status") return json(res, 200, statusDoc());
      if (req.method === "POST" && req.url === "/send") {
        const body = await readJson(req);
        if (!body || typeof body.instance !== "string" || typeof body.text !== "string" || !body.text.trim()) throw httpError(400, "E_BAD_ARGS", "expected { instance, text }");
        return json(res, 200, await outbound(body.instance, body.text));
      }
      json(res, 404, { error: { code: "E_NOT_FOUND", message: "GET /status or POST /send" } });
    } catch (e) {
      json(res, e.status || 500, { error: { code: e.code || "E_BRIDGE", message: e.message } });
    }
  });
  await listen(api, settings.port, "127.0.0.1");
  log("info", `local API on 127.0.0.1:${settings.port}; adapter ${settings.adapter}; identity ${state.identity}`);

  // ── the adapter ──
  let stopAdapter;
  if (settings.adapter === "kapso") stopAdapter = await kapsoListen(settings, labelOf, inbound, note, log);
  else stopAdapter = wacliPoll(settings, sent, inbound, note, log);
  state.state = "running";

  function statusDoc() {
    return {
      state: state.state, adapter: state.adapter, since: state.since, identity: state.identity, port: settings.port,
      bindings: readBindings(settings).map((b) => ({ instance: b.instance, alias: b.alias, chat: b.chat, chatId: chatId(b.chat) ?? null, since: b.since, ...(state.perChat[b.chat] || {}) })),
      chats: Object.fromEntries(Object.keys(settings.chats).map((l) => [l, { id: settings.chats[l], ...(state.perChat[l] || {}) }])),
      problems: state.problems,
    };
  }

  const stop = () => { state.state = "stopping"; try { stopAdapter?.(); } catch {} api.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  await new Promise(() => {});
}

// ── wacli adapter: poll the local mirror for the human's messages in the bound chats ──
// Per chat the bridge keeps a cursor (the newest timestamp seen) and the ids seen around it, on disk, so a restart
// neither re-mails the last message (--after is inclusive at second granularity) nor skips one.
function wacliPoll(settings, sent, inbound, note, log) {
  const file = path.join(settings.stateDir, "wacli-cursors.json");
  const phoneOnly = settings.wacli.from !== "any";
  const cursors = loadJson(file) || {};
  for (const c of Object.values(cursors)) if (!Array.isArray(c.seen)) c.seen = [];
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      for (const [label, jid] of Object.entries(settings.chats)) {
        if (typeof jid !== "string" || !jid) continue;
        const c = (cursors[label] ??= { after: new Date().toISOString(), seen: [] });   // a fresh cursor starts now: nothing older is replayed
        const r = await run("wacli", ["--read-only", "--json", "--timeout", "20s", "messages", "list", "--chat", jid, "--after", c.after, "--asc", "--limit", "50"]);
        if (r.code !== 0) { note(`wacli messages list failed: ${r.stderr.trim().split("\n").pop()}`); continue; }
        const msgs = parseJson(r.stdout)?.data?.messages || [];
        let changed = false;
        for (const m of msgs) {
          const id = m.MsgID; if (!id || c.seen.includes(id)) continue;
          c.seen.push(id); if (c.seen.length > 200) c.seen.shift();
          if (m.Timestamp && m.Timestamp > c.after) c.after = m.Timestamp;
          changed = true;
          if (sent.has(id)) continue;                                   // our own reply, by id
          if (m.ReactionEmoji) continue;                                 // reactions are not messages
          const text = (m.Text || m.DisplayText || "").trim() || (m.MediaType ? `[${m.MediaType}${m.MediaCaption ? `: ${m.MediaCaption}` : ""}]` : "");
          if (!text) continue;
          if (m.FromMe && sent.texts.some((o) => o.text === text && Date.now() - o.at < 120_000)) continue;   // our own reply, by text (both sides are the human's account)
          if (phoneOnly && m.FromMe && !fromPhone(id)) { log("info", `chat ${label}: ${id} sent from a linked device, not the phone; ignored (settings.oats.whatsapp.wacli.from)`); continue; }
          inbound(label, { id, at: m.Timestamp, text, from: m.FromMe ? "me" : (m.SenderJID || "") });
        }
        if (changed) saveJson(file, cursors);
      }
    } catch (e) { note(`wacli poll: ${e.message}`); log("error", `wacli poll: ${e.message}`); }
    finally { busy = false; }
  };
  const t = setInterval(tick, WACLI_POLL_MS); tick();
  log("info", `wacli: polling ${Object.keys(settings.chats).length} chat(s) every ${WACLI_POLL_MS / 1000}s; inbound = ${phoneOnly ? "messages sent from the phone only" : "every message not sent by the bridge"}`);
  return () => clearInterval(t);
}

// WhatsApp message ids tell the sending device apart: a phone (iOS, Android) generates 20- or 32-character ids; a linked
// device (WhatsApp Web, whatsmeow, so every `wacli send` on the host) generates "3EB0" + 18 hex characters (22). A shape, not a
// signature: it keeps another local process's `wacli send` (another agent, a script) from reading as the human; it is not a
// security boundary against a process that forges ids, which the host already trusts.
function fromPhone(id) { return !(typeof id === "string" && id.length === 22 && id.startsWith("3EB0")); }

async function wacliSend(jid, text) {
  const r = await run("wacli", ["--json", "--timeout", "60s", "send", "text", "--to", jid, "--allow-self", "--no-preview", `--message=${text}`]);
  if (r.code !== 0) throw httpError(502, "E_WACLI_SEND", (r.stderr || r.stdout).trim().split("\n").pop() || `wacli exited ${r.code}`);
  const d = parseJson(r.stdout)?.data || {};
  return { id: d.MsgID || d.msg_id || d.id || d.message_id || null };
}

// ── kapso adapter: Kapso's webhook (behind Tailscale Funnel) in, the Kapso CLI out ──
async function kapsoListen(settings, labelOf, inbound, note, log) {
  const port = Number(settings.kapso.webhookPort) || 8787;
  const wpath = typeof settings.kapso.webhookPath === "string" ? settings.kapso.webhookPath : "/kapso";
  const secret = process.env.OATS_WHATSAPP_KAPSO_WEBHOOK_SECRET || "";
  if (!secret) note("OATS_WHATSAPP_KAPSO_WEBHOOK_SECRET is not set: Kapso webhooks are refused (unsigned)");
  if (!process.env.KAPSO_API_KEY) note("KAPSO_API_KEY is not set: replies cannot be sent");
  if (!settings.kapso.phoneNumberId) note("settings.oats.whatsapp.kapso.phoneNumberId is not set: replies cannot be sent");
  const srv = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url.split("?")[0] !== wpath) { res.writeHead(404); return res.end(); }
    const raw = await readRaw(req);
    const sig = req.headers["x-webhook-signature"];
    if (!secret || !verifyHmac(raw, sig, secret)) { log("warn", "kapso: webhook with a bad or missing signature refused"); res.writeHead(401); return res.end(); }
    res.writeHead(200); res.end();
    const ev = parseJson(raw.toString("utf8"));
    // Kapso names the event in the X-Webhook-Event header; the body carries no top-level `type` (payload v1 and v2 alike,
    // checked on the wire 2026-10-23; the delivery log's request_body shows one, the request doesn't).
    const type = ev?.type || req.headers["x-webhook-event"];
    if (!ev || type !== "whatsapp.message.received") { log("warn", `kapso: webhook ignored (event ${type || "unknown"})`); return; }
    const entries = ev.batch ? (Array.isArray(ev.data) ? ev.data : []) : [ev.data || ev];
    for (const d of entries) {
      const m = d?.message || {};
      const k = m.kapso || {};
      if (k.direction && k.direction !== "inbound") continue;
      const from = m.from || d?.conversation?.phone_number || k.phone_number;
      const label = labelOf(from);
      if (!label) { log("warn", `kapso: message from ${from} matches no chat in settings.oats.whatsapp.chats; ignored`); continue; }
      const text = m.type === "text" ? (m.text?.body || "") : (m.type ? `[${m.type}${m[m.type]?.caption ? `: ${m[m.type].caption}` : ""}]` : "");
      if (!text) continue;
      const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
      inbound(label, { id: m.id, at, text, from });
    }
  });
  await listen(srv, port, "127.0.0.1");
  log("info", `kapso: webhook on 127.0.0.1:${port}${wpath} (publish it with tailscale funnel)`);
  return () => srv.close();
}

async function kapsoSend(settings, phone, text) {
  if (!process.env.KAPSO_API_KEY) throw httpError(500, "E_NO_KEY", "KAPSO_API_KEY is not in the bridge's environment");
  const r = await run("kapso", ["whatsapp", "messages", "send", "--phone-number-id", String(settings.kapso.phoneNumberId), "--to", phone, `--text=${text}`, "--output", "json"]);
  if (r.code !== 0) {
    const last = (r.stderr || r.stdout).trim().split("\n").pop() || `kapso exited ${r.code}`;
    if (/24|window|re-?engagement|131047/i.test(last)) throw httpError(409, "E_WINDOW_CLOSED", `Meta's 24-hour window since the human's last message is closed; a template is needed (${last})`);
    throw httpError(502, "E_KAPSO_SEND", last);
  }
  const d = parseJson(r.stdout) || {};
  return { id: d.messages?.[0]?.id || d.id || d.data?.id || null };
}

// ── aweb mail as the root identity ──
async function mail(identityHome, to, subject, body) {
  const f = path.join(os.tmpdir(), `oats-whatsapp-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(f, body, { mode: 0o600 });
  try {
    // cwd at the identity's parent (the deployment): aw keeps its interaction log beside the identity, never in a work tree.
    const r = await run("aw", ["--identity-home", identityHome, "mail", "send", "--to", to, "--subject", subject, "--body-file", f], { cwd: path.dirname(identityHome) });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `aw exited ${r.code}`);
  } finally { try { fs.unlinkSync(f); } catch {} }
}

// ── helpers ──
function sameChat(a, b) { if (!a || !b) return false; const n = (s) => String(s).replace(/[^0-9a-z@.]/gi, "").toLowerCase(); return n(a) === n(b) || n(a).split("@")[0] === n(b).split("@")[0]; }
function verifyHmac(raw, sig, secret) {
  if (typeof sig !== "string") return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig.replace(/^sha256=/, ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function loadSent(settings) { const arr = loadJson(path.join(settings.stateDir, "sent.json")); const set = new Set(Array.isArray(arr) ? arr : []); set.texts = []; return set; }
function rememberSent(settings, sent, id) { sent.add(id); while (sent.size > SENT_KEEP) sent.delete(sent.values().next().value); saveJson(path.join(settings.stateDir, "sent.json"), [...sent]); }
function loadJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } }
function saveJson(f, v) { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); fs.renameSync(tmp, f); }
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }
function httpError(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
function json(res, status, obj) { const b = JSON.stringify(obj); res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b) }); res.end(b); }
function readRaw(req) { return new Promise((resolve, reject) => { const c = []; let n = 0; req.on("data", (d) => { n += d.length; if (n > 1_000_000) { req.destroy(); reject(new Error("body too large")); } c.push(d); }); req.on("end", () => resolve(Buffer.concat(c))); req.on("error", reject); }); }
async function readJson(req) { return parseJson((await readRaw(req)).toString("utf8")); }
function listen(srv, port, host) { return new Promise((resolve, reject) => { srv.once("error", reject); srv.listen(port, host, () => { srv.off("error", reject); resolve(); }); }); }
function run(cmd, args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env || process.env, cwd: cwd || os.homedir() });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => resolve({ code: 127, stdout: out, stderr: `${cmd}: ${e.message}` }));
    p.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}
function makeLog(file) {
  return (level, msg) => {
    const line = `${new Date().toISOString()} ${level} ${msg}\n`;
    try { fs.appendFileSync(file, line, { mode: 0o600 }); } catch {}
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
  };
}
