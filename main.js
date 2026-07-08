// ============================================================
// main.js — Game entry point and the master update loop.
// Wires together: renderer, scene, lights, city, player, vehicles,
// weapons, traffic, pedestrians, wanted/police, mission, HUD,
// networking, input, camera, and the menu/pause flow.
//
// This is the only module that knows about ALL subsystems; everything
// else is modular and dependency-injected.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { Input } from './input.js';
import { CameraController } from './camera.js';
import { City } from './city.js';
import { Player } from './player.js';
import { Vehicle, spawnTrafficSeed } from './vehicles.js';
import { WeaponSystem } from './weapons.js';
import { TrafficManager } from './traffic.js';
import { PedestrianManager } from './pedestrians.js';
import { WantedSystem, PoliceManager } from './wanted.js';
import { Mission } from './mission.js';
import { HUD } from './hud.js';
import { Network } from './network.js';
import { Entities } from './entities.js';
import { distXZ, clamp } from './utils.js';

// ------------------------------------------------------------
// Game
// ------------------------------------------------------------
// Implemented as a class (not constructor + prototype) so that all
// methods are part of one declaration. This avoids a whole class of
// load-order bugs where `new Game()` runs before prototype methods
// have been attached.
class Game {
  constructor(canvas) {
    this.canvas = canvas;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Scene + sky
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10141c);
    this.scene.fog = new THREE.Fog(0x10141c, 60, 260);

