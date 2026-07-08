// ============================================================
// mission.js — package delivery mission.
// Flow: briefing -> pickup (grab package) -> checkpoint (drive/flee)
//   -> dropoff (deliver) -> reward. Fail conditions: time out or
//   downed while holding. Server validates pickup/dropoff ownership
//   so rewards can't be stolen by replaying events.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { distXZ, formatTime } from './utils.js';

const STAGE = {
  INACTIVE: 'inactive',
  BRIEFING: 'briefing',
  TO_PICKUP: 'to_pickup',
  HOLDING: 'holding',
  TO_DROPOFF: 'to_droppoff',
  SUCCESS: 'success',
  FAILED: 'failed',
};

export class Mission {
  constructor(scene, city, game) {
    this.scene = scene;
    this.city = city;
    this.game = game;

    this.stage = STAGE.INACTIVE;
    this.holder = false;     // is the local player holding the package?
    this.timeLeft = CONFIG.mission.timeLimit;
    this.completed = 0;
    this._elapsed = 0;

    this._buildMarkers();
  }

  _buildMarkers() {
    const make = (color, emissive) => {
      const mat = new THREE.MeshStandardMaterial({
        color, emissive, emissiveIntensity: 0.7, transparent: true, opacity: 0.9
      });
      const g = new THREE.Group();
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 30, 16, 1, true), mat.clone());
      beam.position.y = 15;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.18, 8, 24), mat.clone());
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.6;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), mat);
      box.position.y = 0.6;
      g.add(beam, ring, box);
      g.visible = false;
      this.scene.add(g);
      return { group: g, beam, ring, box };
    };
    this.pickupMarker = make(0xffcc33, 0xffaa22);
    this.dropoffMarker = make(0x33dd66, 0x22aa55);
  }

  start() {
    if (this.stage !== STAGE.INACTIVE && this.stage !== STAGE.FAILED && this.stage !== STAGE.SUCCESS) return;
    this.stage = STAGE.TO_PICKUP;
    this.holder = false;
    this.timeLeft = CONFIG.mission.timeLimit;
    this._elapsed = 0;
    this._positionMarkers();
    this.pickupMarker.group.visible = true;
    this.dropoffMarker.group.visible = false;
    this.game.hud.toast('MISSION: Grab the package at the gold marker.', 'warn');
    this.game.hud.setMission('PACKAGE RUN', 'Reach the gold marker and grab the package.');
  }

  _positionMarkers() {
    // use city anchors, slightly randomized per run
    this.pickupMarker.group.position.copy(this.city.pickupAnchor);
    this.dropoffMarker.group.position.copy(this.city.dropoffAnchor);
  }

  fail(reason) {
    if (this.stage === STAGE.SUCCESS || this.stage === STAGE.FAILED) return;
    this.stage = STAGE.FAILED;
    this.holder = false;
    this.pickupMarker.group.visible = false;
    this.dropoffMarker.group.visible = false;
    this.game.hud.toast(`MISSION FAILED: ${reason}`, 'warn');
    this.game.hud.setMission('FAILED', reason + ' Restart in 5s…');
    this._resetIn = 5;
  }

  success() {
    this.stage = STAGE.SUCCESS;
    this.holder = false;
    this.completed++;
    this.pickupMarker.group.visible = false;
    this.dropoffMarker.group.visible = false;
    const reward = CONFIG.mission.rewardCash;
    this.game.addCash(reward);
    this.game.hud.toast(`DELIVERED! +$${reward}`, 'good');
    this.game.hud.setMission('SUCCESS', `+$${reward}. New job in 5s…`);
    this._resetIn = 5;
    // tell server we completed dropoff (authoritative payout)
    this.game.net.reportDropoff();
  }

  update(dt, playerPos) {
    // animate markers
    const t = performance.now() / 1000;
    for (const m of [this.pickupMarker, this.dropoffMarker]) {
      if (m.group.visible) {
        m.ring.rotation.z = t * 1.5;
        m.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.1);
        m.box.rotation.y = t * 1.2;
        m.box.position.y = 0.6 + Math.sin(t * 3) * 0.15;
      }
    }

    if (this._resetIn !== undefined) {
      this._resetIn -= dt;
      if (this._resetIn <= 0) { this._resetIn = undefined; this.stage = STAGE.INACTIVE; this.start(); }
      return;
    }
    if (this.stage === STAGE.INACTIVE || this.stage === STAGE.SUCCESS || this.stage === STAGE.FAILED) return;

    this._elapsed += dt;
    if (this.holder) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this.fail('Time ran out'); return; }
    }
    this.game.hud.setMissionTime(this.holder ? this.timeLeft : null);

    const range = 3.0;
    if (this.stage === STAGE.TO_PICKUP) {
      const d = distXZ(playerPos.x, playerPos.z, this.pickupMarker.group.position.x, this.pickupMarker.group.position.z);
      if (d < range) this._pickup();
    } else if (this.stage === STAGE.HOLDING || this.stage === STAGE.TO_DROPOFF) {
      const d = distXZ(playerPos.x, playerPos.z, this.dropoffMarker.group.position.x, this.dropoffMarker.group.position.z);
      if (d < range) this.success();
    }
  }

  _pickup() {
    // request ownership from server; only proceed if granted
    this.game.net.reportPickup((granted) => {
      if (!granted) {
        // someone else got it
        this.stage = STAGE.INACTIVE;
        this.pickupMarker.group.visible = false;
        this.game.hud.toast('Someone else grabbed the package!', 'warn');
        return;
      }
      this.holder = true;
      this.stage = STAGE.TO_DROPOFF;
      this.pickupMarker.group.visible = false;
      this.dropoffMarker.group.visible = true;
      this.game.hud.toast('You have the package! Deliver to the green marker.', 'good');
      this.game.hud.setMission('DELIVER PACKAGE', `Reach the green marker. ${formatTime(this.timeLeft)} left.`);
    });
  }

  /** Called by Game when local player dies. */
  onPlayerDown() {
    if (this.holder) this.fail('You went down');
  }

  /** Server reports mission state changes (someone else holds, etc). */
  onServerState(state) {
    if (!state.active && this.stage !== STAGE.SUCCESS && this.stage !== STAGE.FAILED) {
      // package returned to spawn; reset to pickup stage if we were chasing
      if (this.stage === STAGE.TO_DROPOFF) {
        this.stage = STAGE.TO_PICKUP;
        this.holder = false;
        this.dropoffMarker.group.visible = false;
        this.pickupMarker.group.visible = true;
        this.game.hud.setMission('PACKAGE RUN', 'The package is back up. Grab it.');
      }
    }
  }
}
