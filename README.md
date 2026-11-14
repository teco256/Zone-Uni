**Per request of RecZone management i removed the deobfuscated client code.**
# Zone-Uni

Reverse-engineering the RecZone (rec.zone) web client to understand how its API and multiplayer protocol work, with the goal of building a compatible API server.

## Progress

- [x] Client datamining
- [x] Deobfuscating
- [x] Documenting API
- [ ] Making a API server

## What's here

| File | What it is |
|---|---|
| `RECZONE_API_NOTES.md` | Full API reference: REST endpoints, WebSocket protocol, scene schema, radio sync, known gaps |
| `reczone-deobfuscated.zip` | The client JS with the string-array obfuscation removed (formatted, real property names and URLs) |
| `deobf.cjs` | The deobfuscator, reusable when the game updates again |

## Overview

The client talks to three things:

1. **Website REST API** (`/api/...`), cookie-session auth. Covers rooms, dorms, wallet, outfits, avatars, music and radio.
2. **WebSocket relay**, JSON frames shaped like `{ "t": "<type>", ... }`. The client gets a ticket from `POST /api/game/relay-ticket`, then sends `hello` and receives `welcome`.
3. **Static assets** under `/dorm/_/v/<buildhash>/public/` and user uploads under `/uploads/`.

See `RECZONE_API_NOTES.md` for payloads and limits.

## Deobfuscating a new build

```bash
npm i acorn esbuild
node deobf.cjs <dir-of-js> <out-dir>   # whole tree (skips vendor/ and *.min.js)
node deobf.cjs file.js file.deobf.js   # single file
```

The tool finds the string array, decoder and rotation function by structure, runs only those in a `vm` sandbox, substitutes the real strings, and re-prints the code with esbuild. It won't handle RC4/base64 string encoding or control-flow flattening if those get enabled later.

## Next: API server

What still needs figuring out, since the client can't show it:

- Ticket format and how the relay verifies it
- Server-side validation of outfits, scenes and edits
- Rate limits and error bodies
- Server-only WebSocket message types

The notes file lists these gaps in section 9.
