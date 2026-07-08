// ============================================================
// player.js — local player character (on-foot mode).
// Handles: walk/run/jump, gravity, AABB collision against buildings,
// animation-state labels, health/armor, and the visual mesh.
//
// Driving is handled by the Vehicle system; the player switches its
// "mode" between ON_FOOT and DRIVING. This class owns ON_FOOT only.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { clamp, damp } from './utils.js';

const STATE = { IDLE: 'idle', WALK: 'walk', RUN: 'run', JUMP: 'jump', FALL: 'fall' };

export class Player {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;          // facing direction
    this.onGround = true;
    this.state = STATE.IDLE;
    this.prevState = STATE.IDLE;

    this.health = CONFIG.player.maxHealth;
    this.armor = 0;
    this.alive = true;
    this.respawnTimer = 0;

    // input intent (set each frame by Game from Input)
    this.intent = { forward: 0, right: 0, run: false, jump: false };

    this._buildMesh();
  }

  _buildMesh() {
    // Simple humanoid from primitives: torso, head, limbs.
    // Color stands out for the local player; remote players tint differently.
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98a5b, roughness: 0.8 });
    const jacket = new THREE.MeshStandardMaterial({ color: 0x2b3a55, roughness: 0.7 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.8 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.9 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4), jacket);
    torso.position.y = 1.15;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), skin);
    head.position.y = 1.85;
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.85, 0.2), jacket);
    armL.position.set(-0.46, 1.18, 0);
    const armR = armL.clone(); armR.position.x = 0.46;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.85, 0.26), pants);
    legL.position.set(-0.18, 0.45, 0);
    const legR = legL.clone(); legR.position.x = 0.18;
    // shoes
    const shoeL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.34), shoe);
    shoeL.position.set(-0.18, 0.07, 0.04);
    const shoeR = shoeL.clone(); shoeR.position.x = 0.18;

    for (const m of [torso, head, armL, armR, legL, legR, shoeL, shoeR]) {
      m.castShadow = true;
      g.add(m);
    }
    this.mesh = g;
    this.parts = { torso, head, armL, armR, legL, legR, shoeL, shoeR };
    this.scene.add(this.mesh);
  }

  /** Place the player at a spawn point (road intersection center). */
  spawn(pos) {
    this.pos.copy(pos);
    this.pos.y = 0;
    this.vel.set(0, 0, 0);
    this.health = CONFIG.player.maxHealth;
    this.armor = 0;
    this.alive = true;
    this.respawnTimer = 0;
    this.onGround = true;
    this.state = STATE.IDLE;
    this.mesh.visible = true;
  }

  takeDamage(amount) {
    if (!this.alive) return;
    // armor absorbs first
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, amount * 0.6);
      this.armor -= absorbed;
      amount -= absorbed;
    }
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this._die();
  }

  _die() {
    this.alive = false;
    this.respawnTimer = 3.0;
    this.mesh.visible = false;
  }

  /** Returns true if a weapon-fire pose is valid (alive + grounded check up to caller). */
  canAct() { return this.alive; }

  /**
   * @param {number} dt delta seconds
   * @param {object} cameraYaw for movement basis (relative to camera)
   */
  update(dt, cameraYaw) {
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        // respawn near a road node
        const node = this.city.randomNode();
        this.spawn(node.pos);
      }
      return;
    }

    const p = CONFIG.player;
    const intent = this.intent;

    // build movement basis from camera yaw
    const sin = Math.sin(cameraYaw), cos = Math.cos(cameraYaw);
    // forward = -Z in camera space; right = +X
    let mx = intent.forward * -sin + intent.right * cos;
    let mz = intent.forward * -cos + intent.right * -sin;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) { mx /= mag; mz /= mag; }

    const speed = intent.run ? p.runSpeed : p.walkSpeed;
    const desiredVX = mx * speed;
    const desiredVZ = mz * speed;

    const accel = this.onGround ? p.accelGround : p.accelAir;
    this.vel.x = damp(this.vel.x, desiredVX, accel / Math.max(speed, 0.1), dt);
    this.vel.z = damp(this.vel.z, desiredVZ, accel / Math.max(speed, 0.1), dt);

    // jump
    if (intent.jump && this.onGround) {
      this.vel.y = p.jumpSpeed;
      this.onGround = false;
    }

    // gravity
    this.vel.y -= p.gravity * dt;

    // integrate with per-axis AABB collision against buildings
    this._moveAxis('x', this.vel.x * dt);
    this._moveAxis('z', this.vel.z * dt);
    this._moveAxis('y', this.vel.y * dt);

    // ground
    if (this.pos.y <= 0) {
      this.pos.y = 0;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.vel.y < -0.1) {
      this.onGround = false;
    }

    // facing: turn toward velocity if moving
    if (mag > 0.05) {
      const targetYaw = Math.atan2(mx, mz);
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-12 * dt));
    }

    // animation state label
    this.prevState = this.state;
    if (!this.onGround) this.state = this.vel.y > 0.3 ? STATE.JUMP : STATE.FALL;
    else if (mag > 0.05) this.state = intent.run ? STATE.RUN : STATE.WALK;
    else this.state = STATE.IDLE;

    // visual sync
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    this._animate(dt);
  }

  _moveAxis(axis, delta) {
    if (delta === 0) return;
    const r = CONFIG.player.radius;
    this.pos[axis] += delta;
    // resolve against building AABBs
    for (const box of this.city.buildingBoxes) {
      if (this._overlapsBox(box, r)) {
        // push out along axis
        if (axis === 'x') {
          this.pos.x = delta > 0 ? box.min.x - r - 0.001 : box.max.x + r + 0.001;
          this.vel.x = 0;
        } else if (axis === 'z') {
          this.pos.z = delta > 0 ? box.min.z - r - 0.001 : box.max.z + r + 0.001;
          this.vel.z = 0;
        } else {
          // y: stand on top or bonk head
          if (delta > 0) { // moving up = head bonk
            this.pos.y = box.min.y - 0.001;
            this.vel.y = 0;
          } else {
            this.pos.y = box.max.y;
            this.vel.y = 0;
            this.onGround = true;
          }
        }
      }
    }
    // world bounds
    const lim = CONFIG.world.halfExtent + 4;
    if (axis === 'x') this.pos.x = clamp(this.pos.x, -lim, lim);
    if (axis === 'z') this.pos.z = clamp(this.pos.z, -lim, lim);
  }

  _overlapsBox(box, r) {
    const p = this.pos;
    // treat player as an AABB of size 2r around pos, height ~1.8
    return (
      p.x + r > box.min.x && p.x - r < box.max.x &&
      p.z + r > box.min.z && p.z - r < box.max.z &&
      p.y + 1.8 > box.min.y && p.y < box.max.y
    );
  }

  // crude procedural limb swing for walk/run
  _animate(dt) {
    this._t = (this._t || 0) + dt;
    const swing = (this.state === STATE.WALK || this.state === STATE.RUN) ? 1 : 0;
    const sp = this.state === STATE.RUN ? 14 : 9;
    const a = Math.sin(this._t * sp) * (swing ? (this.state === STATE.RUN ? 0.9 : 0.5) : 0);
    this.parts.legL.rotation.x = a;
    this.parts.legR.rotation.x = -a;
    this.parts.armL.rotation.x = -a * 0.7;
    this.parts.armR.rotation.x = a * 0.7;
    // idle breathing
    if (!swing) {
      this.parts.torso.position.y = 1.15 + Math.sin(this._t * 2) * 0.01;
    }
  }
}

export const PlayerState = STATE;
