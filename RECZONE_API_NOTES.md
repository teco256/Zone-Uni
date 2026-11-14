# RecZone web client: API notes

Reverse-engineered from the `reczone.zip` capture (client build `b55ef35a5b48`; the `a8c6042842cd` build shares byte-identical chunks, and only lacks the dorm-only files because that capture never loaded them).

Everything below comes from reading the client code and the captured responses. Anything the client can't tell us is listed in section 9, so treat server-side behaviour as unverified.

---

## 1. What the "minification" actually was

The update didn't just minify, it ran the code through a **string-array obfuscator** (javascript-obfuscator style). Every string, property name and object key was moved into a rotated lookup table and replaced with a call like `CT(0x2c2)`; properties were written as `obj[CT(0x18e)]`.

Each file carries three pieces of machinery:

| Piece | Looks like | Job |
|---|---|---|
| String-array function | `function d(){ const X=[...]; ... }` | holds every string |
| Decoder | `function C(c,l){ c=c-0x1cf; return d()[c]; }` | index → string (offset only, no RC4) |
| Rotation IIFE | `(function(a,b){ ... d['push'](d['shift']()) ... }(d, 0xd4f59))` | rotates the array until a checksum matches |

There is **no control-flow flattening**, so once the strings are put back the code is just ordinary (esbuild-bundled) JS with short mangled variable names. `deobf.cjs` runs those three pieces in a sandbox, substitutes the real strings, converts `obj['x']` to `obj.x`, turns `0x1f` into `31` and `!![]` into `true`, removes the dead machinery, and re-prints the result. All 17 files decode with 0 unresolved calls.

Local variable names are still mangled (`k`, `m`, `u`, `E`...). That part can't be recovered, but property names, method names, message types and URLs are all back.

---

## 2. Architecture

Three separate things talk to each other:

1. **The website** (same origin): serves pages and a JSON REST API under `/api/...`. Auth is a **session cookie** (`credentials: "same-origin"`).
2. **The relay** (a separate WebSocket host): carries all real-time multiplayer. The website mints a short-lived **ticket** that the relay checks.
3. **Static assets**: versioned under `/dorm/_/v/<buildhash>/public/`, plus `/uploads/...` for user content (avatars, music).

### Page bootstrap: `window.RZ`

The server injects this into every game page; `live.js` / `dorm.js` read it as `globalThis.RZ`:

```js
window.RZ = {
  room: "RECZONE" | "PAINTBALL" | "DORM-<userId>",
  roomName: "…",
  me: { id: <number>, name: "<username>", role: "user" },
  wsPath: "/engine-ws",            // fallback WS path on the same host
  relayUrl: "wss://<relay-host>/ws", // preferred: separate relay
  buildUrl: "/api/game/build",     // where to load the room's scene
  ticketUrl: "/api/dorms/ticket",  // present only for some rooms
  owner: { id, username }          // dorm pages only
}
```

Resolution of the WebSocket URL (`ct()` in `c-H3C27IZN.js`): use `relayUrl` if set, otherwise `ws(s)://<this host><wsPath || "/engine-ws">`.

---

## 3. Auth and tickets

- REST: cookie session. A signed-out user gets non-OK responses; the dorm panel shows "Sign in to use dorms".
- WebSocket: after the socket opens, the client sends a `hello` containing a `ticket`. Where the ticket comes from depends on the page config:

| Condition | Ticket request |
|---|---|
| `RZ.relayUrl` set (all current pages) | `POST /api/game/relay-ticket` with body `{ "room": "<room>" }` → `{ "ticket": "…" }` |
| else, `RZ.ticketUrl` set | `POST <ticketUrl>` (e.g. `/api/dorms/ticket`), no body → `{ "ticket": "…" }` |
| neither | `ticket: null` (guest) |

The ticket is opaque to the client. It is re-fetched on every (re)connect, and `room` is read at that moment, so switching dorms is just: set `net.room`, disconnect, reconnect, and a fresh ticket for the new room is requested.

---

## 4. REST API

