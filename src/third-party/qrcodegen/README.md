# qrcodegen — vendored third-party source

`qrcodegen.ts` is Project Nayuki's QR Code generator library (TypeScript port),
copied verbatim from
[`nayuki/QR-Code-generator`](https://github.com/nayuki/QR-Code-generator)
`typescript-javascript/qrcodegen.ts`, MIT licensed. The upstream copyright and
licence header is at the top of the file and must stay there.

## Why it is vendored rather than installed

The viewer is vanilla TypeScript, so the CI-standard React encoder
(`qrcode.react`) does not apply here. The npm republishes of Nayuki's generator
are stale (the widely-linked `nayuki-qr-code-generator` has not shipped since
2022), and this repo already prefers inlined, dependency-free UI primitives for
the same reasons `src/ui/icons.ts` states: no extra request, nothing to resolve
at build time. The library is a single self-contained file with no runtime
dependencies, so vendoring costs one file and removes a supply-chain edge.

`qrcode-terminal` (a devDependency, used by `scripts/qr.mjs` and
`scripts/house-links.mjs --qr`) is not an alternative: it renders to a TTY with
ANSI blocks and cannot produce DOM or SVG.

## Local modifications

Two, both recorded in the banner comment inside the file:

1. The three top-level `namespace qrcodegen…` declarations are `export`ed.
   `tsconfig.json` sets `moduleDetection: "force"`, so every file under `src/`
   is a module and an unexported namespace would never leave the file.
2. The banner comment itself.

Nothing else is changed. Keep it that way — the renderer that consumes it lives
in `src/ui/qr-code.ts`.

## Refreshing

```bash
curl -sSL -o src/third-party/qrcodegen/qrcodegen.ts \
  https://raw.githubusercontent.com/nayuki/QR-Code-generator/master/typescript-javascript/qrcodegen.ts
```

…then re-apply the two modifications above and re-run `npx tsc --noEmit`.
