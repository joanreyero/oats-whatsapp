// Shared helpers for oats.whatsapp: settings, state directory, the bridge's local API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

export function readSettings() {
  let s = {};
  try { s = JSON.parse(process.env.OATS_SETTINGS || "{}"); } catch { s = {}; }
  if (!s || typeof s !== "object") s = {};
  return {
    adapter: s.adapter === "wacli" ? "wacli" : "kapso",
    chats: isObj(s.chats) ? s.chats : {},
    bindings: isObj(s.bindings) ? s.bindings : {},
    chat: typeof s.chat === "string" && s.chat ? s.chat : null,
    port: Number.isInteger(s.port) && s.port > 0 ? s.port : (parseInt(s.port, 10) || 8788),
    stateDir: expandHome(typeof s.stateDir === "string" && s.stateDir ? s.stateDir : "~/.local/state/oats-whatsapp"),
    identityHome: typeof s.identityHome === "string" && s.identityHome ? expandHome(s.identityHome) : null,
    kapso: isObj(s.kapso) ? s.kapso : {},
    wacli: isObj(s.wacli) ? s.wacli : {},
    human: typeof s.human === "string" && s.human.trim() ? s.human.trim() : "the human",
  };
}

export function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

export function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function bindingsDir(settings) { return path.join(settings.stateDir, "bindings"); }

export function bindingFor(settings, instance) {
  // bindings.<instance> (host) wins over the spawn's ad-hoc chat=<label>.
  const label = settings.bindings[instance] ?? settings.chat;
  return typeof label === "string" && label ? label : null;
}

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); }

export function readBindings(settings) {
  const dir = bindingsDir(settings);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (b && typeof b.instance === "string" && typeof b.chat === "string") out.push(b);
    } catch { /* a half-written file: skipped this round */ }
  }
  return out;
}

export function emit(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

export function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout talking to the bridge")));
    if (data) req.write(data);
    req.end();
  });
}

export function arg(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) {
    const pre = argv.find((a) => a.startsWith(name + "="));
    return pre ? pre.slice(name.length + 1) : undefined;
  }
  return argv[i + 1];
}