All requests send `Accept: application/json` and the session cookie. Errors are generally `{ "error": "…" }` or `{ "message": "…" }` (the client reads both) with a non-2xx status.

### Game / world

| Method & path | Request | Response (as seen) | Notes |
|---|---|---|---|
| `GET /api/game/rooms` | none | `{ rooms: [{ id, name, sub, href }] }` | Room list for the menu |
| `GET /api/game/build` | none | `{ version, scene }` | Scene for the main room. `version` looks like `"rec-center-<ms>"` |
| `GET /api/game/paintball` | none | `{ scene: { version, name, spawns, zones, objects } }` | The LaserTag arena; ~1,260 objects. `zones: [{ name, team, min[3], max[3] }]` |
| `GET <buildUrl>` | none | as above | Polled every **30 s**; a **403** with `{message}` ejects you ("You were taken out of the build") |
| `GET /api/game/wallet` | none | `{ ok, currency:"RZ", balance, owned:{<category>:[ids]}, staff, buying, ogDuck }` | `owned` maps outfit category → owned item ids. `buying:false` means purchases are not live yet |
| `GET /api/game/outfits?names=a,b` | comma-separated usernames | `{ outfits: { <name>: Outfit } }` | Batched lookup for everyone in a room |
| `POST /api/game/outfit` | `{ outfit: Outfit }` | `{ ok, outfit }` | Saves your look. Client treats `!ok` as failure |
| `GET /api/game/avatars?names=a,b` | comma-separated usernames | `{ avatars: { <name>: url\|null } }` | Profile pictures; relative (`/uploads/avatars/…`) or absolute (Discord CDN) URLs |
| `GET /api/game/og-duck` | none | `{ ok, opensAt, closesAt, open, before, over, now, number, claimed, signedIn }` | Limited-time claim event. `now` is server ms; the client uses it to correct for clock skew |
| `POST /api/game/og-duck/claim` | none | `{ ok, number }` or `{ ok:false, message }` | |
| `POST /api/game/relay-ticket` | `{ room }` | `{ ticket }` | See section 3 |

**Outfit** object (categories and ids come from `CATALOG` in `js/modules/avatar.js`):

```json
{ "skin": "fair", "shirtColor": "black", "shirt": "tee", "hat": "cap",
  "face": "round", "expression": "wink", "hairColor": "brown", "hair": "none" }
```

The default outfit is `{ skin:"light", shirtColor:"zoneblue", shirt:"tee", hat:"cap", face:"none", expression:"default", hair:"none", hairColor:"brown" }`. The UI only lets you pick ids present in `wallet.owned[<category>]`; whether the server enforces the same is unverified.

### Dorms

| Method & path | Request | Response | Notes |
|---|---|---|---|
| `GET /api/dorms` | none | `{ dorms: [{ id, username, name, policy, room, knock }] }` | `policy` ∈ `open`\|`knock`\|`closed`; `knock` (your status with that dorm) ∈ `none`\|`waiting`\|`refused`\|`let-in` |
| `GET /api/dorms/me` | none | `{ room, name, code, policy, waiting:[{id,username}], guests:[{id,username}] }` | `code` is the 6-character invite code |
| `POST /api/dorms/me` | `{ policy }` **or** `{ showOut: <userId> }` | not used by the client | Change door policy, or remove a guest. The client ignores the body and just re-fetches `GET /api/dorms/me` |
| `GET /api/dorms/knocks` | none | `{ waiting: [{ id, username }] }` | Polled every **5 s** |
| `POST /api/dorms/knocks/<userId>` | `{ letIn: true\|false }` | `{ waiting }` | Answer a knock |
| `POST /api/dorms/<ownerId>/knock` | none | `{ state, message }` | `state:"let-in"` means walk straight in |
| `GET /api/dorms/by-code/<CODE>` | none | `{ mayEnter, room, name, owner:{ id } }` | Look up by invite code |
| `GET /api/dorms/scene/<room>` | none | `{ scene: { version, spawns, objects, …base } }` | e.g. `DORM-232` |
| `POST /api/dorms/scene` | `{ scene }` | `{ ok, message, notes:[] }` | Save your dorm build; `notes` are server-side fix-ups |
| `POST /api/dorms/ticket` | none | `{ ticket }` | See section 3 |
| `POST /api/dorms/report` | `{ room, reason, details }` (`details` ≤ 500 chars) | `{ message }` | Report a dorm |

