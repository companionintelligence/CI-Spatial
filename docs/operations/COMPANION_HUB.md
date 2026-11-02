# Companion Hub: how Scan finds its services

A Scan server installed from the Companion App Store, on a Companion Hub, finds
three things without anyone typing a URL or a key: the Companion Account it signs
people in with, the Companion Memory it pushes finished scans to, and the vision
model it asks to find objects. This page says where each one comes from, what the
first-run screen shows about them, and what still has to be true for each to work.

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
default. Companion Memory connects when someone connects it in the Hub, and the Hub
restarts the app then. The form also has advanced fields for an external CI-Server
URL and key. Leave those blank for a Hub install.

## What the first-run screen shows

The onboarding overlay's third step asks the server for its status
(`/authenticate/whoami`, `/memory/status` and `/health`) and draws one row per
service. Nothing is typed in. The rows come from `src/shared/connections.ts`.

| Row | State | Shown as |
| --- | --- | --- |
| Companion Account | signed in | Signed in as *name* |
| | sign-in on, not signed in | Not signed in, with a Sign in link |
| | sign-in off on this server | Sign-in is off here |
| | in the native shell | Sign in on the web |
| Companion Memory | connected | Connected |
| | connected, not answering | Connected, unreachable |
| | not connected | Not connected, with a hint to connect it in the Companion Hub |
| Vision model | ready | *model* ready |
| | loading | Loading *model* |
| | not available | Unavailable |

A check that fails shows "Can't check" on its row. It never holds the overlay up.

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

The session is a cookie on the server's own origin. The native shells run on another
origin and cannot hold that cookie, so sign-in happens in a browser there.

## Companion Memory

Scans push to Companion Memory once the Hub connects it (the `memory-push` job). The
push sends the Hub's minted key as `x-api-key`. It does not yet call CI-Memory's
`ingest/finish` step, so a pushed scan may not be searchable until that is decided.

## Checking a server

```bash
curl -s https://<server>/health              # model, modelReady, engineLoadState
curl -s https://<server>/memory/status       # enabled and reachable; never the key
curl -s -o /dev/null -w '%{http_code}\n' https://<server>/authenticate/whoami
# 404 when sign-in is off, 401 when signed out, 200 with the account when signed in
```

## Not yet

- The native shells cannot keep a Companion Account session (see *Sign-on*).
- The store listing runs the published image. A Hub install of this build waits on
  the owner's approval.
