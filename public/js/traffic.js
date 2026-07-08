// ============================================================
// traffic.js — AI road traffic.
// Each TrafficVehicle picks a destination graph node, drives toward
// it along the road edge keeping to the right lane, then at the node
// picks a new random neighbour (no U-turns). It slows for vehicles
// ahead via a simple forward raycast. Spawn/despawn happens relative
// to the player to cap population and keep perf stable.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { Vehicle } from './vehicles.js';
import { distXZ, pick } from './utils.js';

export class TrafficVehicle extends Vehicle {
  constructor(scene, city) {
    super(scene, city, pick(['sedan', 'sedan', 'sports', 'truck']));
    this.kind = 'traffic';
    this.mesh.userData.entity = this;
    this.fromNode = null;
    this.toNode = null;
    this.targetSpeed = CONFIG.traffic.targetSpeed * (0.7 + Math.random() * 0.6);
    this._brake = 0;
  }

  setRoute(from, to) {
    this.fromNode = from;
    this.toNode = to;
  }

  /**
   * @param dt
   * @param allVehicles array of vehicles (incl. player-driven) for brake check
   */
  updateAI(dt, allVehicles) {
    if (!this.toNode || this.disabled) {
      super.update(dt, { throttle: 0, steer: 0 });
      return;
    }

    // target point = toNode position offset to right-hand lane relative to travel dir
    const dirX = this.toNode.pos.x - this.fromNode.pos.x;
    const dirZ = this.toNode.pos.z - this.fromNode.pos.z;
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len, uz = dirZ / len;
    // right normal (rotate -90): (uz, -ux)
    const lane = CONFIG.world.roadWidth * 0.22;
    const tx = this.toNode.pos.x + uz * lane;
    const tz = this.toNode.pos.z - ux * lane;

    // steering toward target
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const targetYaw = Math.atan2(dx, dz);
    let dYaw = targetYaw - this.yaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, dYaw * 2.5));

    // lookahead collision brake
    let blocked = this._lookaheadBlocked(allVehicles);

    // throttle: ease toward target speed, brake if blocked or near end of edge
    const distToNode = distXZ(this.pos.x, this.pos.z, this.toNode.pos.x, this.toNode.pos.z);
    const vForward = this.vel.x * Math.sin(this.yaw) + this.vel.z * Math.cos(this.yaw);
    let throttle = 1;
    if (blocked) throttle = -0.6; // brake/reverse-feel
    else if (distToNode < CONFIG.traffic.brakeDistance) throttle = 0.2;

    super.update(dt, { throttle, steer, handbrake: false });

    // reached node?
    if (distToNode < CONFIG.world.cellSize * 0.35) {
      this._pickNextNode();
    }
  }

  _lookaheadBlocked(allVehicles) {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const la = CONFIG.traffic.lookahead;
    const ax = this.pos.x + fx * 2.2, az = this.pos.z + fz * 2.2;
    const bx = ax + fx * la, bz = az + fz * la;
    for (const v of allVehicles) {
      if (v === this) continue;
      // distance from vehicle center to segment (approx as point-line)
      const px = v.pos.x - ax, pz = v.pos.z - az;
      const t = Math.max(0, Math.min(la, px * fx + pz * fz));
      const cx = ax + fx * t, cz = az + fz * t;
      const d = Math.hypot(v.pos.x - cx, v.pos.z - cz);
      if (d < 2.4 && t < la) return true;
    }
    return false;
  }

  _pickNextNode() {
    const cur = this.toNode;
    if (!cur) return;
    // avoid reversing unless dead-end
    const cameFrom = this.fromNode;
    const options = cur.neighbors
      .filter(n => n.node !== cameFrom)
      .map(n => n.node);
    const pool = options.length ? options : cur.neighbors.map(n => n.node);
    const next = pick(pool);
    this.fromNode = cur;
    this.toNode = next;
  }

  takeDamage(amount) {
    super.takeDamage(amount);
    // crashed traffic becomes stationary obstacle
  }
}

export class TrafficManager {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.vehicles = [];
  }

  update(dt, playerPos, playerVehicle, allDynamicVehicles = []) {
    const cfg = CONFIG.traffic;

    // despawn far vehicles
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (distXZ(v.pos.x, v.pos.z, playerPos.x, playerPos.z) > cfg.despawnDistance) {
        v.dispose();
        this.vehicles.splice(i, 1);
      }
    }

    // spawn near player up to cap
    while (this.vehicles.length < cfg.maxVehicles) {
      const v = this._spawnNear(playerPos);
      if (!v) break;
      this.vehicles.push(v);
    }

    // all vehicles traffic AI considers (incl. player-driven car) for braking
    const all = this.vehicles.slice();
    if (playerVehicle) all.push(playerVehicle);
    for (const v of all) allDynamicVehicles.push(v); // for entity collisions

    for (const v of this.vehicles) v.updateAI(dt, all);
  }

  _spawnNear(playerPos) {
    const g = this.city.roadGraph;
    // pick a node near the player but offscreen-ish (within spawn ring)
    for (let tries = 0; tries < 12; tries++) {
      const node = g.nodes[Math.floor(Math.random() * g.nodes.length)];
      const d = distXZ(node.pos.x, node.pos.z, playerPos.x, playerPos.z);
      if (d < 30 || d > CONFIG.traffic.spawnDistance) continue;
      if (!node.neighbors.length) continue;
      const to = node.neighbors[Math.floor(Math.random() * node.neighbors.length)].node;
      const v = new TrafficVehicle(this.scene, this.city);
      v.setRoute(node, to);
      v.place(new THREE.Vector3(node.pos.x, 0, node.pos.z), Math.atan2(to.pos.x - node.pos.x, to.pos.z - node.pos.z));
      return v;
    }
    return null;
  }
}
