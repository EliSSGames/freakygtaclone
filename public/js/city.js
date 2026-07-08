// ============================================================
// city.js — procedural city: roads, sidewalks, buildings, parks.
// Also builds a RoadGraph (node grid) that the traffic AI follows,
// and exposes collider data (AABBs + meshes) for player physics
// and camera collision.
//
// Layout: a `gridCells x gridCells` grid of blocks separated by roads.
// Roads run along the grid lines (both axes). Buildings fill block
// interiors with a sidewalk border. Each road intersection is a graph
// node; edges connect adjacent intersections.
// ============================================================

import * as THREE from 'three';
import { CONFIG } from '../../shared/esm-shim.js';
import { mulberry32, pick } from './utils.js';

export class City {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    const { gridCells, cellSize } = CONFIG.world;
    this.gridCells = gridCells;
    this.cellSize = cellSize;
    this.halfExtent = (gridCells * cellSize) / 2;
    CONFIG.world.halfExtent = this.halfExtent; // keep config in sync

    /** Axis-aligned bounding boxes (THREE.Box3) for buildings. */
    this.buildingBoxes = [];
    /** Building meshes (used by camera raycast collider set). */
    this.buildingMeshes = [];

    /** Road graph for traffic AI. */
    this.roadGraph = null;

    /** Mission-relevant anchors (assigned by Mission later). */
    this.pickupAnchor = new THREE.Vector3();
    this.dropoffAnchor = new THREE.Vector3();

