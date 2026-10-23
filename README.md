# oats-whatsapp

`oats.whatsapp` is an [OATS](https://github.com/awebai/oats) capability package: a
**WhatsApp chat between a human and a resident OATS instance**. The human writes
to the instance from the phone as if it were a contact; the instance is woken
with the message and answers in the same chat.

```
WhatsApp ──(kapso webhook | wacli local DB)──▶ bridge daemon ──▶ aw mail (root identity) ──▶ instance alias
   ▲                                               ▲                                               │
   └──── kapso CLI | wacli send ◀── /send ◀────────┘◀──── oats whatsapp send --text "…" ◀──────────┘
```

It adds **no second wake path**: the bridge turns an inbound message into
[aweb](https://aweb.ai) mail to the instance's alias, sent as the deployment's
root identity (`<deployment>/.aw`, no team seat), and the instance's existing
messaging delivery (the pi aweb extension, the Claude channel plugin, the host
wake broker) wakes it. Replies go back through the bridge's local API.

| Part | What | Where it runs |
|---|---|---|
| `oats whatsapp bridge` | the daemon: one adapter in, routing by binding, aweb mail out, local HTTP API for replies | on the host, `oats whatsapp bridge --dir <deployment> --soul <soul>`, kept running by the host (systemd user unit, launchd) |
| `launch` / `retire` hooks | register and remove the instance's binding (`<stateDir>/bindings/<instance>.json`) | in every instance whose soul has the capability |
| `oats whatsapp send`, `oats whatsapp status` | reply into the bound chat; see the bridge's state | from an instance home, or from the deployment with `--soul` |
| inject + skill `oats-whatsapp` | how a `[whatsapp] <name>: …` mail is recognised, how to answer, the errors | composed into the instance |

## Adapters

- **kapso** (default): the agent gets **its own number** through
  [Kapso](https://kapso.ai), a Meta Business Partner on the official WhatsApp
  Cloud API (free plan, a pre-verified number on signup, CLI, HMAC-signed
  webhooks). Inbound: Kapso POSTs `whatsapp.message.received` to the bridge's
  listener (`127.0.0.1:<webhookPort>/kapso`), which must be reachable from the
  internet (Tailscale Funnel, a tunnel, a relay). Outbound: the `kapso` CLI.
  Meta's 24-hour rule: free replies within 24 h of the human's last message
  (1,000 service messages a month free, then cents); outside it a template is
  needed, which the bridge does not send yet (`E_WINDOW_CLOSED`).
- **wacli**: the **human's own account**, through
  [wacli](https://github.com/openclaw/wacli)'s local mirror (a linked device,
  `wacli sync --follow` running). The chat is a group the human is alone in; the
  bridge polls the mirror read-only every 3 s and sends with `wacli send`.
  Both sides of that chat are the same account, so **only messages sent from
  the phone count as inbound** (`wacli.from: phone`, the default): a message
  from a linked device, WhatsApp Web or any `wacli send` on the host included,
  is ignored, told apart by WhatsApp's message-id shape (a phone's ids are 20
  or 32 characters; a linked device's are `3EB0` + 18 hex). That is a shape,
  not a signature: it stops another local process's `wacli send` from reading
  as the human by accident, not a process that forges ids, which the host
  already trusts. `wacli.from: any` turns it off (the bridge still skips its
  own replies by id and by text). Unofficial client, personal account: a
  stop-gap for low volume.

## Use it

Pin the package and give a soul the capability:

```yaml
# oats-workspace.yaml
packages:
  oats.whatsapp: git:github.com/joanreyero/oats-whatsapp@v0.1.1   # bare `v0.1.1` once listed in the official catalog
# souls/<name>/soul.yaml
capabilities:
  oats.whatsapp: { from: package }
```

Say on each host which chat wakes which instance (`oats-local.yaml`; these are
host facts and `hostOnly`, a committed file cannot set them):

```yaml
settings:
  oats.whatsapp:
    adapter: kapso                  # or wacli
    human: Joan                     # how the mail names the person: "[whatsapp] Joan: …"
    chats:
      joan: "+34600000000"          # kapso: the human's phone (E.164); wacli: the group's JID …@g.us
    bindings:
      acme-desk: joan               # instance name → chat label
    port: 8788                      # the bridge's local API
    kapso:
      phoneNumberId: "1234567890"   # kapso whatsapp numbers list --output json → id
      webhookPort: 8787
```

Run the bridge on the host, with the secrets in its environment only:

```sh
KAPSO_API_KEY=… OATS_WHATSAPP_KAPSO_WEBHOOK_SECRET=… \
  oats whatsapp bridge --dir ~/deployment --soul acme-desk-soul
oats whatsapp status --dir ~/deployment --soul acme-desk-soul    # running, bindings, problems
```

Then `oats sync`, start (or restart) the bound instance so its launch hook
registers the binding, and write to the number. An ad-hoc binding for one
spawn: `oats spawn <soul> --provider oats.whatsapp chat=joan`.

The full operator procedure (Kapso signup, the webhook, Funnel, the wacli
group, the checks, the errors) is the skill:
[`oats-package/capabilities/oats-whatsapp/skills/oats-whatsapp/SKILL.md`](oats-package/capabilities/oats-whatsapp/skills/oats-whatsapp/SKILL.md).

## Settings

| key | default | |
|---|---|---|
| `adapter` | `kapso` | `kapso` or `wacli` |
| `human` | `the human` | the name in the mail subject and body |
| `chats` (hostOnly) | `{}` | label → chat id for the adapter |
| `bindings` (hostOnly) | `{}` | instance → label |
| `chat` | – | ad-hoc binding at spawn (`--provider oats.whatsapp chat=<label>`) |
| `port` | `8788` | the bridge's local API |
| `stateDir` | `~/.local/state/oats-whatsapp` | bindings, cursors, sent ids, `bridge.log` |
| `identityHome` (hostOnly) | `<deployment>/.aw` | the identity the bridge mails as |
| `kapso` (hostOnly) | `{}` | `phoneNumberId`, `webhookPort` (8787), `webhookPath` (`/kapso`) |
| `wacli` (hostOnly) | `{ from: phone }` | `from: phone` (only the phone's messages are inbound) or `any` |

Environment of the bridge process (never files): `KAPSO_API_KEY`,
`OATS_WHATSAPP_KAPSO_WEBHOOK_SECRET`. Host commands: `aw` (declared in the
manifest), plus `kapso` or `wacli` for the adapter in use.

## Security model

- Inbound text is untrusted content: it goes into a mail subject (one clean
  line, 60 chars) and body, and reaches the instance as data; the skill says so.
- Kapso webhooks are HMAC-SHA256 verified; with no secret every webhook is
  refused. Only senders listed in `chats` are routed.
- The bridge's local API trusts the same user on the host (as the OATS wake
  broker does): any local process can `POST /send` naming a bound instance
  (`oats whatsapp send --instance <name>` does exactly that), and the bridge
  only ever sends to the chat that instance is bound to. There is no
  per-instance credential; a host that needs one is out of scope.
- Under `adapter: wacli` the human's identity is the phone (above): what the
  instance reads as "WhatsApp from <name>" is a message the phone sent into a
  group the human is alone in, or a forged id by a local process. A decision
  that must not rest on that (a merge, a payment) deserves the kapso adapter,
  where the sender is the human's own number as Meta delivers it.
- No credential is written anywhere; the instance never holds one.

## Status

v0.1.1. The wacli adapter is exercised end to end on a live account (a phone
message into the group, the mail, the reply, dedupe, restart). The kapso adapter
is exercised against Kapso's documented webhook payloads (single, batched,
signed, unsigned, a stranger's number) with the Kapso CLI stubbed; it has not
yet run against a live Kapso account. Media arrive as `[image: caption]`-style
placeholders; nothing is sent back but text.

## Trust and maintainership

- Repository: https://github.com/joanreyero/oats-whatsapp · issues there.
  Maintainer: Joan Reyero (`joan@reyero.io`); security reports by email.
- License: MIT (this package; it bundles no third-party code).
- Releases are immutable tags `vX.Y.Z`; the payload root is `oats-package/`.
  Catalog entry for `package-catalog.json`:
  `"oats.whatsapp": { "url": "https://github.com/joanreyero/oats-whatsapp.git", "ref": "v0.1.1", "path": "oats-package" }`.
- External services: Kapso (Meta WhatsApp Cloud API) when `adapter: kapso`;
  WhatsApp through a linked device when `adapter: wacli`. Operator setup
  (accounts, numbers, a public webhook URL, secrets in a secret store) is
  documented in the skill; nothing installs or changes a host on its own.
