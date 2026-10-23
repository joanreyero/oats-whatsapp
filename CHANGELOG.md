# Changelog

## v0.1.1 (2026-10-23)

From the reyero-oats maintainer's review of the first pin (reyero-oats#1):

- wacli adapter: only messages sent from the phone are inbound (`wacli.from: phone`, default); a linked
  device's message, any local `wacli send` included, is ignored by its id shape. The limit is stated in the
  README, the skill and the inject: a shape, not a security boundary.
- kapso adapter exercised against Kapso's documented webhook payloads (signed, unsigned, batched, a stranger)
  with the CLI stubbed; media placeholders read `[image: caption]`.
- `oats whatsapp send` reads stdin only with `--stdin`.
- The manifest no longer declares `retirement.disposable.home` (nothing is written in the home).
- README: the local API's trust model (same user on the host, `--instance` included) and a Status section.

## v0.1.0 (2026-10-23)

First release. Capability `oats.whatsapp` (command `whatsapp`):

- The bridge (`oats whatsapp bridge`): kapso adapter (HMAC-verified webhook in, Kapso CLI out) and wacli
  adapter (read-only poll of the local mirror in, delegated `wacli send` out, own replies deduplicated by id
  and by text); inbound messages debounced for 2 s and mailed as the deployment's root identity to every
  instance bound to the chat; local API on 127.0.0.1 (`GET /status`, `POST /send`).
- Hooks: `launch` registers the instance's binding (preview-aware), `retire` removes it.
- Commands: `oats whatsapp send --text|--body-file`, `oats whatsapp status`.
- Inject and skill `oats-whatsapp`.
- Not yet: media, templates outside Meta's 24-hour window, several WhatsApp accounts per host, a reconcile
  poll for webhooks missed while the host slept.
