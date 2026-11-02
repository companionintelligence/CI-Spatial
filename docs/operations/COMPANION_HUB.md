# Companion Hub: how Scan finds its services

A Scan server installed from the Companion App Store, on a Companion Hub, finds
three things without anyone typing a URL or a key: the Companion Account it signs
people in with, the Companion Memory it pushes finished scans to, and the vision
model it asks to find objects. This page covers where each one comes from and what
must be true for sign-on to work. The first-run rows, their copy and the settings
table are in the README's [First-run setup status and settings](../../README.md#first-run-setup-status-and-settings).

## What the Hub provides

The Scan entry in the Companion App Store is `apps/ci-web-xr-scan/config.json` in
CI-Marketplace. Its `hub_integration` block names the environment variables the Hub
writes into the app when it installs or connects it.

| Service | Marketplace setting | Variable the server reads | Read in |
| --- | --- | --- | --- |
| Companion Account (sign-in) | `oidc.issuer_env: OIDC_ISSUER_URL` | `OIDC_ISSUER_URL`, the paired Portal origin | `server/portal_auth.ts` |
| Public origin | the app is `exposable` | `APP_BASE_URL`, the app's public URL | `server/portal_auth.ts` (the sign-in redirect) |
| Companion Memory | `memory.url_env` and `token_env`: `CI_SERVER_URL`, `CI_SERVER_TOKEN` | the API base and a minted, memory-scoped key | `server/memory_push.ts` |
| Vision model | `inference.ollama_host: OLLAMA_HOST`, `vision_model: OLLAMA_MODEL` | the engine host and the model name | `server/inference.ts` |

Sign-in is a form field, "Sign in with Companion Intelligence", and it is off by
default. Companion Memory connects when someone connects it in the Hub. Leave the
form's advanced Companion Memory fields blank for a Hub install.

## Sign-on

Companion Account sign-in runs the server's authorization-code flow with PKCE. The
Portal redirects only to an address it knows for the `ci-web-xr-scan` client:

- `localhost`, for development;
- the app's own host on the Hub, for an install from the store;
- a tailnet device's own name, for a self-hosted server on a tailnet.

A public domain such as `scan.ci.computer` is refused until it is connected to the
app in the Portal as a custom domain. Until then, sign-in from that domain fails.

Sign-in is fail-closed. `PORTAL_OIDC_ALLOWED_EMAILS` must list the accounts that may
sign in, and an empty list admits nobody.

The session is a cookie on the server's own origin, so a browser keeps it. A native shell
runs on another origin and cannot send that cookie, so it signs in through the system
browser sheet and holds a Bearer token instead. The flow is in
[mobile/README.md](../../mobile/README.md#companion-account-sign-in). It has run on the
iOS simulator against a stand-in Portal. A real Portal account, and Android, are not
verified.

## Companion Memory

Scans push to Companion Memory once the Hub connects it (the `memory-push` job). The
push sends the Hub's minted key as `x-api-key`. It does not yet call CI-Memory's
`ingest/finish` step, so a pushed scan may not be searchable until that is decided.

## Checking a server

```bash
curl -s https://<server>/health              # model, modelReady, engineLoadState
curl -s https://<server>/memory/status       # enabled and reachable; never the key
curl -s https://<server>/authenticate/status # {"enabled": true} or {"enabled": false}
```

## Not yet

- The native shell's sign-in is verified on the iOS simulator only, against a stand-in
  Portal, and not on Android (see *Sign-on*).
- The store listing runs the published image. A Hub install of this build waits on
  the owner's approval.