    // Camera
    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 6, 10);

    this._buildLights();
    this._buildSky();

    // Core systems
    this.input = new Input(canvas);
    this.cameraController = new CameraController(this.camera, this.scene);
    this.entities = new Entities();
    this.hud = new HUD(this);

    // state
    this.started = false;
    this.paused = false;
    this.clock = new THREE.Clock();
    this._netAccum = 0;
    this._lineFx = []; // temp tracer lines (cops etc.)

    this.mode = 'foot'; // 'foot' | 'drive'
    this.currentVehicle = null;

    // day/night
    this.timeOfDay = 0.32; // 0..1

    // bind the loop once so requestAnimationFrame keeps `this`
    this._loop = this._loop.bind(this);

    this._bindResize();
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0x9db4ff, 0x402a18, 0.65);
    this.scene.add(hemi);
    this.hemi = hemi;

    const sun = new THREE.DirectionalLight(0xfff0d0, 1.1);
    sun.position.set(60, 90, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 400;
    const d = 160;
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.sun = sun;
  }

  _buildSky() {
    // gradient sky dome
    const geo = new THREE.SphereGeometry(500, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(0x2a3a5a) },
        bottom: { value: new THREE.Color(0xc8b070) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bottom;
        void main(){ float h = normalize(vP).y*0.5+0.5; gl_FragColor = vec4(mix(bottom, top, clamp(h,0.0,1.0)), 1.0); }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.scene.add(this.sky);
  }

  _bindResize() {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ----------------------------------------------------------
  // Start: connect + build world
  // ----------------------------------------------------------
  async start(name, room) {
    // Networking first (so we have myId)
    this.net = new Network(this);
    await this.net.connect(name, room);

    // World
    this.city = new City(this.scene);
    this.cameraController.setColliders(this.city.buildingMeshes);

    // Player
    this.player = new Player(this.scene, this.city);
    const spawnNode = this.city.randomNode();
    this.player.spawn(spawnNode.pos);
    this.cameraController.snapBehind(this.player.yaw);

    // Parked vehicles (enterable) + register them as entities
    this.parkedVehicles = spawnTrafficSeed(this.scene, this.city, 16);
    for (const v of this.parkedVehicles) this.entities.register(v);

    // Weapons
    this.weapons = new WeaponSystem(this.scene, this);

    // AI managers
    this.traffic = new TrafficManager(this.scene, this.city);
    this.peds = new PedestrianManager(this.scene, this.city);
    this.wanted = new WantedSystem(this);
    this.police = new PoliceManager(this.scene, this.city, this.wanted, this);

    // Mission
    this.mission = new Mission(this.scene, this.city, this);
    // start mission after a short beat
    setTimeout(() => this.mission.start(), 1500);

    // HUD init
    this.hud.setHealth(this.player.health, this.player.armor);
    this.hud.setWanted(0);
    this.hud.setCash(0);
    this.hud.setWeapon(this.weapons.currentWeapon.name, this.weapons.ammoState.mag, this.weapons.ammoState.reserve);
    this.hud.setMission('MISSION', 'Initializing…');

    this.started = true;
    this.clock.start();
    requestAnimationFrame(this._loop);

    // canvas click -> pointer lock
    this.canvas.addEventListener('click', () => {
      if (!this.paused) this.input.requestLock();
    });
  }

  // ----------------------------------------------------------
  // Per-frame hooks called by subsystems
  // ----------------------------------------------------------
  onLocalHit(target, dmg, point) {
    this.hud.hitMarker();
    if (target.kind === 'ped') {
      this.wanted.add(CONFIG.wanted.heatPerCivilianHit, 'hit civilian');
      this.peds.panicNear(point, 35);
    } else if (target.kind === 'cop') {
      this.wanted.add(CONFIG.wanted.heatPerCopHit, 'shot cop');
    } else if (target.kind === 'car' || target.kind === 'traffic' || target.type === 'vehicle') {
      this.wanted.add(CONFIG.wanted.heatPerVehicleDamage * dmg, 'damaged vehicle');
    }
  }

  onWeaponFired(w) {
    if (w.type === 'gun') {
      this.wanted.add(CONFIG.wanted.heatPerShot, 'discharged firearm');
      this.peds.panicNear(this.player.pos, 25);
    }
    if (w.type === 'melee') {
      this.peds.panicNear(this.player.pos, 12);
    }
  }

  onWantedChanged(stars, up) {
    this.hud.setWanted(stars);
    if (up && stars > 0) {
      const msg = stars === 1 ? 'Police are searching for you.'
        : stars >= 4 ? 'ARMED RESPONSE inbound!'
          : `Wanted level up: ${stars} stars.`;
      this.hud.toast(msg, 'warn');
    } else if (stars === 0) {
      this.hud.toast('You lost the cops.', 'good');
    }
  }

  onCopHitPlayer(dmg) {
    if (!this.player.alive) return;
    this.player.takeDamage(dmg);
    this.hud.damageFlash();
    this.hud.setHealth(this.player.health, this.player.armor);
    if (!this.player.alive) this._onPlayerDown('taken down by police');
  }

  onRemoteDamage(dmg, health, attackerId) {
    // server-validated damage from another player
    this.player.health = health; // server authoritative
    this.hud.setHealth(this.player.health, this.player.armor);
    this.hud.damageFlash();
    if (this.player.health <= 0) this._onPlayerDown('taken down by a player');
  }

  _onPlayerDown(reason) {
    this.hud.toast(`You were ${reason}.`, 'warn');
    this.mission?.onPlayerDown();
    // Player.update handles respawn countdown
  }

  addCash(amount) {
    this.net.cash = (this.net.cash || 0) + amount;
    this.hud.setCash(this.net.cash);
  }

  spawnLine(from, to, color) {
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this._lineFx.push({ line, life: 0.06, max: 0.06 });
  }

  // ----------------------------------------------------------
  // Pause / quit
  // ----------------------------------------------------------
  togglePause(force) {
    const next = (force === undefined) ? !this.paused : force;
    this.paused = next;
    if (next) {
      pauseOverlay.classList.remove('hidden');
      if (document.exitPointerLock) document.exitPointerLock();
    } else {
      pauseOverlay.classList.add('hidden');
      this.input.requestLock();
    }
  }

  quit() {
    this.net?.dispose();
    location.reload();
  }

  // ----------------------------------------------------------
  // THE LOOP
  // ----------------------------------------------------------
  _loop() {
    if (!this.started) return;
    requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, this.clock.getDelta()); // clamp to avoid spiral after tab-out

    if (!this.paused) this.update(dt);
    this.render();

    this.input.endFrame();
  }

  update(dt) {
    this._handleMetaKeys();

    // input -> camera look
    const m = this.input.consumeMouse();
    this.cameraController.look(m.dx, m.dy);

    if (this.mode === 'foot') this._updateFoot(dt);
    else this._updateDriving(dt);

    // weapons (only fire when locked & alive)
    if (this.player.alive && this.input.pointerLocked) {
      this.weapons.firing = this.input.mouseDown;
    } else {
      this.weapons.firing = false;
    }
    // weapon switch
    if (this.input.justPressed('Digit1')) this.weapons.switchTo(0);
    if (this.input.justPressed('Digit2')) this.weapons.switchTo(1);
    if (this.input.justPressed('Digit3')) this.weapons.switchTo(2);
    if (this.input.justPressed('KeyR')) this.weapons.reload();

    // compute muzzle origin + aim dir from camera center
    const aim = this._computeAim();
    this.weapons.update(dt, aim.origin, aim.dir);

    // AI traffic + peds
    const refPos = this.mode === 'drive' ? this.currentVehicle.pos : this.player.pos;
    this.traffic.update(dt, refPos, this.mode === 'drive' ? this.currentVehicle : null);
    this.peds.update(dt, refPos);

    // Wanted + police (target = player or car)
    const target = this.mode === 'drive' ? this.currentVehicle.pos : this.player.pos;
    const seen = this.police.update(dt, target);
    this.wanted.update(dt, seen);

    // Mission
    this.mission.update(dt, refPos);

    // Entities prune
    this.entities.prune();

    // Networking: send at throttled rate, interpolate peers
    this._netAccum += dt;
    if (this._netAccum >= 1 / CONFIG.network.sendRate) {
      this._netAccum = 0;
      const st = this.net.buildState(this.player, this.mode === 'drive', this.currentVehicle, this.weapons);
      this.net.send(st);
    }
    this.net.interpolatePeers(performance.now());

    // Day/night drift (slow)
    this.timeOfDay = (this.timeOfDay + dt * 0.004) % 1;
    this._updateTimeOfDay();

    // HUD sync
    this.hud.setHealth(this.player.health, this.player.armor);
    this.hud.setWanted(this.wanted.stars);
    const w = this.weapons.currentWeapon;
    const a = this.weapons.ammoState;
    this.hud.setWeapon(w.name, a.mag, a.reserve);
    this.hud.setCash(this.net.cash || 0);
    this.hud.setPlayerList(this.net.roster, this.net.myId);
    this._drawMinimap();

    // temp line FX
    for (let i = this._lineFx.length - 1; i >= 0; i--) {
      const f = this._lineFx[i];
      f.life -= dt;
      f.line.material.opacity = Math.max(0, f.life / f.max) * 0.9;
      if (f.life <= 0) { this.scene.remove(f.line); f.line.geometry.dispose(); this._lineFx.splice(i, 1); }
    }
  }

  _handleMetaKeys() {
    if (this.input.justPressed('Escape')) {
      this.togglePause();
    }
    if (this.input.justPressed('Enter') && this.input.down('ShiftLeft')) {
      this._openChat();
    }
    // enter/exit vehicle
    if (this.input.justPressed('KeyF')) {
      if (this.mode === 'foot') this._tryEnterVehicle();
      else this._exitVehicle();
    }
  }

  // ----------------------------------------------------------
  // On-foot update
  // ----------------------------------------------------------
  _updateFoot(dt) {
    const i = this.input;
    const fwd = (i.down('KeyW') || i.down('ArrowUp') ? 1 : 0) - (i.down('KeyS') || i.down('ArrowDown') ? 1 : 0);
    const rgt = (i.down('KeyD') || i.down('ArrowRight') ? 1 : 0) - (i.down('KeyA') || i.down('ArrowLeft') ? 1 : 0);
    // touch move override
    let tf = 0, tr = 0;
    if (Math.abs(i.touch.moveY) > 0.1) tf = -clamp(i.touch.moveY, -1, 1);
    if (Math.abs(i.touch.moveX) > 0.1) tr = clamp(i.touch.moveX, -1, 1);

    this.player.intent.forward = fwd !== 0 ? fwd : tf;
    this.player.intent.right = rgt !== 0 ? rgt : tr;
    this.player.intent.run = i.down('ShiftLeft') || i.down('ShiftRight');
    this.player.intent.jump = i.justPressed('Space');

    this.player.update(dt, this.cameraController.yaw);

    // camera follows player eye
    const eye = tmpVec.copy(this.player.pos);
    eye.y += CONFIG.player.eyeHeight;
    this.cameraController.update(eye, { driving: false, dt });
  }

  // ----------------------------------------------------------
  // Driving update
  // ----------------------------------------------------------
  _updateDriving(dt) {
    const i = this.input;
    const v = this.currentVehicle;
    if (!v) { this.mode = 'foot'; return; }

    const throttle = (i.down('KeyW') || i.down('ArrowUp') ? 1 : 0) - (i.down('KeyS') || i.down('ArrowDown') ? 1 : 0);
    const steer = (i.down('KeyA') || i.down('ArrowLeft') ? 1 : 0) - (i.down('KeyD') || i.down('ArrowRight') ? 1 : 0);
    const handbrake = i.down('Space');

    v.update(dt, { throttle, steer, handbrake });

    // camera follows car, looks over the hood; auto-align behind heading
    const carPos = tmpVec.copy(v.pos); carPos.y += 2.0;
    this.cameraController.update(carPos, { driving: true, desiredYaw: v.yaw + Math.PI, dt });

    // damage to player if car is destroyed while inside
    if (v.disabled && this.player.alive) {
      this.player.takeDamage(2 * dt * 10); // burning
      this.hud.damageFlash();
      this.hud.setHealth(this.player.health, this.player.armor);
    }

    // run over pedestrians / hit traffic (crime)
    this._vehicleImpacts(v, dt);
  }

  _vehicleImpacts(v, dt) {
    // check peds and other vehicles near the car
    const speed = Math.hypot(v.vel.x, v.vel.z);
    for (const e of this.entities.dynamic) {
      if (e === v) continue;
      if (e.kind === 'ped' && e.alive) {
        const d = distXZ(v.pos.x, v.pos.z, e.pos.x, e.pos.z);
        if (d < 2.2 && speed > 4) {
          e.takeDamage(100);
          this.wanted.add(CONFIG.wanted.heatPerCivilianHit, 'ran over civilian');
          this.peds.panicNear(v.pos, 40);
        }
      } else if (e.kind === 'traffic') {
        const d = distXZ(v.pos.x, v.pos.z, e.pos.x, e.pos.z);
        if (d < 3.0) {
          e.takeDamage(speed * 1.5);
          v.takeDamage(speed * 0.3);
          this.wanted.add(CONFIG.wanted.heatPerVehicleDamage * 2, 'rammed vehicle');
        }
      } else if (e.kind === 'cop' && e.alive) {
        const d = distXZ(v.pos.x, v.pos.z, e.pos.x, e.pos.z);
        if (d < 2.2 && speed > 4) {
          e.takeDamage(100);
          this.wanted.add(CONFIG.wanted.heatPerCopHit, 'ran over cop');
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Enter / exit vehicle
  // ----------------------------------------------------------
  _tryEnterVehicle() {
    let best = null, bestD = CONFIG.player.enterVehicleRange;
    for (const v of this.parkedVehicles) {
      if (v.disabled) continue;
      const d = distXZ(this.player.pos.x, this.player.pos.z, v.pos.x, v.pos.z);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (!best) { this.hud.toast('No vehicle nearby.', ''); return; }
    // claim via server
    this.net.claimVehicle(best.id, (res) => {
      if (!res || !res.ok) { this.hud.toast('Vehicle is taken.', 'warn'); return; }
      this._enterVehicle(best);
    });
  }

  _enterVehicle(v) {
    this.currentVehicle = v;
    v.driver = this.net.myId;
    this.mode = 'drive';
    this.player.mesh.visible = false;
    this.cameraController.curDistance = CONFIG.camera.carDistance;
    this.cameraController.snapBehind(v.yaw + Math.PI);
    this.hud.toast(`Driving: ${v.type.toUpperCase()}`, '');
  }

  _exitVehicle() {
    const v = this.currentVehicle;
    if (!v) return;
    this.net.releaseVehicle(v.id);
    // place player beside the car
    const fwd = new THREE.Vector3(Math.sin(v.yaw), 0, Math.cos(v.yaw));
    const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    this.player.pos.set(v.pos.x + side.x * 2.2, 0, v.pos.z + side.z * 2.2);
    this.player.vel.set(0, 0, 0);
    this.player.mesh.visible = this.player.alive;
    this.mode = 'foot';
    v.driver = null;
    this.currentVehicle = null;
    this.cameraController.curDistance = CONFIG.camera.thirdPersonDistance;
  }

  // ----------------------------------------------------------
  // Aim ray from screen center
  // ----------------------------------------------------------
  _computeAim() {
    // shoot from camera through screen center into the world
    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
    // For on-foot third-person, we want the bullet to come roughly from the
    // player's gun height and travel toward the aim point. Find aim point on
    // a far plane, then aim from muzzle to that point.
    const aimPoint = origin.clone().add(dir.clone().multiplyScalar(60));
    const muzzle = (this.mode === 'drive' ? this.currentVehicle.pos : this.player.pos).clone();
    muzzle.y += CONFIG.player.eyeHeight - 0.2;
    // nudge muzzle forward a touch toward camera-facing
    const f = new THREE.Vector3(Math.sin(this.cameraController.yaw), 0, Math.cos(this.cameraController.yaw));
    muzzle.add(f.multiplyScalar(0.4));
    const mdir = aimPoint.sub(muzzle).normalize();
    return { origin: muzzle, dir: mdir };
  }

  // ----------------------------------------------------------
  // Minimap data
  // ----------------------------------------------------------
  _drawMinimap() {
    const ref = this.mode === 'drive' ? this.currentVehicle.pos : this.player.pos;
    const yaw = this.mode === 'drive' ? this.currentVehicle.yaw : this.player.yaw;
    const buildings = [];
    for (const b of this.city.buildingBoxes) {
      if (distXZ((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, ref.x, ref.z) < 70) {
        buildings.push(b);
      }
    }
    const markers = [];
    if (this.mission.pickupMarker.group.visible) {
      markers.push({ x: this.mission.pickupMarker.group.position.x, z: this.mission.pickupMarker.group.position.z, color: '#ffcc33' });
    }
    if (this.mission.dropoffMarker.group.visible) {
      markers.push({ x: this.mission.dropoffMarker.group.position.x, z: this.mission.dropoffMarker.group.position.z, color: '#33dd66' });
    }
    const vehicles = [];
    for (const v of this.parkedVehicles) {
      if (distXZ(v.pos.x, v.pos.z, ref.x, ref.z) < 80) vehicles.push({ x: v.pos.x, z: v.pos.z });
    }
    for (const v of this.traffic.vehicles) vehicles.push({ x: v.pos.x, z: v.pos.z });
    const cops = this.police.cops.map(c => ({ x: c.pos.x, z: c.pos.z }));
    const peers = [];
    for (const p of this.net.peers.values()) peers.push({ x: p.pos.x, z: p.pos.z, yaw: p.yaw });

    this.hud.drawMinimap({ player: { x: ref.x, z: ref.z, yaw }, buildings, markers, vehicles, cops, peers });
  }

  // ----------------------------------------------------------
  // Time of day
  // ----------------------------------------------------------
  _updateTimeOfDay() {
    const t = this.timeOfDay;
    const ang = t * Math.PI * 2;
    this.sun.position.set(Math.cos(ang) * 80, Math.sin(ang) * 90 + 10, 40);
    const day = clamp(Math.sin(ang) * 1.2 + 0.2, 0, 1);
    this.sun.intensity = 0.25 + day * 1.0;
    this.hemi.intensity = 0.3 + day * 0.5;
    const night = new THREE.Color(0x0a1020);
    const dayTop = new THREE.Color(0x3a5a8a);
    const dayBot = new THREE.Color(0xd0a85a);
    this.sky.material.uniforms.top.value.copy(night).lerp(dayTop, day);
    this.sky.material.uniforms.bottom.value.copy(night).lerp(dayBot, day);
    this.scene.background.copy(night).lerp(new THREE.Color(0x10141c).lerp(dayTop, 0.4), day);
    this.scene.fog.color.copy(this.scene.background);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  // Chat (basic)
  _openChat() {
    const bar = document.getElementById('chatBar');
    const input = document.getElementById('chatInput');
    bar.classList.remove('hidden');
    input.value = '';
    input.focus();
    if (document.exitPointerLock) document.exitPointerLock();
    const finish = () => {
      bar.classList.add('hidden');
      input.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { this.net.chat(input.value); finish(); }
      else if (e.key === 'Escape') { finish(); this.input.requestLock(); }
    };
    input.addEventListener('keydown', onKey);
  }
}

// ------------------------------------------------------------
// Boot + menu wiring (runs AFTER the Game class is fully defined,
// so `new Game()` can see every method. This ordering is what
// prevents the "this._buildLights is not a function" crash.)
// ------------------------------------------------------------
const canvas = document.getElementById('game');
const menu = document.getElementById('menu');
const pauseOverlay = document.getElementById('pause');
const hudEl = document.getElementById('hud');

const game = new Game(canvas);
window.__game = game; // for debugging

const nameInput = document.getElementById('nameInput');
const roomInput = document.getElementById('roomInput');
const playBtn = document.getElementById('playBtn');
const menuError = document.getElementById('menuError');
nameInput.value = nameInput.value || randomName();

playBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });

document.getElementById('resumeBtn').addEventListener('click', () => game.togglePause(false));
document.getElementById('quitBtn').addEventListener('click', () => game.quit());

function randomName() {
  const names = ['Nico', 'Lara', 'Max', 'Diaz', 'Vega', 'Kane', 'Ivy', 'Rey', 'Jules', 'Sasha'];
  return names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 90 + 10);
}

async function startGame() {
  menuError.textContent = '';
  const name = (nameInput.value || randomName()).trim();
  const room = (roomInput.value || 'downtown').trim();
  playBtn.disabled = true;
  playBtn.textContent = 'CONNECTING…';
  try {
    await game.start(name, room);
    menu.classList.add('hidden');
    hudEl.classList.remove('hidden');
    game.hud.toast('Welcome to the city. Grab the package for cash.', 'good');
  } catch (err) {
    menuError.textContent = `Could not connect: ${err}. Is the server running on this host?`;
    playBtn.disabled = false;
    playBtn.textContent = 'ENTER THE CITY';
  }
}

// scratch vectors (module-scope; methods only touch these at runtime)
const tmpVec = new THREE.Vector3();

// Mobile hint
if ('ontouchstart' in window && window.innerWidth < 900) {
  document.getElementById('mobileHint')?.classList.remove('hidden');
}
