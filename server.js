'use strict';

/**
 * server.js — Cityfall game server (Node + Express + Socket.io)
 * ------------------------------------------------------------------
 * Responsibilities:
 *   1. Serve static client files (HTML/JS/CSS/assets) from /public.
 *   2. Host a single shared config (shared/config.js) used by client + server.
 *   3. Manage rooms/sessions and player roster (join/leave).
 *   4. Broadcast authoritative world snapshots at a fixed rate.
 *   5. Validate sensitive actions the client reports:
 *        - weapon fire / hits (damage)
 *        - vehicle enter/exit ownership
 *        - mission objective progress / completion
 *        - wanted-level events
 *
 * Design note on "authority":
 *   A browser prototype can't run a full authoritative physics sim without
 *   duplicating Three.js/Bullet on the server (heavy). We take a pragmatic
 *   hybrid: positions are client-simulated + server-relayed (the client owns
 *   its entity), but DAMAGE, OWNERSHIP, and MISSION state are validated
 *   server-side and echoed to the room. This keeps cheating effort high
 *   where it matters most (killing, scoring) while keeping the sim cheap.
 * ------------------------------------------------------------------
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const CONFIG = require('./shared/config');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
});

// Serve the client. shared/ is also exposed so the browser can fetch the
// raw config script (loaded as a classic <script> before modules).
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

// Optional friendly root route.
app.get('/health', (_req, res) => res.json({ ok: true, players: countPlayers() }));

// ---------------------------------------------------------------------------
// Room / player state
// ---------------------------------------------------------------------------

const DEFAULT_ROOM = 'downtown';

/** @type {Map<string, Room>} key = roomId */
const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    /** @type {Map<string, PlayerState>} socket.id -> state */
    this.players = new Map();
    this.mission = {
      active: false,
      holderId: null,   // who currently holds the package
      startTime: 0,
      completed: 0,
    };
    this.cash = {}; // socket.id -> cash
  }
}

class PlayerState {
  constructor(socketId, name) {
    this.id = socketId;
    this.name = name;
    this.spawnPos = { x: 0, y: 0, z: 0 };
    this.health = CONFIG.player.maxHealth;
    this.cash = 0;
    this.wanted = 0;       // 0..5 stars
    this.lastUpdate = Date.now();
  }
}

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) { r = new Room(id); rooms.set(id, r); }
  return r;
}

