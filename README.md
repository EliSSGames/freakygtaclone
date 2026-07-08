# CITYFALL — Multiplayer 3D Open-World Prototype

An **original, GTA-inspired** browser game: a compact sandbox city with driving,
walking, combat, a wanted/police system, traffic AI, pedestrians, a delivery
mission, and **real-time multiplayer** over WebSockets.

> This is an original project. It does **not** reuse any copyrighted assets,
> names, maps, characters, logos, missions, or storylines from any existing
> game. All geometry is procedural (Three.js primitives) and all art is
> placeholder. The city, mission flow, and naming are original.

---

## Tech stack

| Layer        | Choice                                  | Why |
|--------------|-----------------------------------------|-----|
| Structure/UI | HTML + CSS                              | Lightweight, no framework needed for an HUD |
| Client logic | **JavaScript (ES modules)**            | Native browser modules, no build step |
| 3D rendering | **Three.js r160** (WebGL, via CDN)     | De-facto standard for browser 3D |
| Networking   | **Node.js + Express + Socket.io v4**    | Reliable WebSocket transport, rooms, acks |
| Authority    | Hybrid (see Architecture)               | Cheap sim + validated sensitive actions |

No bundler. The browser loads Three.js through an `importmap`; the shared config
is a plain script loaded before the module entry.

---

## Quick start

Requirements: **Node.js ≥ 18**.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser. (Open it in two tabs or
two browsers/devices to see multiplayer — both join the same room by default.)

> Playing over LAN/online: share `http://<your-ip>:3000`. Socket.io connects
> back to the same host automatically.

---

## Controls

| Action            | Key                              |
|-------------------|----------------------------------|
| Move / drive      | `W A S D` (or arrows)            |
| Sprint            | `Shift`                          |
| Jump              | `Space` (handbrake while driving)|
| Enter / exit car  | `F`                              |
| Aim camera        | Mouse (click canvas to lock)     |
| Fire              | Left mouse                       |
| Reload            | `R`                              |
| Switch weapon     | `1` pistol · `2` SMG · `3` bat   |
| Pause             | `Esc`                            |
| Chat              | `Shift + Enter`                  |

Touch (basic): left half of screen = move stick, right half = look.

---

## How to play

1. Spawn near a road. Steal a parked car with `F`, or walk around.
2. Grab the **gold package marker**, then deliver it to the **green marker**
   for **$2,500** before the timer runs out.
3. Firing weapons, hitting pedestrians, ramming cars, or attacking police
   raises your **wanted level** (1–5 ★). Hide from the cops' line of sight to
   cool down.
4. Health regenerates on respawn after you go down.

---

## Project structure

```
GTA5HTML/
├── package.json
├── server.js               # Node + Express + Socket.io server
├── README.md
├── shared/
│   ├── config.js           # SINGLE source of truth for all tunables
│   └── esm-shim.js         # lets the browser import the CommonJS config
└── public/                 # everything served to the browser
    ├── index.html          # menu + canvas + HUD shell
    ├── styles.css          # UI / HUD styling
    └── js/
        ├── main.js         # Game class + master update loop (the hub)
        ├── utils.js        # math, pool, rng, helpers
        ├── input.js        # keyboard/mouse/touch + pointer lock
        ├── camera.js       # third-person orbit camera w/ collision
        ├── city.js         # procedural city + road graph + colliders
        ├── player.js       # on-foot movement, gravity, AABB collision
        ├── vehicles.js     # drivable cars + arcade physics
        ├── weapons.js      # loadout, hitscan, reload, FX
        ├── traffic.js      # AI road traffic (road-graph following)
        ├── pedestrians.js  # wandering/fleeing ambient NPCs
        ├── wanted.js       # wanted level + police AI
        ├── mission.js      # package-delivery mission w/ checkpoints
        ├── hud.js          # DOM HUD + canvas minimap
        ├── network.js      # Socket.io client + peer interpolation
        └── entities.js     # dynamic damageable-entity registry
```

---

## Architecture

### Module separation
Rendering (Three.js), physics (custom arcade + AABB), AI (traffic/peds/police),
UI (HUD/minimap), and networking (`network.js`) are deliberately separate
modules. `main.js` is the **only** module that imports all of them; everything
else is dependency-injected. That keeps each subsystem testable and replaceable.

