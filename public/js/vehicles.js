// ============================================================
// vehicles.js — drivable vehicles + arcade driving physics.
// Each Vehicle has a body (Box), wheels (visual), and a simple
// kinematic bicycle-ish model: throttle/brake along facing dir,
// steering changes yaw scaled by speed, lateral grip damps drift.
// Collisions resolved against building AABBs and other vehicles.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { clamp, damp, approachAngle } from './utils.js';

const PALETTE = [0x8a1f1f, 0x1f3a8a, 0x1f8a3a, 0xb0b0b0, 0xd0a020, 0x222222, 0x6a4a2a, 0x4a4a8a];

export class Vehicle {
  constructor(scene, city, type = 'sedan') {
    this.scene = scene;
    this.city = city;
    this.type = type;
    this.spec = CONFIG.vehicle[type] || CONFIG.vehicle.sedan;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();    // world-space velocity
    this.yaw = 0;                      // heading
    this.steer = 0;                    // -1..1 current steer input
    this.throttle = 0;                 // -1..1
    this.handbrake = false;
    this.health = this.spec.health;
    this.disabled = false;
    this.id = `veh_${Math.random().toString(36).slice(2, 8)}`;
    this.driver = null;                // socket id or 'local'
    this.kind = 'car';                 // overridden to 'traffic' by TrafficVehicle

    this._buildMesh();
    // tag the root mesh so weapon hitscan can resolve which entity was hit
    this.mesh.userData.entity = this;
  }

