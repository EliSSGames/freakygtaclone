// ============================================================
// camera.js — third-person orbit camera with collision pull-in
// Owns yaw/pitch from mouse, follows a target position, and adapts
// distance/height depending on whether the player is on foot or
// driving. Adapts smoothly between modes.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { clamp, damp } from './utils.js';

export class CameraController {
  constructor(camera, scene) {
    this.camera = camera;
    this.scene = scene;

    this.yaw = 0;       // around Y
    this.pitch = 0;     // up/down (negative looks up)
    this.target = new THREE.Vector3(0, 1.7, 0);

    this.curDistance = CONFIG.camera.thirdPersonDistance;
    this.curHeight = CONFIG.camera.thirdPersonHeight;

    // a raycaster used to pull the camera in when it'd clip a wall
    this._ray = new THREE.Raycaster();
    this._ray.far = 30;
    this._colliderObjects = []; // populated by City (building meshes)
  }

  setColliders(arr) { this._colliderObjects = arr; }

  /** Apply mouse/touch delta. */
  look(dx, dy) {
    this.yaw -= dx * CONFIG.camera.mouseSensitivity;
    this.pitch = clamp(
      this.pitch - dy * CONFIG.camera.mouseSensitivity,
      CONFIG.camera.minPitch,
      CONFIG.camera.maxPitch
    );
  }

  /** Snap instantly to behind a heading (e.g. on spawn / enter vehicle). */
  snapBehind(headingYaw) {
    this.yaw = headingYaw;
    this.pitch = -0.2;
  }

  /**
   * @param {THREE.Vector3} targetPos  where the camera orbits around
   * @param {object} opts
   *   - driving: boolean (use car distance/height)
   *   - desiredYaw: optional override (e.g. align behind car)
   *   - dt: delta seconds
   */
  update(targetPos, { driving = false, desiredYaw = null, dt } = {}) {
    // smooth target follow
    this.target.lerp(targetPos, 1 - Math.exp(-CONFIG.camera.followLerp * dt));

    const wantDist = driving ? CONFIG.camera.carDistance : CONFIG.camera.thirdPersonDistance;
    const wantHeight = driving ? CONFIG.camera.carHeight : CONFIG.camera.thirdPersonHeight;
    this.curDistance = damp(this.curDistance, wantDist, 8, dt);
    this.curHeight = damp(this.curHeight, wantHeight, 8, dt);

    if (desiredYaw !== null) {
      // gently align behind vehicle
      let d = desiredYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * (1 - Math.exp(-6 * dt));
    }

    // spherical -> cartesian offset
    const cp = Math.cos(this.pitch);
    const ox = Math.sin(this.yaw) * cp;
    const oz = Math.cos(this.yaw) * cp;
    const oy = -Math.sin(this.pitch); // pitch negative looks down a bit

    let dist = this.curDistance;
    // wall collision pull-in: cast from target toward desired cam pos
    if (this._colliderObjects.length) {
      const dir = tmp.set(ox, oy, oz).normalize();
      this._ray.set(this.target, dir);
      this._ray.far = dist + 0.5;
      const hits = this._ray.intersectObjects(this._colliderObjects, false);
      if (hits.length) {
        dist = Math.max(1.4, hits[0].distance - 0.5);
      }
    }

    const camX = this.target.x + ox * dist;
    const camY = this.target.y + (oy * dist) + this.curHeight * 0.4 + this.curHeight;
    const camZ = this.target.z + oz * dist;

    // smoother camera height using a separate damp
    this.camera.position.x = damp(this.camera.position.x, camX, 14, dt);
    this.camera.position.y = damp(this.camera.position.y, camY, 14, dt);
    this.camera.position.z = damp(this.camera.position.z, camZ, 14, dt);

    this.camera.lookAt(this.target.x, this.target.y + (driving ? 1.2 : 0.2), this.target.z);
  }
}

const tmp = new THREE.Vector3();
