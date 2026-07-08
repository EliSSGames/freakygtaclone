// ============================================================
// entities.js — central registry of dynamic, damageable entities.
// Provides a single place for the weapon hitscan and vehicle
// collision code to query "what can I hit / collide with right now?"
// Each entity should set `mesh.userData.entity = this` and expose
// `kind`, `id`, and `takeDamage(n)`.
// ============================================================

export class Entities {
  constructor() {
    /** @type {Set<object>} dynamic entities (peds, cops, traffic, remote cars, parked vehicles) */
    this.dynamic = new Set();
  }

  register(e) { this.dynamic.add(e); }
  unregister(e) { this.dynamic.delete(e); }

  /** Meshes for weapon raycast (each entity root mesh). */
  hitTargets() {
    const out = [];
    for (const e of this.dynamic) {
      if (e.mesh && e.alive !== false) out.push(e);
    }
    return out;
  }

  /** All dynamic vehicle-like obstacles for car-vs-car collision. */
  vehicles() {
    const out = [];
    for (const e of this.dynamic) {
      if (e.type === 'vehicle' || e.kind === 'traffic' || e.kind === 'car') out.push(e);
    }
    return out;
  }

  /** Per-frame maintenance: drop dead/disposed entities. */
  prune() {
    for (const e of this.dynamic) {
      if (e._removeFlag || e._disposed) this.dynamic.delete(e);
    }
  }
}