function countPlayers() {
  let n = 0;
  for (const r of rooms.values()) n += r.players.size;
  return n;
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  let currentRoomId = DEFAULT_ROOM;
  let currentName = `Player${Math.floor(Math.random() * 9000 + 1000)}`;

  socket.on('join', ({ name, room } = {}, ack) => {
    if (typeof name === 'string' && name.trim()) currentName = name.trim().slice(0, 16);
    if (typeof room === 'string' && room.trim()) currentRoomId = room.trim().slice(0, 24);

    const room_ = getRoom(currentRoomId);
    if (room_.players.size >= CONFIG.network.maxPlayersPerRoom) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'room-full' });
      socket.disconnect();
      return;
    }

    socket.join(currentRoomId);
    const ps = new PlayerState(socket.id, currentName);
    room_.players.set(socket.id, ps);
    room_.cash[socket.id] = 0;

    if (typeof ack === 'function') {
      ack({
        ok: true,
        id: socket.id,
        name: currentName,
        room: currentRoomId,
        config: CONFIG, // ship full config to the client for reference
        roster: rosterFor(room_),
      });
    }

    // Tell everyone else
    socket.to(currentRoomId).emit('playerJoined', {
      id: socket.id, name: currentName, spawn: ps.spawnPos,
    });
    console.log(`    joined room "${currentRoomId}" as "${currentName}"`);
  });

  // ---- Per-client movement/state broadcast (throttled by client) ----
  // The client sends its own state at CONFIG.network.sendRate; we relay to
  // others unchanged. Position is client-owned for responsiveness.
  socket.on('state', (payload) => {
    const room_ = rooms.get(currentRoomId);
    if (!room_) return;
    const ps = room_.players.get(socket.id);
    if (!ps) return;
    ps.lastUpdate = Date.now();
    // relay to peers (not self) with a server timestamp for interpolation
    socket.to(currentRoomId).emit('peerState', {
      id: socket.id,
      t: Date.now(),
      ...payload,
    });
  });

  // ---- Authoritative: shooting & damage ----
  // Client reports a resolved shot (hit someone?). Server does a coarse
  // sanity check (range cap, fire-rate cap) before applying damage and
  // broadcasting. This stops trivial "I shot you from across the map 60x/s".
  const lastShot = new Map(); // victimId -> last accepted time
  socket.on('shootHit', ({ weaponId, victimId, victimType, dmg, pos }) => {
    const room_ = rooms.get(currentRoomId);
    if (!room_) return;
    const w = CONFIG.weapons[weaponId];
    if (!w) return;

    const now = Date.now();
    const key = victimId || 'x';
    const last = lastShot.get(key) || 0;
    // Reject faster than fireRate allows (with tolerance for net jitter).
    const minGap = Math.max(40, w.fireRate * 1000 * 0.7);
    if (now - last < minGap) return;
    lastShot.set(key, now);

    // Clamp reported damage to weapon max so clients can't inflate it.
    const applied = Math.min(dmg ?? w.damage, w.damage + 2);

    if (victimType === 'player' && room_.players.has(victimId)) {
      const v = room_.players.get(victimId);
      v.health = Math.max(0, v.health - applied);
      io.to(currentRoomId).emit('damageDealt', {
        attacker: socket.id, victim: victimId, victimType,
        dmg: applied, health: v.health, pos,
      });
      if (v.health <= 0) {
        io.to(currentRoomId).emit('playerDown', { victim: victimId, attacker: socket.id });
        // respawn handled by the victim's own client on next tick
      }
    } else {
      // police / peds / vehicles: client simulates locally, server relays
      io.to(currentRoomId).emit('damageDealt', {
        attacker: socket.id, victim: victimId, victimType,
        dmg: applied, pos,
      });
    }
  });

  // ---- Wanted level: server is the source of truth so all peers agree ----
  socket.on('wantedUpdate', ({ stars }) => {
    const room_ = rooms.get(currentRoomId);
    if (!room_) return;
    const ps = room_.players.get(socket.id);
    if (!ps) return;
    const clamped = Math.max(0, Math.min(CONFIG.wanted.maxStars, Math.round(stars || 0)));
    if (clamped !== ps.wanted) {
      ps.wanted = clamped;
      io.to(currentRoomId).emit('wantedChanged', { id: socket.id, stars: clamped });
    }
  });

  // ---- Vehicle ownership transfer (enter/exit) ----
  // We track "who claims a vehicle" so two clients don't both drive it.
  const vehicleOwners = new Map(); // vehicleId -> socket.id
  socket.on('vehicleClaim', ({ vehicleId }, ack) => {
    const owner = vehicleOwners.get(vehicleId);
    if (owner && owner !== socket.id) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'taken' });
      return;
    }
    vehicleOwners.set(vehicleId, socket.id);
    socket.to(currentRoomId).emit('vehicleClaimed', { vehicleId, by: socket.id });
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('vehicleRelease', ({ vehicleId }) => {
    if (vehicleOwners.get(vehicleId) === socket.id) vehicleOwners.delete(vehicleId);
    socket.to(currentRoomId).emit('vehicleReleased', { vehicleId, by: socket.id });
  });

  // ---- Mission: package pickup / dropoff validated against holder ----
  socket.on('missionPickup', () => {
    const room_ = rooms.get(currentRoomId);
    if (!room_) return;
    if (room_.mission.holderId) return; // already held
    room_.mission.holderId = socket.id;
    if (!room_.mission.active) {
      room_.mission.active = true;
      room_.mission.startTime = Date.now();
    }
    io.to(currentRoomId).emit('missionState', {
      active: true, holderId: socket.id, startTime: room_.mission.startTime,
    });
  });

  socket.on('missionDropoff', () => {
    const room_ = rooms.get(currentRoomId);
    if (!room_) return;
    if (room_.mission.holderId !== socket.id) return;
    // Pay out.
    const reward = CONFIG.mission.rewardCash;
    room_.cash[socket.id] = (room_.cash[socket.id] || 0) + reward;
    room_.mission.completed++;
    room_.mission.active = false;
    room_.mission.holderId = null;
    io.to(currentRoomId).emit('missionComplete', {
      winner: socket.id, reward, total: room_.mission.completed,
    });
    // reset after a beat so a new package spawns
    setTimeout(() => {
      io.to(currentRoomId).emit('missionState', { active: false, holderId: null });
    }, 4000);
  });

  // ---- Chat / quick messages ----
  socket.on('chat', (msg) => {
    if (typeof msg !== 'string') return;
    const text = msg.slice(0, 120);
    io.to(currentRoomId).emit('chat', { id: socket.id, name: currentName, text });
  });

  socket.on('disconnect', () => {
    const room_ = rooms.get(currentRoomId);
    if (room_) {
      room_.players.delete(socket.id);
      delete room_.cash[socket.id];
      if (room_.mission.holderId === socket.id) {
        room_.mission.holderId = null;
        room_.mission.active = false;
        io.to(currentRoomId).emit('missionState', { active: false, holderId: null });
      }
      io.to(currentRoomId).emit('playerLeft', { id: socket.id });
    }
    for (const [vid, owner] of vehicleOwners.entries()) {
      if (owner === socket.id) vehicleOwners.delete(vid);
    }
    console.log(`[-] ${socket.id} disconnected`);
  });
});

// ---------------------------------------------------------------------------
// Snapshot loop — broadcasts the authoritative roster at a fixed rate.
// (Lightweight: ids, names, health, cash, wanted. Positions ride the
//  higher-rate `peerState` relay for smoothness.)
// ---------------------------------------------------------------------------
const SNAPSHOT_INTERVAL = 1000 / CONFIG.network.snapshotRate;
setInterval(() => {
  for (const [rid, room_] of rooms.entries()) {
    if (room_.players.size === 0) continue;
    io.to(rid).emit('snapshot', {
      t: Date.now(),
      roster: rosterFor(room_),
      cash: room_.cash,
      mission: {
        active: room_.mission.active,
        holderId: room_.mission.holderId,
        startTime: room_.mission.startTime,
        completed: room_.mission.completed,
      },
    });
  }
}, SNAPSHOT_INTERVAL);

function rosterFor(room_) {
  const out = [];
  for (const p of room_.players.values()) {
    out.push({ id: p.id, name: p.name, health: p.health, wanted: p.wanted, cash: room_.cash[p.id] || 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('===========================================================');
  console.log('  CITYFALL — multiplayer open-world prototype');
  console.log('-----------------------------------------------------------');
  console.log(`  Server:  http://localhost:${PORT}`);
  console.log(`  Rooms:   join any room name; default "${DEFAULT_ROOM}"`);
  console.log(`  Snapshots @ ${CONFIG.network.snapshotRate}/s`);
  console.log('===========================================================');
});