    this._build();
  }

  _build() {
    this._buildGround();
    this._buildRoads();
    this._buildBlocks();      // sidewalks + buildings + parks
    this._buildRoadGraph();
    this._buildLightingProps(); // street lamps for flavor
  }

  // --- ground base ---
  _buildGround() {
    const size = this.gridCells * this.cellSize + 60;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.02;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // --- roads: big dark plane + painted grid lines ---
  _buildRoads() {
    const { gridCells, cellSize } = this;
    const total = gridCells * cellSize;
    const half = total / 2;
    const roadW = CONFIG.world.roadWidth;

    // Asphalt road plane (slightly above ground to avoid z-fight).
    const roadGeo = new THREE.PlaneGeometry(total + roadW, total + roadW);
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x12141a, roughness: 0.95 });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.0;
    road.receiveShadow = true;
    this.group.add(road);

    // Lane center dashes along each road line (visual flavor, cheap).
    const dashMat = new THREE.MeshBasicMaterial({ color: 0x9a8a3a });
    const dashGeo = new THREE.PlaneGeometry(1.6, 0.18);
    for (let i = 0; i <= gridCells; i++) {
      const c = -half + i * cellSize;
      // line parallel to Z at x=c
      for (let z = -half + 4; z < half; z += 8) {
        const d = new THREE.Mesh(dashGeo, dashMat);
        d.rotation.x = -Math.PI / 2;
        d.position.set(c, 0.02, z + 2);
        this.group.add(d);
      }
      // line parallel to X at z=c
      for (let x = -half + 4; x < half; x += 8) {
        const d = new THREE.Mesh(dashGeo, dashMat);
        d.rotation.x = -Math.PI / 2;
        d.rotation.z = Math.PI / 2;
        d.position.set(x + 2, 0.02, c);
        this.group.add(d);
      }
    }
  }

  // --- blocks: sidewalk border + building(s) or park ---
  _buildBlocks() {
    const { gridCells, cellSize } = this;
    const half = (gridCells * cellSize) / 2;
    const roadW = CONFIG.world.roadWidth;
    const sw = CONFIG.world.sidewalkWidth;
    const rng = mulberry32(1337);

    for (let i = 0; i < gridCells; i++) {
      for (let j = 0; j < gridCells; j++) {
        // block center
        const cx = -half + i * cellSize + cellSize / 2;
        const cz = -half + j * cellSize + cellSize / 2;
        // block footprint (excluding road). Sidewalk fills the border.
        const inner = cellSize - roadW;        // sidewalk outer edge
        const core = inner - sw * 2;           // buildable area

        // sidewalk slab
        const swGeo = new THREE.BoxGeometry(inner, 0.3, inner);
        const swMat = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 1 });
        const slab = new THREE.Mesh(swGeo, swMat);
        slab.position.set(cx, 0.15, cz);
        slab.receiveShadow = true;
        this.group.add(slab);

        // Decide block content: mostly buildings, some parks/plazas.
        const r = rng();
        if (r < 0.12) {
          this._buildPark(cx, cz, core, rng);
        } else if (r < 0.22) {
          // plaza with a single landmark tower
          this._buildTower(cx, cz, core, rng);
        } else {
          this._buildCluster(cx, cz, core, rng);
        }
      }
    }
  }

  _buildPark(cx, cz, size, rng) {
    const grass = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.2, size),
      new THREE.MeshStandardMaterial({ color: 0x234d2a, roughness: 1 })
    );
    grass.position.set(cx, 0.2, cz);
    grass.receiveShadow = true;
    this.group.add(grass);

    // a few trees (cone + cylinder)
    const treeMatT = new THREE.MeshStandardMaterial({ color: 0x2f6d36 });
    const treeMatB = new THREE.MeshStandardMaterial({ color: 0x4a3220 });
    const n = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const tx = cx + (rng() - 0.5) * size * 0.7;
      const tz = cz + (rng() - 0.5) * size * 0.7;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2, 6), treeMatB);
      trunk.position.set(tx, 1.2, tz); trunk.castShadow = true;
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.8, 3.4, 7), treeMatT);
      top.position.set(tx, 3.4, tz); top.castShadow = true;
      this.group.add(trunk); this.group.add(top);
    }
  }

  _buildTower(cx, cz, size, rng) {
    const h = CONFIG.world.buildingMaxHeight * (0.5 + rng() * 0.5);
    const w = size * (0.45 + rng() * 0.2);
    this._addBuilding(cx, cz, w, w, h, rng);
  }

  _buildCluster(cx, cz, size, rng) {
    // split the core into a 2x2 of buildings (sub-blocks)
    const sub = size / 2 - 1.5;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sz = -1; sz <= 1; sz += 2) {
        if (rng() < 0.15) continue; // gap/variety
        const bx = cx + sx * (size / 4);
        const bz = cz + sz * (size / 4);
        const h = 8 + rng() * (CONFIG.world.buildingMaxHeight - 8);
        const w = sub * (0.6 + rng() * 0.4);
        const d = sub * (0.6 + rng() * 0.4);
        this._addBuilding(bx, bz, w, d, h, rng);
      }
    }
  }

  _addBuilding(cx, cz, w, d, h, rng) {
    // color palette: muted urban grays/blues/browns
    const palette = [0x3a4150, 0x4a4f5a, 0x5a5048, 0x353b47, 0x444b58, 0x2e333d];
    const color = pick(palette, rng);
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.85, metalness: 0.05,
      emissive: 0x000000,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, h / 2 + 0.3, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // window emissive strips via a second thin box overlay (cheap glow)
    if (h > 14) {
      const winMat = new THREE.MeshStandardMaterial({
        color: 0x223044, emissive: 0x4a6688, emissiveIntensity: 0.25, roughness: 0.4
      });
      const winGeo = new THREE.BoxGeometry(w * 1.001, h * 0.9, d * 1.001);
      const win = new THREE.Mesh(winGeo, winMat);
      win.position.copy(mesh.position);
      this.group.add(win);
    }

    // AABB for physics/collision
    const box = new THREE.Box3(
      new THREE.Vector3(cx - w / 2, 0, cz - d / 2),
      new THREE.Vector3(cx + w / 2, h, cz + d / 2)
    );
    this.buildingBoxes.push(box);
    this.buildingMeshes.push(mesh);
  }

  // --- street lamps along road lines ---
  _buildLightingProps() {
    const { gridCells, cellSize } = this;
    const half = (gridCells * cellSize) / 2;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x202024 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xffd9a0, emissive: 0xffb84d, emissiveIntensity: 0.8
    });
    for (let i = 0; i < gridCells; i++) {
      const c = -half + i * cellSize + cellSize / 2;
      for (let s = -1; s <= 1; s += 2) {
        const x = c + s * (cellSize / 2 - 1);
        for (let k = -1; k <= 1; k += 2) {
          const z = k * (cellSize / 2 - 1) + c;
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 5, 6), poleMat);
          pole.position.set(x, 2.5, z);
          this.group.add(pole);
          const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 6, 6), lampMat);
          lamp.position.set(x, 5.0, z);
          this.group.add(lamp);
        }
      }
    }
  }

  // ------------------------------------------------------------
  // ROAD GRAPH
  // Nodes sit at every road intersection (grid corners). Edges run
  // along roads to the 4-neighbour intersection. Each edge stores a
  // "lane offset" so traffic drives on the right side of the road.
  // ------------------------------------------------------------
  _buildRoadGraph() {
    const { gridCells, cellSize } = this;
    const half = (gridCells * cellSize) / 2;
    const lane = CONFIG.world.roadWidth * 0.25; // right-hand offset

    const nodes = [];                 // [row][col]
    for (let r = 0; r <= gridCells; r++) {
      nodes[r] = [];
      for (let c = 0; c <= gridCells; c++) {
        nodes[r][c] = {
          id: r * (gridCells + 1) + c,
          r, c,
          pos: new THREE.Vector3(-half + c * cellSize, 0, -half + r * cellSize),
          neighbors: [], // {node, dir:[-1..1,-1..1]}
        };
      }
    }
    for (let r = 0; r <= gridCells; r++) {
      for (let c = 0; c <= gridCells; c++) {
        const n = nodes[r][c];
        if (c < gridCells) n.neighbors.push({ node: nodes[r][c + 1], dir: [1, 0] });
        if (c > 0)        n.neighbors.push({ node: nodes[r][c - 1], dir: [-1, 0] });
        if (r < gridCells) n.neighbors.push({ node: nodes[r + 1][c], dir: [0, 1] });
        if (r > 0)        n.neighbors.push({ node: nodes[r - 1][c], dir: [0, -1] });
      }
    }

    // flatten + index
    const all = [];
    for (let r = 0; r <= gridCells; r++) for (let c = 0; c <= gridCells; c++) all.push(nodes[r][c]);

    this.roadGraph = { nodes: all, grid: nodes, lane, cellSize, gridCells, half };

    // choose pickup/dropoff anchors at far corners-ish of the map
    this.pickupAnchor.set(-half + cellSize * 1.5, 0, -half + cellSize * 1.5);
    this.dropoffAnchor.set(half - cellSize * 1.5, 0, half - cellSize * 1.5);
  }

  /** Random intersection node, optionally biased toward a point. */
  randomNode(rng = Math.random) {
    const g = this.roadGraph;
    return g.nodes[Math.floor(rng() * g.nodes.length)];
  }

  /** Nearest graph node to a world position. */
  nearestNode(pos) {
    const g = this.roadGraph;
    const cc = Math.round((pos.x + g.half) / g.cellSize);
    const rr = Math.round((pos.z + g.half) / g.cellSize);
    const r = Math.max(0, Math.min(g.gridCells, rr));
    const c = Math.max(0, Math.min(g.gridCells, cc));
    return g.grid[r][c];
  }

  /** True if a world position is over a road (used for spawn checks). */
  isOnRoad(pos, margin = 0) {
    const { gridCells, cellSize } = this;
    const half = (gridCells * cellSize) / 2;
    const rw = CONFIG.world.roadWidth / 2 + margin;
    const lx = ((pos.x + half) % cellSize + cellSize) % cellSize;
    const lz = ((pos.z + half) % cellSize + cellSize) % cellSize;
    // near a grid line in either axis
    return lx < rw || lx > cellSize - rw || lz < rw || lz > cellSize - rw;
  }
}
