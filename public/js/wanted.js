// ============================================================
// wanted.js — wanted level + police AI.
// WantedSystem: tracks a heat score, maps it to 1..5 stars, decays
//   heat only when the player has been hidden (out of police LOS) for
//   a grace period. Notifies the server (source of truth for peers).
// PoliceManager: spawns cop units proportional to stars near the
//   player, drives them toward the player, and makes them shoot.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { distXZ, clamp, approachAngle } from './utils.js';

export class WantedSystem {
  constructor(game) {
    this.game = game;
    this.heat = 0;
    this.stars = 0;
    this.hiddenTime = 0;       // seconds since last seen by police
    this.lastSeenByPolice = 0;
  }

  /** Add heat from a crime event. */
  add(amount, reason) {
    this.heat = Math.max(0, this.heat + amount);
    this._recompute(reason);
  }

  _recompute(reason) {
    const th = CONFIG.wanted.starThresholds;
    let s = 0;
    for (let i = 1; i < th.length; i++) if (this.heat >= th[i]) s = i;
    if (s !== this.stars) {
      const up = s > this.stars;
      this.stars = s;
      this.game.onWantedChanged(s, up);
      this.game.net.reportWanted(s);
    }
  }

  /** Called each frame; policeSeen = are any cops currently seeing us. */
  update(dt, policeSeen) {
    if (policeSeen) {
      this.hiddenTime = 0;
    } else {
      this.hiddenTime += dt;
      // decay only after grace period, when no police can see us
      if (this.stars > 0 && this.hiddenTime > CONFIG.wanted.hiddenGraceSeconds) {
        this.heat = Math.max(0, this.heat - CONFIG.wanted.decayPerSecWhenHidden * dt);
        this._recompute();
      }
    }
  }

  reset() {
    this.heat = 0;
    this.stars = 0;
    this.hiddenTime = 0;
    this.game.net.reportWanted(0);
  }
}

