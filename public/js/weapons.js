// ============================================================
// weapons.js — player loadout, hitscan firing, reload, FX.
// Weapon STATS come from shared/config (server-authoritative for
// damage). This class handles client-side feel: fire rate, spread,
// ammo, reload, muzzle flash, tracers, recoil, and raycast hit
// detection against entities. On a hit it reports to the server via
// the provided net callback for authoritative damage.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { clamp } from './utils.js';

export class WeaponSystem {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;

    // loadout
    this.loadout = CONFIG.defaultLoadout.slice();
    this.ammo = {}; // weaponId -> { mag, reserve }
    for (const id of Object.keys(CONFIG.weapons)) {
      const w = CONFIG.weapons[id];
      this.ammo[id] = { mag: w.magSize === Infinity ? Infinity : w.magSize, reserve: w.reserve };
    }
    this.current = 0; // index into loadout

    // fire control
    this.cooldown = 0;
    this.reloading = 0;
    this.firing = false;

    // FX
    this.tracers = [];
    this.flashes = [];
    this._tracerMat = new THREE.LineBasicMaterial({ color: 0xffd070, transparent: true, opacity: 0.9 });
    this._tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);

    // muzzle flash sprite-ish plane
    this._flashMat = new THREE.MeshBasicMaterial({ color: 0xffcc55, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
    this._flashMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), this._flashMat);
    this._flashMesh.visible = false;
    scene.add(this._flashMesh);

    // raycaster for hit detection
    this._ray = new THREE.Raycaster();
  }

  get currentWeapon() {
    return CONFIG.weapons[this.loadout[this.current]];
  }

  get ammoState() {
    return this.ammo[this.loadout[this.current]];
  }

  switchTo(index) {
    if (index < 0 || index >= this.loadout.length) return;
    if (index === this.current) return;
    this.current = index;
    this.reloading = 0;
    this.cooldown = 0.2; // small draw delay
  }

  startFire() { this.firing = true; }
  stopFire() { this.firing = false; }

  reload() {
    const w = this.currentWeapon;
    if (w.type === 'melee') return;
    const a = this.ammoState;
    if (a.mag >= w.magSize || a.reserve <= 0 || this.reloading > 0) return;
    this.reloading = w.reloadTime;
  }

  /**
   * @param dt delta seconds
   * @param origin THREE.Vector3 muzzle world pos
   * @param dir THREE.Vector3 normalized aim dir
   */
  update(dt, origin, dir) {
    this.cooldown -= dt;
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this._finishReload();
    }

    if (this.firing && this.cooldown <= 0) {
      this._tryFire(origin, dir);
    }
    this._updateFX(dt);
  }

  _finishReload() {
    const w = this.currentWeapon;
    const a = this.ammoState;
    const need = w.magSize - a.mag;
    const take = Math.min(need, a.reserve);
    a.mag += take;
    a.reserve -= take;
  }

  _tryFire(origin, dir) {
    const w = this.currentWeapon;
    const a = this.ammoState;
    this.cooldown = w.fireRate;

    if (w.type === 'melee') {
      this._melee(origin, dir);
      this._muzzleFlash(origin, dir);
      return;
    }
    if (a.mag <= 0) {
      // dry fire -> auto reload
      this.reload();
      return;
    }
    a.mag--;

    // spread
    const spread = w.spread;
    const d = dir.clone();
    if (spread > 0) {
      d.x += (Math.random() - 0.5) * spread;
      d.y += (Math.random() - 0.5) * spread;
      d.z += (Math.random() - 0.5) * spread;
      d.normalize();
    }

    this._hitscan(origin, d, w);
    this._muzzleFlash(origin, dir);
    this._recoil();
  }

  _hitscan(origin, dir, w) {
    this._ray.set(origin, dir);
    this._ray.far = w.range;

    // gather candidate targets: world colliders + entities
    const candidates = [];
    // buildings (block bullets)
    candidates.push(...this.game.city.buildingMeshes);
    // entities (vehicles, peds, cops, remote players)
    const ents = this.game.entities.hitTargets();
    for (const e of ents) candidates.push(e.mesh);

    const hits = this._ray.intersectObjects(candidates, true);
    let end = origin.clone().add(dir.clone().multiplyScalar(w.range));
    if (hits.length) {
      const h = hits[0];
      end = h.point.clone();
      this._applyHit(h, dir, w);
    }
    this._spawnTracer(origin, end);
  }

  _applyHit(hit, dir, w) {
    // resolve which entity was hit by walking up parents
    let obj = hit.object;
    let target = null;
    while (obj) {
      if (obj.userData.entity) { target = obj.userData.entity; break; }
      obj = obj.parent;
    }
    if (!target) return; // building hit — could spawn decal, skip for now

    target.takeDamage?.(w.damage);
    this.game.onLocalHit(target, w.damage, hit.point);

    // report to server for authoritative damage + relay
    const victimType = target.kind || 'prop';
    const victimId = target.id || null;
    this.game.net.reportHit({
      weaponId: w.id, victimId, victimType, dmg: w.damage,
      pos: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    });

    // crime: shooting raises heat (handled by Wanted system via game)
    this.game.onWeaponFired(w);
  }

  _melee(origin, dir) {
    this._ray.set(origin, dir);
    this._ray.far = CONFIG.weapons.bat.range;
    const ents = this.game.entities.hitTargets();
    const hits = this._ray.intersectObjects(ents.map(e => e.mesh), true);
    if (hits.length) {
      const h = hits[0];
      let obj = h.object, target = null;
      while (obj) { if (obj.userData.entity) { target = obj.userData.entity; break; } obj = obj.parent; }
      if (target) {
        target.takeDamage?.(CONFIG.weapons.bat.damage);
        this.game.onLocalHit(target, CONFIG.weapons.bat.damage, h.point);
        this.game.net.reportHit({
          weaponId: 'bat', victimId: target.id, victimType: target.kind || 'prop',
          dmg: CONFIG.weapons.bat.damage, pos: { x: h.point.x, y: h.point.y, z: h.point.z },
        });
        this.game.onWeaponFired(CONFIG.weapons.bat);
      }
    }
  }

  _spawnTracer(from, to) {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]);
    const line = new THREE.Line(geo, this._tracerMat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.06, max: 0.06 });
  }

  _muzzleFlash(origin, dir) {
    this._flashMesh.position.copy(origin).add(dir.clone().multiplyScalar(0.3));
    this._flashMesh.lookAt(this.game.camera.position);
    this._flashMesh.visible = true;
    this._flashMesh.material.opacity = 0.95;
    this._flashLife = 0.05;
  }

  _recoil() {
    // tiny camera kick
    this.game.cameraController.pitch += 0.01 + Math.random() * 0.01;
  }

  _updateFX(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / t.max) * 0.9;
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }
    if (this._flashLife > 0) {
      this._flashLife -= dt;
      this._flashMesh.material.opacity = Math.max(0, this._flashLife / 0.05) * 0.95;
      if (this._flashLife <= 0) this._flashMesh.visible = false;
    }
  }
}