Staff-gated endpoints also exist (`/api/dorms/staff-visit`, `/api/dorm-reports`, `/api/dorm-reports/<id>/resolve`, `/api/game/staff/players?names=`, radio takeover). The client only shows the UI when `me.role` / wallet `staff` allows it, and the real check is necessarily server-side, so they're not documented further here.

### Music / radio

| Method & path | Response | Notes |
|---|---|---|
| `GET /api/music` | `{ epoch, radio: [{ id, title, artist, duration, url }], menu: {…track…} }` | `epoch` is Unix **seconds** (currently 2026‑01‑01T00:00:00Z) |
| `GET /api/radio?room=<room>` | `{ now, takeover, dorm? }` | `now` is server ms. `dorm` (only in `DORM-*` rooms): `{ owner, ownerName, mine, state:{ mode, songId, startedAt, loop, paused, at, volume, v } }` |
| `POST /api/radio/dorm` | body `{ state }` → `{ state }` | Dorm owner pushes their playback state; `state.v` is a version counter used to resolve who is newer |
| `GET /api/radio/clips` | clip list | Staff takeover clips |
| `POST /api/radio/takeover` / `…/takeover/stop` | `{ clipId, message, volume, scope, kind }` | Staff |

**How the "radio" stays in sync without streaming state:** the public radio is a pure function of time. With the track list in order and `total` = sum of durations, the position is `((nowSeconds − epoch) mod total)`, walked through the list to find the current track and offset (`tt()` in `c-7WVWS6WJ.js`). Clients correct their clock using `now` from `/api/radio`, keeping the offset from the lowest-latency sample: `offset = server.now − (t_send + t_recv)/2`. Dorm radios instead follow the owner's `state` object, polled periodically.

---

## 5. WebSocket protocol

Plain JSON text frames of the form `{ "t": "<type>", ...fields }`. Implemented by the `Ls` class in `c-USQKEFSE.js`.

**Handshake**

1. Open the socket (URL from section 2).
2. On `open`: fetch a ticket (section 3), then send  
   `{ "t":"hello", "name":"<username>", "room":"<room>", "ticket":"<ticket>" }`
3. Server replies `welcome` (below). The client is "connected" only after this.

**Timers:** a `state` snapshot is sent at **30 Hz**; a `ping` every **3 s**. Reconnect backoff is `min(1000 · 2^(n−1), 15000)` ms. After an `error` with `code:"paused"` the client retries after 45 s + up to 15 s of jitter.

