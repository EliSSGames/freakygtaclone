// ============================================================
// pedestrians.js — ambient NPC pedestrians.
// Wander on sidewalk rings around blocks; flee from gunfire / crime
// when the player or a loud event is nearby. Can be hit by vehicles
// and weapons (raises wanted level). Purely client-side for ambience
// (server doesn't sync them — they're decorative).
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { distXZ, mulberry32, damp, approachAngle } from './utils.js';

const PALETTE = [0x9a6a4a, 0x6a7a9a, 0x8a8a6a, 0x7a5a8a, 0x5a8a7a, 0xaa6a6a];

export class Pedestrian {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.state = 'walk'; // walk | flee | panic
    this.speed = CONFIG.peds.walkSpeed * (0.8 + Math.random() * 0.4);
    this.alive = true;
    this.health = 30;
    this.id = `ped_${Math.random().toString(36).slice(2, 8)}`;
    this.kind = 'ped';
    this._t = Math.random() * 10;
    this._target = new THREE.Vector3();
    this._pickWanderTarget();
    this._buildMesh();
    this.mesh.userData.entity = this;
  }

  _buildMesh() {
    const g = new THREE.Group();
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const jacket = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x202028, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98a5b, roughness: 0.8 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.65, 0.3), jacket);
    torso.position.y = 1.05;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skin);
    head.position.y = 1.55;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.7, 0.2), pants);
    legL.position.set(-0.12, 0.35, 0);
    const legR = legL.clone(); legR.position.x = 0.12;
    for (const m of [torso, head, legL, legR]) { m.castShadow = true; g.add(m); }
    this.mesh = g;
    this.parts = { torso, head, legL, legR };
    this.scene.add(this.mesh);
  }

  _pickWanderTarget() {
    // wander to a nearby random point on a sidewalk (offset from nearest node)
    const node = this.city.nearestNode(this.pos);
    const ang = Math.random() * Math.PI * 2;
    const rad = CONFIG.world.roadWidth * 0.6 + 2;
    this._target.set(
      node.pos.x + Math.cos(ang) * rad,
      0,
      node.pos.z + Math.sin(ang) * rad
    );
  }

  panicFrom(epicenter) {
    if (!this.alive) return;
    this.state = 'flee';
    this._panicTimer = 4 + Math.random() * 3;
    // run away from epicenter
    const dx = this.pos.x - epicenter.x;
    const dz = this.pos.z - epicenter.z;
    const len = Math.hypot(dx, dz) || 1;
    this._target.set(this.pos.x + (dx / len) * 14, 0, this.pos.z + (dz / len) * 14);
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    this.panicFrom(this.pos);
    if (this.health <= 0) this._die();
  }

  _die() {
    this.alive = false;
    this.mesh.rotation.z = Math.PI / 2;
    this.mesh.position.y = 0.3;
    this._deadTimer = 6;
  }

  update(dt, playerPos) {
    this._t += dt;
    if (!this.alive) {
      this._deadTimer -= dt;
      if (this._deadTimer <= 0) this._removeFlag = true;
      return;
    }

    // state transitions
    if (this.state === 'flee') {
      this._panicTimer -= dt;
      if (this._panicTimer <= 0) { this.state = 'walk'; this._pickWanderTarget(); }
    } else {
      // occasionally repick wander target
      if (Math.random() < 0.005) this._pickWanderTarget();
    }

    const speed = this.state === 'flee' ? CONFIG.peds.fleeSpeed : this.speed;
    const dx = this._target.x - this.pos.x;
    const dz = this._target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.2) {
      this._pickWanderTarget();
    } else {
      const ux = dx / dist, uz = dz / dist;
      this.pos.x += ux * speed * dt;
      this.pos.z += uz * speed * dt;
      const ty = Math.atan2(ux, uz);
      this.yaw = approachAngle(this.yaw, ty, 6 * dt);
    }

    // building collision (push out)
    for (const box of this.city.buildingBoxes) {
      if (
        this.pos.x > box.min.x - 0.4 && this.pos.x < box.max.x + 0.4 &&
        this.pos.z > box.min.z - 0.4 && this.pos.z < box.max.z + 0.4 &&
        box.max.y > 0.5
      ) {
        // nudge out toward nearest edge
        const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
        const ddx = this.pos.x - cx, ddz = this.pos.z - cz;
        if (Math.abs(ddx) > Math.abs(ddz)) this.pos.x = ddx > 0 ? box.max.x + 0.5 : box.min.x - 0.5;
        else this.pos.z = ddz > 0 ? box.max.z + 0.5 : box.min.z - 0.5;
        this._pickWanderTarget();
      }
    }

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    // leg swing
    const sw = this.state === 'flee' ? 1.0 : 0.45;
    const a = Math.sin(this._t * (this.state === 'flee' ? 16 : 8)) * sw;
    this.parts.legL.rotation.x = a;
    this.parts.legR.rotation.x = -a;
  }

  dispose() {
    this.scene.remove(this.mesh);
  }
}

export class PedestrianManager {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.peds = [];
    this._rng = mulberry32(99);
  }

  update(dt, playerPos) {
    const cfg = CONFIG.peds;
    // despawn far/dead
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (p._removeFlag || distXZ(p.pos.x, p.pos.z, playerPos.x, playerPos.z) > cfg.despawnDistance) {
        p.dispose();
        this.peds.splice(i, 1);
      }
    }
    // spawn near
    while (this.peds.length < cfg.maxPeds) {
      const p = this._spawnNear(playerPos);
      if (!p) break;
      this.peds.push(p);
    }
    for (const p of this.peds) p.update(dt, playerPos);
  }

  _spawnNear(playerPos) {
    for (let tries = 0; tries < 10; tries++) {
      const node = this.city.roadGraph.nodes[Math.floor(this._rng() * this.city.roadGraph.nodes.length)];
      const d = distXZ(node.pos.x, node.pos.z, playerPos.x, playerPos.z);
      if (d < 25 || d > CONFIG.peds.spawnDistance) continue;
      const p = new Pedestrian(this.scene, this.city);
      const ang = this._rng() * Math.PI * 2;
      const r = CONFIG.world.roadWidth * 0.6 + 1.5;
      p.pos.set(node.pos.x + Math.cos(ang) * r, 0, node.pos.z + Math.sin(ang) * r);
      p._pickWanderTarget();
      return p;
    }
    return null;
  }

  /** Cause nearby peds to flee (e.g. on gunfire). */
  panicNear(epicenter, radius = 30) {
    for (const p of this.peds) {
      if (distXZ(p.pos.x, p.pos.z, epicenter.x, epicenter.z) < radius) p.panicFrom(epicenter);
    }
  }
}
