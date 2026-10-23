#!/usr/bin/env node
// oats.whatsapp: hooks (launch, retire) and commands (send, status, bridge).
//
// Hooks run in an instance's lifecycle with OATS_* in the environment; their last stdout line may be JSON
// ({ meta, warning }). Commands are dispatched as `oats whatsapp <command>` from an instance home or, with
// --dir <deployment> --soul <soul>, from the deployment. OATS_SETTINGS carries the merged provider payload.
import fs from "node:fs";
import path from "node:path";
import { readSettings, bindingFor, bindingsDir, ensureDir, emit, request, arg } from "../lib/common.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const settings = readSettings();

async function main() {
  switch (cmd) {
    case "launch": return launch();
    case "retire": return retire();
    case "send": return send(rest);
    case "status": return status(rest);
    case "bridge": {
      const { runBridge } = await import("./bridge.mjs");
      return runBridge(settings);
    }
    default:
      process.stderr.write(`oats.whatsapp: unknown command "${cmd ?? ""}" (send | status | bridge)\n`);
      process.exit(2);
  }
}

// launch: register this instance's binding with the bridge (idempotent; a preview changes nothing).
function launch() {
  const instance = process.env.OATS_INSTANCE;
  const home = process.env.OATS_INSTANCE_HOME || process.env.OATS_HOME;
  const chat = instance ? bindingFor(settings, instance) : null;
  const preview = process.env.OATS_LAUNCH_PREVIEW === "1";
  if (!instance || !chat) {
    emit({ meta: { bound: false, adapter: settings.adapter, reason: instance ? "no binding for this instance (settings.oats.whatsapp.bindings or --provider oats.whatsapp chat=<label>)" : "no OATS_INSTANCE" } });
    return;
  }
  if (!settings.chats[chat]) {
    emit({ meta: { bound: false, adapter: settings.adapter, chat, reason: `chat label "${chat}" has no id in settings.oats.whatsapp.chats on this host` },
      warning: `oats.whatsapp: bound to chat "${chat}" but settings.oats.whatsapp.chats.${chat} is not set on this host: no WhatsApp message will reach ${instance}` });
    return;
  }
  const file = path.join(bindingsDir(settings), `${instance}.json`);
  if (!preview) {
    ensureDir(bindingsDir(settings));
    const record = { instance, alias: instance, chat, home, since: new Date().toISOString() };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  emit({ meta: { bound: true, adapter: settings.adapter, chat, bindingFile: file } });
}

function retire() {
  const instance = process.env.OATS_INSTANCE;
  if (!instance) return emit({ meta: { bound: false } });
  const file = path.join(bindingsDir(settings), `${instance}.json`);
  try { fs.unlinkSync(file); } catch { /* never registered */ }
  emit({ meta: { bound: false, removed: file } });
}

async function send(argv) {
  const instance = arg(argv, "--instance") || process.env.OATS_INSTANCE;
  let text = arg(argv, "--text");
  const bodyFile = arg(argv, "--body-file");
  if (bodyFile) text = fs.readFileSync(bodyFile, "utf8");
  if (text === undefined && !process.stdin.isTTY) text = fs.readFileSync(0, "utf8");
  text = (text ?? "").replace(/\s+$/, "");
  if (!instance) fail("E_BAD_ARGS", "no instance: run from an instance home or pass --instance <name>");
  if (!text) fail("E_BAD_ARGS", "nothing to send: --text <text>, --body-file <file> or stdin");
  let res;
  try { res = await request(settings.port, "POST", "/send", { instance, text }); }
  catch (e) { fail("E_BRIDGE_DOWN", `the WhatsApp bridge is not listening on 127.0.0.1:${settings.port} (${e.message}); on the host: systemctl --user status oats-whatsapp-bridge`); }
  if (res.status !== 200) fail(res.json?.code || "E_SEND", res.json?.message || res.text || `bridge answered ${res.status}`);
  if (argv.includes("--json")) emit(res.json);
  else process.stdout.write(`sent to chat ${res.json.chat} via ${res.json.adapter}${res.json.id ? ` (id ${res.json.id})` : ""}\n`);
}

async function status(argv) {
  let res;
  try { res = await request(settings.port, "GET", "/status"); }
  catch (e) {
    const out = { bridge: "down", port: settings.port, error: e.message, adapter: settings.adapter };
    if (argv.includes("--json")) return emit(out);
    process.stdout.write(`bridge: down (127.0.0.1:${settings.port}: ${e.message})\n`);
    process.exit(1);
  }
  const s = res.json || {};
  if (argv.includes("--json")) return emit(s);
  process.stdout.write(`bridge: ${s.state} · adapter ${s.adapter} · since ${s.since} · identity ${s.identity}\n`);
  for (const b of s.bindings || []) {
    process.stdout.write(`  ${b.instance} ⇄ chat ${b.chat} (${b.chatId || "no id on this host"})${b.lastInboundAt ? ` · last inbound ${b.lastInboundAt}` : ""}${b.lastOutboundAt ? ` · last reply ${b.lastOutboundAt}` : ""}\n`);
  }
  for (const p of s.problems || []) process.stdout.write(`  ! ${p}\n`);
  if (!(s.bindings || []).length) process.stdout.write("  (no instance bound)\n");
}

function fail(code, message) {
  if (process.argv.includes("--json")) emit({ error: { code, message } });
  else process.stderr.write(`${code}: ${message}\n`);
  process.exit(1);
}

main().catch((e) => { process.stderr.write(`oats.whatsapp ${cmd}: ${e?.stack || e}\n`); process.exit(1); });