**Frame limits (enforced by the client's parser `On()`):** a frame is ignored if it isn't valid JSON with a string `t`, is over 512 KB, or is over 4096 chars unless its type is `scene` (up to 512 KB) or `voice` (up to 12 KB). The server very likely mirrors this, but that is an assumption.

### Client → server

| `t` | Fields | Purpose |
|---|---|---|
| `hello` | `name, room, ticket` | Join |
| `state` | `s: Snapshot` | Your avatar pose, 30 Hz |
| `chat` | `text` | Chat line |
| `ping` | `time` (ms) | Latency probe |
| `edit` | `op: EditOp` | Build edit (add/move/…) |
| `scene` | `objects, spawns?` | Replace the whole scene (dorm owner) |
| `obj` | `id, p[3], v[3], held` | Physics object (e.g. ball) position/velocity |
| `score` | `id` | Reported ball score |
| `tool` | `kind` + args (see below) | Staff-style tools |
| `lt` | `k:"fire", o[3], d[3], at?` | LaserTag shot |
| `voice` | `to, kind, data` | WebRTC signalling |
| `vstate` | `on, muted` | Announce mic state |

**Snapshot** (`s`), all numbers rounded to 3 decimals:

```
p:[x,y,z] position   y: yaw   t: pitch
l:[x,y,z] left hand  r:[x,y,z] right hand
g: bit0 = left hand extended, bit1 = right hand extended
w: wielded item  0 none | 1 rpg | 2 hammer | 3 builder | 4 duck | 5 blaster
```

**Tool payloads:** `{kind:"rpg", from, to}`, `{kind:"hammer", target}`, `{kind:"reset", target}`. Which of these you may use comes from the `staff` list in `welcome`; the client hides the UI, but the real gate has to be on the relay.

**EditOp:** `{k:"add", o:Obj}`, `{k:"remove", id}`, `{k:"move", o:Obj}`, `{k:"mat", o:Obj}`, `{k:"name", id, name}`. `mat` carries a full object but the receiver keeps its own transform if it is currently holding that object.

**LaserTag `fire`:** `o` is the ray origin, `d` the unit direction. `at` is a lag-compensation timestamp: the *server* time the shooter was displaying the nearest enemy at (`serverTimeOf(now − interpolationDelay)`). The client does its own raycast only for the visual; hit resolution is the server's.

**Voice signalling:** `kind` ∈ `offer` \| `answer` \| `ice` \| `bye`. `offer`/`answer` carry `{type, sdp}`; `ice` carries `{c:[candidates]}` (batched, ≤ 24). Media itself is peer-to-peer WebRTC using the `ice` server list from `welcome`.

### Server → client

| `t` | Fields | Purpose |
|---|---|---|
| `welcome` | `id, room, players[], objects[], ice, features[], og, staff, noVoice` | Handshake result. `players[]` items: `{id, name, og, bot, state?, voice?}`. `features` includes `"voice"` when supported |
| `joined` / `left` | `{id,name,og,bot}` / `{id}` | Roster changes |
| `state` | `id, s` | One player's snapshot |
| `bulk` | `at, states:{ <id>: Snapshot }` | Batched snapshots with server timestamp `at` |
| `chat` | `id, name, text` | |
| `pong` | `time` | Echo → latency = `Date.now() − time` |
| `error` | `why, code` | Codes seen: `replaced` (logged in elsewhere), `paused` |
| `edit` | `from, op, fixed, notes[]` | A peer's edit; the server may correct it (`fixed`) |
| `scene` | `objects` | Full scene replacement |
| `obj` | `id, owner, held, p, v` | Physics object update |
| `score` | `id, by, name` | |
| `tool` | tool-specific | |
| `reset` | `by, why` | You were reset |
| `staff` | `staff` | Permission list changed |
| `voice` / `vstate` | `from, kind, data` / `id, on, muted` | |
| `lt` | `k` + fields | LaserTag events, below |

**LaserTag events (`lt`, by `k`):**

| `k` | Fields |
|---|---|
| `match` | `phase` (`countdown`\|`playing`\|`ended`), `left`, `score`, `limit`, `players:{id:{team,bot,name,…}}`, `you`, `result` |
| `team` | `id, team, bot, name, moved` |
| `gone` | `id` |
| `shot` | `by, o, e, hit` (origin, end point, id hit or null) |
| `hp` | `id, hp, by` |
| `tag` | `victim, by, byName, team, score, respawn` |
| `spawn` | `id, p, y, protect` |
| `energy` | `e, lock` |
| `end` | `result: { winner, score }` |

---

## 6. Scene object schema

Used by `/api/game/build`, `/api/game/paintball`, `/api/dorms/scene/*`, and the `edit` / `scene` WebSocket messages. The sanitiser `pl()` in the client bundle shows the accepted shape and limits:

| Field | Rule |
|---|---|
| `id` | `^[A-Za-z0-9_:-]+$`, ≤ 40 chars |
| `kind` | `box` \| `sphere` \| `cylinder` \| `plane` \| `model` \| `stroke` (anything else becomes `box`) |
| `name` | ≤ 48 chars |
| `position`, `rotation`, `scale` | `[x,y,z]` numbers (rotation in degrees) |
| `colour` | `[r,g,b]` each 0–1 |
| `roughness`, `metallic` | 0–1 |
| `src` | ≤ 500 chars; `rz:assets/<path>.glb` or `.gltf#<nodeName>` for `kind:"model"` |
| `solid` | default `true` |
| optional | `hidden`, `locked`, `castShadow:false`, `emissive[3]` (0–4), `opacity` (0.05–1), `tag` (≤ 32), `notes` (≤ 300), `tint[3]` |
| `texture` | `rz:assets/….(jpg\|jpeg\|png\|webp)`, no `..`, plus `tile` 0.1–20 |
| `paint` | optional `{ walls, ceiling, trim, accents, basket, balls }`, each `[r,g,b]` |
| `stroke` | `points` (≤ 120 × `[x,y,z]`, clamped ±40, rounded to 0.01) and `width` 0.005–0.15 |

`tag` is how the world marks behaviour, e.g. hidden trigger boxes with `tag:"portal:arena"`, `portal:create`, `portal:dorms`, `portal:games`. Spawns are `{ name, position }` and the client filters them by `/spawn/i`.

---

## 7. Capture file naming

The saver turned URLs into filenames: `?` and `=` became `_`, and `,` became `%2C`. So `api/game/outfits_names_a%2Cb` is `GET /api/game/outfits?names=a,b`, and `api/radio_room_DORM-232` is `GET /api/radio?room=DORM-232`. When a path was both a file and a directory (`api/dorms`, `dorm`, `game`) the zip can't be extracted naively; the extraction script here renames those to `*.__file`.

---

## 8. Where things live in the code

| File | What's in it |
|---|---|
| `live.js` | Bootstrap for `/game` and `/game/paintball`: connects, loads the build, LaserTag HUD and event handling, polls for 403 eject |
| `dorm.js` | Bootstrap for `/dorm`: scene load/save, builder, knock UI wiring, report form |
| `c-USQKEFSE.js` (~385 KB) | The engine: renderer, collision, avatar/hands, **WebSocket client `Ls`**, **voice (WebRTC)**, scene document (`ye`), builder tools, pickups |
| `c-7WVWS6WJ.js` | Dorms panel, room menu, **music library + radio sync** |
| `c-H3C27IZN.js` | UI shell (menu pages, chat HUD, controls list), **relay-ticket + WS URL resolution**, avatar-picture batching |
| `c-ZGTNTUL7.js` | Pickups (basketballs/hoops) and the in-game staff panel (hands / RPG / ban-hammer tool selector) |
| `c-DJ4XDPT5.js` / `c-32QMBSR3.js` | Outfit defaults/builder and `dressPlayers` (applies other players' outfits) |
| `c-42X3NNAW.js` (dorm build only) | Wardrobe + store UI, wallet, OG-duck claim |
| `js/modules/avatar.js` | Avatar renderer and `CATALOG` (all outfit item ids) |

Searching tips for the readable output: `grep -n "fetch(" file.js` for REST, `grep -n "case J\.\|case et\." c-USQKEFSE.js` for the message enums (`et` = client→server types, `J` = server→client types).

---

## 9. What the client can't tell us

- **Ticket format** (signed? how long it lives?) and what the relay checks beyond it.
- **Server-side validation**: whether outfits, scenes, edits and tools are re-validated or only filtered client-side. The client-side limits above are the best hint, not proof.
- **Rate limits** and abuse handling.
- **Exact error bodies** beyond the `{error|message}` the client reads, and WebSocket close codes.
- **Server-only message types**: only types the client sends or handles appear here.
- **Relay behaviour** under load or version mismatch (the client mentions "needs the game server updated" for voice, so the relay is versioned separately from the site).

## 10. Re-running the decoder after the next update

```bash
npm i acorn esbuild
node deobf.cjs <dir-of-js> <out-dir>      # whole tree, skips vendor/ and *.min.js
node deobf.cjs file.js file.deobf.js      # one file
```

The tool locates the three obfuscator pieces structurally, not by name, so a re-seeded build (new chunk hashes, new array/decoder names) should still work. It would **not** handle RC4/base64 string encoding or control-flow flattening if the author switches those on later; the decoder in this build is a plain offset lookup. Only the three obfuscator functions are executed, in a `vm` sandbox, never the rest of the target file.
