// ============================================================
// network.js — Socket.io client wrapper.
// Responsibilities:
//   - connect/join a room
//   - send local player state at a fixed rate (throttled)
//   - receive peer state into a buffer and expose interpolated
//     snapshot for remote-player rendering
//   - send/receive authoritative events: hit, wanted, vehicle
//     ownership, mission pickup/dropoff
//   - expose roster/cash/mission from snapshots
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';

export class Network {
  constructor(game) {
    this.game = game;
    this.socket = null;
    this.connected = false;
    this.offline = false;     // true when running without a server (single-player)
    this.myId = null;
    this.myName = '';
    this.room = '';

    /** peers: id -> { pos, yaw, state, health, lastSeen, buffer:[], mesh, ... } */
    this.peers = new Map();

    this.roster = [];
    this.cash = 0;
    this.missionServer = { active: false, holderId: null };

    this._sendAccum = 0;
    this._onConnected = null;
  }

  connect(name, room) {
    this.myName = name;
    this.room = room;

    // If the Socket.io client script never loaded (server down / file://),
    // fall back to single-player so the sandbox is still playable.
    if (typeof io !== 'function') {
      return this._fallbackOffline(name);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = io({ transports: ['websocket', 'polling'] });

      const giveUp = () => {
        if (settled) return;
        // Server unreachable -> degrade to offline single-player instead of
        // hard-failing, so the game remains playable.
        settled = true;
        try { this.socket.disconnect(); } catch (_) {}
        this._fallbackOffline(name).then(resolve);
      };

      this.socket.on('connect', () => {
        this.connected = true;
        this.myId = this.socket.id;
        this.socket.emit('join', { name, room }, (res) => {
          if (settled) return;
          settled = true;
          if (!res || !res.ok) { reject(res?.reason || 'join-failed'); return; }
          this.myId = res.id;
          if (this._onConnected) this._onConnected();
          resolve(res);
        });
      });

      // If we can't reach the server within 3s, drop to offline mode.
      this.socket.on('connect_error', () => giveUp());
      setTimeout(giveUp, 3000);

      this.socket.on('disconnect', () => { this.connected = false; });
      this._bindEvents();
    });
  }

  /** Single-player fallback: no socket, local id, all reports become no-ops. */
  _fallbackOffline(name) {
    this.offline = true;
    this.connected = false;
    this.myId = 'local_' + Math.random().toString(36).slice(2, 8);
    this.roster = [{ id: this.myId, name, health: 100, wanted: 0, cash: 0 }];
    // local mission ownership works trivially
    this.missionServer = { active: false, holderId: null };
    if (this._onConnected) this._onConnected();
    // Surface this to the player once the game is live.
    setTimeout(() => this.game.hud?.toast('Offline mode — server not reachable. Single-player.', 'warn'), 100);
    return Promise.resolve({ ok: true, id: this.myId, name, room: this.room, offline: true, roster: this.roster });
  }

  onConnected(fn) { this._onConnected = fn; }

  _bindEvents() {
    const s = this.socket;

    s.on('peerState', (data) => this._onPeerState(data));
    s.on('snapshot', (data) => {
      this.roster = data.roster || [];
      if (data.cash && this.myId) this.cash = data.cash[this.myId] ?? this.cash;
      this.missionServer = data.mission;
      this.game.mission?.onServerState(data.mission);
    });

    s.on('playerJoined', (p) => {
      this.game.hud.toast(`${p.name} joined`, '');
    });
    s.on('playerLeft', ({ id }) => {
      const peer = this.peers.get(id);
      if (peer) {
        peer.mesh && this.game.scene.remove(peer.mesh);
        this.peers.delete(id);
      }
      const name = this.roster.find(r => r.id === id)?.name || 'A player';
      this.game.hud.toast(`${name} left`, '');
    });

    s.on('damageDealt', (d) => {
      // If we are the victim (player) and attacker is a peer/cop
      if (d.victim === this.myId && d.victimType === 'player') {
        this.game.onRemoteDamage(d.dmg, d.health, d.attacker);
      }
      // If we are the attacker, show hit marker
      if (d.attacker === this.myId) {
        this.game.hud.hitMarker();
      }
    });

    s.on('playerDown', ({ victim, attacker }) => {
      if (victim === this.myId) {
        // handled locally via health, but ensure state
      }
    });

    s.on('wantedChanged', ({ id, stars }) => {
      if (id === this.myId) {
        this.game.wanted.stars = stars; // server authoritative
        this.game.hud.setWanted(stars);
      }
    });

    s.on('vehicleClaimed', ({ vehicleId, by }) => {
      // mark a remote-claimed vehicle as unavailable (best-effort)
      this.game.onVehicleClaimedRemotely?.(vehicleId, by);
    });
    s.on('vehicleReleased', ({ vehicleId }) => {
      this.game.onVehicleReleasedRemotely?.(vehicleId);
    });

    s.on('missionState', (st) => {
      this.missionServer = st;
      this.game.mission?.onServerState(st);
    });
    s.on('missionComplete', ({ winner, reward }) => {
      if (winner === this.myId) return; // we already handled locally
      const name = this.roster.find(r => r.id === winner)?.name || 'Someone';
      this.game.hud.toast(`${name} delivered a package for $${reward}`, '');
    });

    s.on('chat', ({ name, text }) => {
      this.game.hud.toast(`${name}: ${text}`, '');
    });
  }

  // ---- outbound: local state (throttled) ----
  /** Build the local state payload (called from Game). */
  buildState(player, inVehicle, vehicle, weapon) {
    const p = player.pos;
    return {
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      yaw: +player.yaw.toFixed(3),
      state: player.state,
      health: Math.round(player.health),
      alive: player.alive,
      inVehicle: !!inVehicle,
      vehicle: vehicle ? {
        id: vehicle.id, x: +vehicle.pos.x.toFixed(2), z: +vehicle.pos.z.toFixed(2),
        yaw: +vehicle.yaw.toFixed(3), type: vehicle.type,
      } : null,
      weapon: weapon ? {
        id: weapon.currentWeapon.id,
        ammo: weapon.ammoState.mag,
      } : null,
    };
  }

  send(state) {
    if (!this.connected) return;
    this.socket.emit('state', state);
  }

  // ---- outbound: authoritative actions ----
  reportHit(payload) {
    if (!this.connected) return;
    this.socket.emit('shootHit', payload);
  }
  reportWanted(stars) {
    if (!this.connected) return;
    this.socket.emit('wantedUpdate', { stars });
  }
  reportPickup(cb) {
    if (!this.connected) { cb && cb(true); return; } // offline: always granted
    // The server currently grants pickup optimistically to the requester;
    // we treat success as "no other holder". Wrapped via missionState echo.
    this.socket.emit('missionPickup');
    // optimistic local: confirm; server will echo state. If someone else had
    // it, server won't set us as holder and will broadcast state; our mission
    // resets via onServerState.
    cb && cb(true);
  }
  reportDropoff() {
    if (!this.connected) return;
    this.socket.emit('missionDropoff');
  }
  claimVehicle(vehicleId, cb) {
    if (!this.connected) { cb && cb({ ok: true }); return; }
    this.socket.emit('vehicleClaim', { vehicleId }, (res) => cb && cb(res || { ok: false }));
  }
  releaseVehicle(vehicleId) {
    if (!this.connected) return;
    this.socket.emit('vehicleRelease', { vehicleId });
  }
  chat(text) {
    if (!this.connected || !text) return;
    this.socket.emit('chat', text);
  }

  // ---- inbound: peer state buffering ----
  _onPeerState(data) {
    let peer = this.peers.get(data.id);
    if (!peer) {
      peer = this._createPeer(data);
      this.peers.set(data.id, peer);
    }
    // IMPORTANT: stamp with the LOCAL receive clock (performance.now()), not
    // the server's Date.now() epoch. Interpolation brackets samples using the
    // same clock the render loop uses (performance.now()), so mixing them
    // would never find a bracket and peers would snap instead of interpolate.
    peer.buffer.push({ t: performance.now(), x: data.x, y: data.y, z: data.z, yaw: data.yaw, state: data.state });
    peer.lastSeen = performance.now();
    peer.health = data.health;
    peer.alive = data.alive;
    peer.inVehicle = data.inVehicle;
    peer.vehicle = data.vehicle;
    peer.weapon = data.weapon;
    // cap buffer
    if (peer.buffer.length > 12) peer.buffer.shift();
  }

  _createPeer(data) {
    // create a simple avatar mesh (clone of player look but different tint)
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98a5b, roughness: 0.8 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x6a4030, roughness: 0.7 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.8 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), jacket);
    torso.position.y = 1.15;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), skin);
    head.position.y = 1.85;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.26), pants); legL.position.set(-0.18, 0.45, 0);
    const legR = legL.clone(); legR.position.x = 0.18;
    for (const m of [torso, head, legL, legR]) { m.castShadow = true; g.add(m); }
    this.game.scene.add(g);
    // name label sprite
    const label = makeLabel(this.roster.find(r => r.id === data.id)?.name || 'Player');
    label.position.y = 2.3;
    g.add(label);
    return {
      id: data.id, mesh: g, label, buffer: [], pos: { x: data.x, y: data.y, z: data.z }, yaw: data.yaw,
      state: data.state, health: 100, lastSeen: performance.now(), inVehicle: false,
    };
  }

  /** Interpolate remote peers to renderTickTime = now - interpDelay. */
  interpolatePeers(now) {
    const renderTime = now - CONFIG.network.interpDelay * 1000;
    for (const peer of this.peers.values()) {
      const b = peer.buffer;
      if (b.length === 0) continue;
      // find two snapshots bracketing renderTime
      let s0 = b[0], s1 = b[b.length - 1];
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= renderTime && b[i + 1].t >= renderTime) { s0 = b[i]; s1 = b[i + 1]; break; }
      }
      const span = Math.max(1, s1.t - s0.t);
      const t = clamp01((renderTime - s0.t) / span);
      peer.pos.x = lerp1(s0.x, s1.x, t);
      peer.pos.y = lerp1(s0.y, s1.y, t);
      peer.pos.z = lerp1(s0.z, s1.z, t);
      peer.yaw = lerpAngle1(s0.yaw, s1.yaw, t);
      peer.state = s1.state;

      peer.mesh.position.set(peer.pos.x, peer.pos.y, peer.pos.z);
      peer.mesh.rotation.y = peer.yaw;
      peer.mesh.visible = peer.alive !== false;

      // if in vehicle, hide avatar (car is visible via its own state relay —
      // in this prototype remote cars aren't fully rendered; avatar becomes
      // a floating name tag for simplicity)
      if (peer.inVehicle) {
        peer.mesh.children.forEach(c => { if (c !== peer.label) c.visible = false; });
      } else {
        peer.mesh.children.forEach(c => { c.visible = true; });
      }
    }
  }

  dispose() {
    if (this.socket) this.socket.disconnect();
    for (const peer of this.peers.values()) this.game.scene.remove(peer.mesh);
    this.peers.clear();
  }
}

function lerp1(a, b, t) { return a + (b - a) * t; }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerpAngle1(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function makeLabel(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, 256, 64);
  ctx.font = 'bold 28px sans-serif';
  ctx.fillStyle = '#ffcc44';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.slice(0, 12), 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  return sprite;
}