  _buildMesh() {
    const g = new THREE.Group();
    const s = this.spec;
    const bodyColor = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.45, metalness: 0.5 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x10131a, roughness: 0.2, metalness: 0.3, transparent: true, opacity: 0.85 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });

    // lower body
    const body = new THREE.Mesh(new THREE.BoxGeometry(s.width, s.height * 0.55, s.length), bodyMat);
    body.position.y = s.height * 0.45;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    // cabin
    const cabH = s.height * 0.45;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.9, cabH, s.length * 0.5), bodyMat);
    cab.position.set(0, s.height * 0.55 + cabH / 2, -s.length * 0.05);
    cab.castShadow = true;
    g.add(cab);

    // windshield + windows strip
    const glass = new THREE.Mesh(new THREE.BoxGeometry(s.width * 0.92, cabH * 0.7, s.length * 0.52), glassMat);
    glass.position.copy(cab.position); glass.position.y += 0.02;
    g.add(glass);

    // headlights
    const hlMat = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xffe08a, emissiveIntensity: 0.7 });
    for (const sx of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.18, 0.1), hlMat);
      hl.position.set(sx * s.width * 0.32, s.height * 0.45, s.length / 2);
      g.add(hl);
    }
    // taillights
    const tlMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 0.5 });
    for (const sx of [-1, 1]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.16, 0.1), tlMat);
      tl.position.set(sx * s.width * 0.32, s.height * 0.45, -s.length / 2);
      g.add(tl);
    }

    // wheels
    this.wheels = [];
    const wR = s.height * 0.32;
    const wheelGeo = new THREE.CylinderGeometry(wR, wR, 0.3, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    const wx = s.width * 0.5;
    const wz = s.length * 0.32;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(sx * wx, wR, sz * wz);
      g.add(w);
      this.wheels.push({ mesh: w, steerable: sz > 0 });
    }

    this.mesh = g;
    this.body = body;
    this.mesh.userData.vehicle = this;
    this.mesh.userData.entity = this;
    scene.add(this.mesh);
  }

  place(pos, yaw) {
    this.pos.copy(pos); this.pos.y = 0;
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;
  }

  takeDamage(amount) {
    if (this.disabled) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0) this._disable();
  }

  _disable() {
    this.disabled = true;
    this.throttle = 0;
    // smoke color tint (cheap effect)
    this.body.material = this.body.material.clone();
    this.body.material.color.setHex(0x333333);
    this.body.material.emissive = new THREE.Color(0x331100);
    this.body.material.emissiveIntensity = 0.4;
  }

  /**
   * @param {number} dt
   * @param {object} input {throttle:-1..1, steer:-1..1, handbrake:bool}
   */
  update(dt, input) {
    const s = this.spec;
    this.throttle = clamp(input.throttle || 0, -1, 1);
    this.steer = damp(this.steer, clamp(input.steer || 0, -1, 1), 10, dt);
    this.handbrake = !!input.handbrake;

    if (this.disabled) {
      this.throttle = 0;
    }

    // forward unit from yaw (forward = +Z in local; we model yaw around Y)
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    // current speed along facing
    let vForward = this.vel.x * fx + this.vel.z * fz;
    let vSide = this.vel.x * fz - this.vel.z * fx;

    // throttle/brake
    if (this.throttle > 0) vForward += s.accel * this.throttle * dt;
    else if (this.throttle < 0) {
      if (vForward > 0.2) vForward -= s.brake * dt;            // braking
      else vForward += s.accel * this.throttle * dt;            // reverse
    }
    // rolling resistance / drag
    vForward -= vForward * s.drag * dt;
    // clamp
    const maxF = vForward < 0 ? s.reverseMax : s.maxSpeed;
    vForward = clamp(vForward, -s.reverseMax, s.maxSpeed);

    // lateral grip (reduce sideways slide). handbrake cuts grip -> drift.
    const grip = this.handbrake ? s.grip * 0.25 : s.grip;
    vSide = damp(vSide, 0, grip, dt);

    // steering: yaw rate scales with speed sign so reversing steers correctly
    const speedFactor = clamp(Math.abs(vForward) / 8, 0, 1);
    const yawRate = this.steer * s.steer * speedFactor * Math.sign(vForward || 1);
    this.yaw += yawRate * dt;

    // recompose world velocity
    const nx = fx * vForward + fz * vSide;
    const nz = fz * vForward - fx * vSide;
    this.vel.x = nx;
    this.vel.z = nz;

    // integrate with building collision (axis-separated)
    this._moveAxis('x', this.vel.x * dt);
    this._moveAxis('z', this.vel.z * dt);

    // sync mesh
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.yaw;

    // wheel spin visual
    const roll = vForward * dt * 2;
    const steerVis = this.steer * 0.4;
    for (const w of this.wheels) {
      w.mesh.rotation.x = (w.mesh.rotation.x || 0) + roll;
      if (w.steerable) w.mesh.rotation.y = steerVis;
    }
  }

  _moveAxis(axis, delta) {
    if (delta === 0) return;
    this.pos[axis] += delta;
    const s = this.spec;
    const r = Math.max(s.width, s.length) / 2;
    for (const box of this.city.buildingBoxes) {
      if (this._overlapsBox(box)) {
        if (axis === 'x') {
          this.pos.x = delta > 0 ? box.min.x - r - 0.05 : box.max.x + r + 0.05;
          // bleed speed (crash)
          this.vel.x *= -0.25;
          this._crashDamage(Math.abs(this.vel.x) + Math.abs(delta));
        } else {
          this.pos.z = delta > 0 ? box.min.z - r - 0.05 : box.max.z + r + 0.05;
          this.vel.z *= -0.25;
          this._crashDamage(Math.abs(this.vel.z) + Math.abs(delta));
        }
      }
    }
    const lim = CONFIG.world.halfExtent + 6;
    if (axis === 'x') this.pos.x = clamp(this.pos.x, -lim, lim);
    if (axis === 'z') this.pos.z = clamp(this.pos.z, -lim, lim);
  }

  _overlapsBox(box) {
    const s = this.spec;
    // approximate car as AABB of its full footprint (ignore rotation for cheapness)
    const hx = s.width / 2 + 0.2, hz = s.length / 2 + 0.2;
    return (
      this.pos.x + hx > box.min.x && this.pos.x - hx < box.max.x &&
      this.pos.z + hz > box.min.z && this.pos.z - hz < box.max.z &&
      box.max.y > 0.4
    );
  }

  _crashDamage(impact) {
    if (impact > 6) {
      this.takeDamage(impact * 0.8);
      return true;
    }
    return false;
  }

  /** Forward direction unit vector (world space). */
  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  dispose() {
    this.scene.remove(this.mesh);
  }
}

/**
 * Spawns a set of parked vehicles near roads for the player to enter.
 */
export function spawnTrafficSeed(scene, city, count = 14) {
  const types = Object.keys(CONFIG.vehicle);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = types[Math.floor(Math.random() * types.length)];
    const v = new Vehicle(scene, city, t);
    // place near a random node, offset to the road
    const node = city.randomNode();
    const angle = Math.random() * Math.PI * 2;
    const off = 3;
    v.place(
      new THREE.Vector3(node.pos.x + Math.cos(angle) * off, 0, node.pos.z + Math.sin(angle) * off),
      Math.random() * Math.PI * 2
    );
    out.push(v);
  }
  return out;
}
