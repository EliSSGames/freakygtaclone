// ============================================================
// utils.js — shared math helpers, object pool, rng, misc
// Pure functions, no dependencies. Imported widely.
// ============================================================

import * as THREE from 'three';

/** Clamp value into [min,max]. */
export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

/** Linear interpolate. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Smooth approach (frame-rate independent damping). */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Angle difference wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Approach angle a toward b by at most maxStep radians. */
export function approachAngle(a, b, maxStep) {
  const d = angleDelta(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

/** Distance in XZ plane (ignores Y). */
export const distXZ = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** Distance between two Vector3-like {x,y,z}. */
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Mulberry32 deterministic PRNG — small, fast, seedable. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generic object pool. Reuse allocated objects to avoid GC churn in the
 * hot update loop (bullets, raycasters, vector temporaries, etc.).
 */
export class Pool {
  constructor(factory, reset, capacity = 64) {
    this._factory = factory;
    this._reset = reset;
    this._free = [];
    for (let i = 0; i < capacity; i++) this._free.push(factory());
  }
  acquire() {
    return this._free.pop() || this._factory();
  }
  release(obj) {
    if (this._reset) this._reset(obj);
    this._free.push(obj);
  }
}

/** Temporary scratch vectors (avoid per-frame `new THREE.Vector3`). */
export const tmpV1 = new THREE.Vector3();
export const tmpV2 = new THREE.Vector3();
export const tmpV3 = new THREE.Vector3();
export const tmpQ = new THREE.Quaternion();

/** Format seconds as M:SS. */
export function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/** Pick a random element. */
export const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

/** Is the page currently focused/visible? */
export function pageVisible() {
  return !document.hidden && document.hasFocus();
}