### Networking model (hybrid authority)
A browser prototype can't realistically run a full authoritative physics sim
on the server without duplicating Three.js/Bullet server-side. We use a
**pragmatic hybrid**:

- **Client-owned positions.** Each client simulates its own player/vehicle and
  broadcasts state at `CONFIG.network.sendRate` (~30 Hz). Positions are relayed,
  not re-simulated — this keeps the server cheap and movement responsive.
- **Server-authoritative for the things that matter.**
  - **Damage** (`shootHit`): the server clamps reported damage to the weapon's
    max and enforces a minimum gap based on `fireRate`, so trivial "I shot you
    60×/s from across the map" cheats are rejected.
  - **Wanted level** is echoed server-side so all peers agree.
  - **Mission pickup/dropoff** is validated by holder ownership — you can't
    double-collect or steal a payout by replaying events.
  - **Vehicle ownership** (`vehicleClaim`/`vehicleRelease`) prevents two players
    driving the same car.
- **Remote-player rendering** uses a snapshot buffer + interpolation with a
  configurable rewind window (`network.interpDelay`) to hide jitter.

### Why one shared config
`shared/config.js` is the single source of truth for world layout (grid size,
road width), entity sizes, movement caps, weapon stats, wanted thresholds, and
police behavior. Loading it as a classic script on the client (attaching to
`globalThis`) and `require()`-ing it on the server guarantees both sides agree
on the rules — essential for the authority checks above.

### Performance
- Caps on traffic (`maxVehicles: 28`), peds (`maxPeds: 40`), and cops per star.
- Spawn/despawn ring around the player so only nearby entities simulate.
- Per-frame `new` allocations avoided via scratch vectors (`utils.tmpV*`).
- Shadow map is a single 2048² directional cascade (cheap, good enough).
- Remote interpolation is constant-time per peer.

---

## Tuning

Almost everything is in `shared/config.js`. Common knobs:

- `world.gridCells` / `world.cellSize` — city size (regenerated on load).
- `traffic.maxVehicles` / `peds.maxPeds` — population caps for perf.
- `weapons.*` — damage, fire rate, mag size, spread.
- `wanted.starThresholds` — how much heat each star needs.
- `police.unitsPerStar` — cop count per wanted level.
- `mission.timeLimit` / `mission.rewardCash` — mission tuning.
- `network.sendRate` / `network.interpDelay` — net feel vs. bandwidth.

Edit and refresh — no rebuild needed.

---

## Assumptions & limitations

- **No character animation system.** Limb swing is crude procedural math; the
  `state` field (`idle/walk/run/jump/fall`) is broadcast for remote players so a
  real rig could be dropped in later.
- **Vehicle physics are arcade-style**, not a full rigid-body simulator. Good
  enough for fun driving; not for sim-cade realism.
- **Remote vehicles are simplified.** Remote players' cars aren't fully
  rendered (their avatar becomes a floating name tag while driving) — a known
  simplification to keep bandwidth and asset complexity low.
- **Damage is hybrid-authoritative.** Position is client-trusted; a determined
  cheater could teleport. Sensitive outcomes (kills, score, ownership, wanted)
  are validated server-side. This is the standard tradeoff for browser games.
- **Single process server.** One Node process handles all rooms in memory. For
  a real deployment you'd add Redis/Socket.io-adapter for horizontal scaling.
- **Collision is AABB-vs-buildings + simple car-vs-entity.** No full mesh
  collision. Good for a city of boxes; not for arbitrary geometry.
- **Audio is left as hooks** (see "Sound" in the Extra Ideas) — placeholders
  only, to keep the project dependency-free.

---

## Extending it

- **New weapon:** add an entry to `CONFIG.weapons`, push its id into
  `defaultLoadout`, and it's automatically switchable with `1/2/3`.
- **New vehicle type:** add to `CONFIG.vehicle`; `spawnTrafficSeed` and traffic
  AI pick it up.
- **New mission:** subclass or branch on a `missionId` in `mission.js`; the
  server's `missionPickup`/`missionDropoff` ownership check generalizes.
- **More police tiers:** extend `police.unitsPerStar` and add behavior tiers in
  `wanted.js`.

---

## License / originality

Original work. No third-party copyrighted game assets are used. Three.js and
Socket.io are MIT-licensed. Built as a self-contained engineering prototype.