// ------------------------------------------------------------
// Police unit (on foot). Could be upgraded to cars; kept simple.
// ------------------------------------------------------------
export class Cop {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.health = 80;
    this.alive = true;
    this.id = `cop_${Math.random().toString(36).slice(2, 8)}`;
    this.kind = 'cop';
    this.fireCooldown = 0;
    this.seesPlayer = false;
    this._t = 0;
    this._buildMesh();
    this.mesh.userData.entity = this;
  }

  _buildMesh() {
    const g = new THREE.Group();
    const blue = new THREE.MeshStandardMaterial({ color: 0x14264a, roughness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x101216, roughness: 0.8 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xc98a5b, roughness: 0.8 });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.32), blue);
    torso.position.y = 1.1;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skin);
    head.position.y = 1.6;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.28), dark);
    cap.position.y = 1.76;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.22), dark);
    legL.position.set(-0.13, 0.38, 0);
    const legR = legL.clone(); legR.position.x = 0.13;
    // siren light on shoulder for visibility
    const siren = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x3a7bff, emissive: 0x2266ff, emissiveIntensity: 1 })
    );
    siren.position.set(0.28, 1.4, 0);
    for (const m of [torso, head, cap, legL, legR, siren]) { m.castShadow = true; g.add(m); }
    this.siren = siren;
    this.parts = { torso, head, legL, legR };
    this.mesh = g;
    this.scene.add(this.mesh);
  }

  place(pos) {
    this.pos.copy(pos); this.pos.y = 0;
  }

  takeDamage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) this._die();
  }

  _die() {
    this.alive = false;
    this.mesh.rotation.z = Math.PI / 2;
    this.mesh.position.y = 0.3;
    this._deadTimer = 8;
  }

  update(dt, target, wanted) {
    this._t += dt;
    // flash siren
    this.siren.material.emissiveIntensity = 1 + Math.sin(this._t * 10) * 0.8;

    if (!this.alive) {
      this._deadTimer -= dt;
      if (this._deadTimer <= 0) this._removeFlag = true;
      return;
    }

    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const ty = Math.atan2(dx, dz);
    this.yaw = approachAngle(this.yaw, ty, 6 * dt);

    // line of sight: blocked if a building is between (cheap raycast on boxes)
    this.seesPlayer = dist < CONFIG.police.shootRange + 10 && this._hasLOS(target);

    const moveSpeed = wanted >= 3 ? CONFIG.police.chaseSpeed : CONFIG.police.moveSpeed;
    if (dist > 6 && this.seesPlayer) {
      this.pos.x += (dx / dist) * moveSpeed * dt;
      this.pos.z += (dz / dist) * moveSpeed * dt;
    } else if (!this.seesPlayer && dist < 40) {
      // move toward last known direction slowly
      this.pos.x += (dx / dist) * (moveSpeed * 0.5) * dt;
      this.pos.z += (dz / dist) * (moveSpeed * 0.5) * dt;
    }

    // building collision push-out
    for (const box of this.city.buildingBoxes) {
      if (
        this.pos.x > box.min.x - 0.4 && this.pos.x < box.max.x + 0.4 &&
        this.pos.z > box.min.z - 0.4 && this.pos.z < box.max.z + 0.4 &&
        box.max.y > 0.6
      ) {
        const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
        const ddx = this.pos.x - cx, ddz = this.pos.z - cz;
        if (Math.abs(ddx) > Math.abs(ddz)) this.pos.x = ddx > 0 ? box.max.x + 0.5 : box.min.x - 0.5;
        else this.pos.z = ddz > 0 ? box.max.z + 0.5 : box.min.z - 0.5;
      }
    }

    // shooting
    this.fireCooldown -= dt;
    if (this.seesPlayer && dist < CONFIG.police.shootRange && this.fireCooldown <= 0) {
      this.fireCooldown = CONFIG.police.fireRate * (0.7 + Math.random() * 0.6);
      this._shoot(target, dist);
    }

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
    // run anim
    const a = Math.sin(this._t * 12) * 0.6;
    this.parts.legL.rotation.x = a;
    this.parts.legR.rotation.x = -a;
  }

  _hasLOS(target) {
    // sample along the segment cop->target; if any point is inside a building box, blocked
    const steps = 8;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = this.pos.x + (target.x - this.pos.x) * t;
      const z = this.pos.z + (target.z - this.pos.z) * t;
      for (const box of this.city.buildingBoxes) {
        if (x > box.min.x && x < box.max.x && z > box.min.z && z < box.max.z && box.max.y > 1.5) {
          return false;
        }
      }
    }
    return true;
  }

  _shoot(target, dist) {
    // accuracy falls off with distance
    const acc = CONFIG.police.accuracy * (1 - clamp(dist / CONFIG.police.shootRange, 0, 1) * 0.6);
    const hit = Math.random() < acc;
    if (hit) {
      // apply damage locally + report (player is local victim)
      this.scene.userData.game?.onCopHitPlayer(CONFIG.police.damage);
    }
    // FX tracer
    this.scene.userData.game?.spawnLine(
      new THREE.Vector3(this.pos.x, 1.4, this.pos.z),
      new THREE.Vector3(target.x, 1.2, target.z),
      0xff5533
    );
  }

  dispose() { this.scene.remove(this.mesh); }
}

export class PoliceManager {
  constructor(scene, city, wanted, game) {
    this.scene = scene;
    this.city = city;
    this.wanted = wanted;
    this.game = game;
    this.cops = [];
    scene.userData.game = game; // for cop FX callback
  }

  update(dt, playerPos) {
    const cfg = CONFIG.police;
    const stars = this.wanted.stars;
    const wantCount = cfg.unitsPerStar[stars] || 0;

    // despawn if no wanted or too far
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      if (
        c._removeFlag ||
        stars === 0 ||
        distXZ(c.pos.x, c.pos.z, playerPos.x, playerPos.z) > cfg.despawnDistance
      ) {
        c.dispose();
        this.cops.splice(i, 1);
      }
    }

    // spawn to meet quota (near player, offscreen ring)
    while (this.cops.length < wantCount) {
      const c = this._spawnNear(playerPos);
      if (!c) break;
      this.cops.push(c);
    }

    // update + compute "seen" aggregate
    let anySee = false;
    for (const c of this.cops) {
      c.update(dt, playerPos, stars);
      if (c.seesPlayer) anySee = true;
    }
    return anySee;
  }

  _spawnNear(playerPos) {
    for (let tries = 0; tries < 10; tries++) {
      const node = this.city.roadGraph.nodes[Math.floor(Math.random() * this.city.roadGraph.nodes.length)];
      const d = distXZ(node.pos.x, node.pos.z, playerPos.x, playerPos.z);
      if (d < 30 || d > CONFIG.police.spawnDistance) continue;
      const c = new Cop(this.scene, this.city);
      c.place(new THREE.Vector3(node.pos.x, 0, node.pos.z));
      return c;
    }
    return null;
  }
}
