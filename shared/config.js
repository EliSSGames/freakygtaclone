'use strict';

/**
 * shared/config.js
 * ------------------------------------------------------------------
 * Single source of truth for tunable game constants, shared by BOTH
 * the Node server (CommonJS) and the browser client (ES module).
 *
 * The browser loads this via an import-mapped ESM shim (see esm-shim.js);
 * the server requires it directly. Keep this file CommonJS-syntax but
 * module-friendly: we export via `module.exports` AND attach to globalThis
 * so the ESM shim can read it off the global.
 *
 * Why a single config?  So client and server agree on the world layout
 * (grid size, cell size, road geometry), entity sizes, movement caps,
 * weapon stats, wanted thresholds, etc. This is what makes
 * server-authoritative checks and client prediction match.
 * ------------------------------------------------------------------
 */

const CONFIG = {
  // --- Server / network ---
  network: {
    snapshotRate: 20,       // server broadcasts full snapshot this many times/sec
    sendRate: 30,           // client sends input/state this many times/sec
    interpDelay: 0.10,      // 100ms rewind window for remote interpolation
    maxPlayersPerRoom: 12,
  },

  // --- World / city grid ---
  // The city is a square grid of blocks. Roads run along the grid lines,
  // buildings fill the block interiors. This grid also defines the road
  // graph the traffic AI follows.
  world: {
    gridCells: 8,           // city is gridCells x gridCells blocks
    cellSize: 50,           // size of one block (one road span) in meters
    roadWidth: 12,          // drivable road width (lane both ways)
    sidewalkWidth: 3,
    buildingMaxHeight: 60,
    worldHalf: function () { return (this.gridCells * this.cellSize) / 2; },
    // Keep numeric half computed for perf (avoid closures in hot loops):
    halfExtent: (8 * 50) / 2, // updated by City if gridCells/cellSize change
  },

  // --- Player (on foot) ---
  player: {
    radius: 0.6,
    height: 1.85,
    eyeHeight: 1.7,
    walkSpeed: 4.5,
    runSpeed: 8.0,
    jumpSpeed: 6.5,
    gravity: 20.0,
    accelGround: 40,
    accelAir: 8,
    maxHealth: 100,
    maxArmor: 100,
    enterVehicleRange: 3.5, // distance to a vehicle door to enter
  },

  // --- Vehicles ---
  vehicle: {
    sedan: {
      length: 4.4, width: 1.9, height: 1.4,
      mass: 1200,
      maxSpeed: 42,         // m/s ~ 150 km/h
      accel: 14,
      brake: 28,
      reverseMax: 10,
      steer: 2.6,           // steering angular speed (rad/s at full lock)
      grip: 6.0,            // lateral velocity damping
      drag: 0.4,
      health: 100,
    },
    sports: {
      length: 4.2, width: 1.95, height: 1.15,
      mass: 1000,
      maxSpeed: 58,
      accel: 22,
      brake: 34,
      reverseMax: 12,
      steer: 3.0,
      grip: 8.0,
      drag: 0.35,
      health: 90,
    },
    truck: {
      length: 6.2, width: 2.3, height: 2.6,
      mass: 2600,
      maxSpeed: 30,
      accel: 9,
      brake: 22,
      reverseMax: 8,
      steer: 2.0,
      grip: 5.0,
      drag: 0.6,
      health: 160,
    },
  },

  // --- Weapons (server is authoritative for damage) ---
  // range/damage are authoritative; client uses the same for FX/prediction.
  weapons: {
    bat: {
      id: 'bat', name: 'Bat', type: 'melee',
      damage: 34, range: 2.4, fireRate: 0.55, spread: 0,
      magSize: Infinity, reserve: Infinity, reloadTime: 0, pellets: 0,
    },
    pistol: {
      id: 'pistol', name: 'Pistol', type: 'gun',
      damage: 18, range: 70, fireRate: 0.28, spread: 0.02,
      magSize: 12, reserve: 72, reloadTime: 1.3, pellets: 1,
    },
    smg: {
      id: 'smg', name: 'SMG', type: 'gun',
      damage: 12, range: 65, fireRate: 0.085, spread: 0.05,
      magSize: 30, reserve: 180, reloadTime: 1.7, pellets: 1,
    },
  },
  defaultLoadout: ['pistol', 'bat'],

  // --- Wanted / police ---
  wanted: {
    maxStars: 5,
    heatPerShot: 1.5,
    heatPerCivilianHit: 14,
    heatPerCopHit: 18,
    heatPerVehicleDamage: 1.0,
    // thresholds: total heat required to reach star N
    starThresholds: [0, 12, 35, 70, 120, 190],
    decayPerSecWhenHidden: 4.5,
    hiddenGraceSeconds: 6, // must be out of police line-of-sight this long before decay
  },
  police: {
    // number of active cop units per wanted star
    unitsPerStar: [0, 2, 3, 5, 7, 9],
    spawnDistance: 70,
    despawnDistance: 160,
    moveSpeed: 6.2,
    chaseSpeed: 9.5,
    shootRange: 45,
    fireRate: 0.9,
    accuracy: 0.35,        // 0..1 base hit chance at close range
    damage: 7,
  },

  // --- Traffic AI ---
  traffic: {
    maxVehicles: 28,       // cap for performance
    spawnDistance: 90,
    despawnDistance: 140,
    targetSpeed: 9,
    lookahead: 8,
    brakeDistance: 14,
  },

  // --- Pedestrians ---
  peds: {
    maxPeds: 40,
    walkSpeed: 1.4,
    fleeSpeed: 5.0,
    spawnDistance: 70,
    despawnDistance: 120,
  },

  // --- Camera ---
  camera: {
    thirdPersonDistance: 5.5,
    thirdPersonHeight: 2.6,
    carDistance: 9,
    carHeight: 4.0,
    followLerp: 12,
    mouseSensitivity: 0.0022,
    minPitch: -1.2,
    maxPitch: 0.6,
  },

  // --- Mission (delivery) ---
  mission: {
    rewardCash: 2500,
    timeLimit: 180,        // seconds
  },
};

// --- Cross-environment export --------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CONFIG;
}
if (typeof globalThis !== 'undefined') {
  globalThis.__CITYFALL_CONFIG = CONFIG;
}
