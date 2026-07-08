// ============================================================
// hud.js — DOM HUD (health/armor/cash/wanted/weapon/mission/toasts)
// + canvas minimap/radar. All updates are throttled and diffed to
// avoid layout thrash.
// ============================================================

import { CONFIG } from '../../shared/esm-shim.js';
import { clamp } from './utils.js';

export class HUD {
  constructor(game) {
    this.game = game;
    this._cache = {};
    this._elts = {
      hp: document.getElementById('hpFill'),
      ar: document.getElementById('arFill'),
      cash: document.getElementById('cashDisplay'),
      wanted: document.getElementById('wantedStars'),
      wantedLabel: document.getElementById('wantedLabel'),
      weaponName: document.getElementById('weaponName'),
      weaponAmmo: document.getElementById('weaponAmmo'),
      missionTitle: document.getElementById('missionTitle'),
      missionText: document.getElementById('missionText'),
      missionTimer: document.getElementById('missionTimer'),
      toastFeed: document.getElementById('toastFeed'),
      playerList: document.getElementById('playerList'),
      flash: document.getElementById('damageFlash'),
      hitMarker: document.getElementById('hitMarker'),
      minimap: document.getElementById('minimapCanvas'),
    };
    this.miniCtx = this._elts.minimap.getContext('2d');
  }

  setHealth(hp, ar) {
    const e = this._elts;
    if (this._cache.hp !== hp) { e.hp.style.width = `${clamp(hp / CONFIG.player.maxHealth, 0, 1) * 100}%`; this._cache.hp = hp; }
    if (this._cache.ar !== ar) { e.ar.style.width = `${clamp(ar / CONFIG.player.maxArmor, 0, 1) * 100}%`; this._cache.ar = ar; }
  }

  setCash(c) {
    if (this._cache.cash === c) return;
    this._cache.cash = c;
    this._elts.cash.textContent = `$${c.toLocaleString()}`;
  }

  setWanted(stars) {
    if (this._cache.stars === stars) return;
    this._cache.stars = stars;
    let s = '';
    for (let i = 0; i < CONFIG.wanted.maxStars; i++) s += `<span class="${i < stars ? 'on' : ''}">★</span>`;
    this._elts.wanted.innerHTML = s;
    this._elts.wantedLabel.textContent = stars === 0 ? 'CLEAN' : `${stars}-STAR ${stars >= 4 ? 'ARMED RESPONSE' : stars >= 2 ? 'PURSUIT' : 'SEARCH'}`;
  }

  setWeapon(name, mag, reserve) {
    if (this._cache.wn === name) {
      // still update ammo text each call (cheap)
    } else {
      this._cache.wn = name;
      this._elts.weaponName.textContent = name.toUpperCase();
    }
    const magTxt = mag === Infinity ? '∞' : mag;
    const resTxt = reserve === Infinity ? '∞' : reserve;
    this._elts.weaponAmmo.textContent = `${magTxt} / ${resTxt}`;
  }

  setMission(title, text) {
    this._elts.missionTitle.textContent = title;
    this._elts.missionText.textContent = text;
  }

  setMissionTime(seconds) {
    if (seconds === null || seconds === undefined) { this._elts.missionTimer.textContent = ''; return; }
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    this._elts.missionTimer.textContent = `⏱ ${m}:${(s % 60).toString().padStart(2, '0')}`;
    this._elts.missionTimer.style.color = s < 30 ? '#ff5555' : '';
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this._elts.toastFeed.appendChild(el);
    setTimeout(() => el.remove(), 4200);
    // cap
    while (this._elts.toastFeed.children.length > 5) this._elts.toastFeed.firstChild.remove();
  }

  damageFlash() {
    this._elts.flash.classList.add('show');
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this._elts.flash.classList.remove('show'), 180);
  }

  hitMarker() {
    this._elts.hitMarker.classList.remove('show');
    void this._elts.hitMarker.offsetWidth; // restart anim
    this._elts.hitMarker.classList.add('show');
  }

  setPlayerList(roster, myId) {
    if (!roster) return;
    let html = '';
    for (const p of roster.slice(0, 8)) {
      const me = p.id === myId ? ' me' : '';
      const tag = p.wanted ? ` ★${p.wanted}` : '';
      html += `<div class="pl${me}">${escapeHtml(p.name)}${tag}</div>`;
    }
    this._elts.playerList.innerHTML = html;
  }

  /** Render the minimap. */
  drawMinimap(state) {
    const ctx = this.miniCtx;
    const W = this._elts.minimap.width, H = this._elts.minimap.height;
    const cx = W / 2, cy = H / 2;
    const range = 90; // world meters shown across the minimap diameter
    const scale = W / range;

    ctx.clearRect(0, 0, W, H);
    // background
    ctx.fillStyle = '#0c1014';
    ctx.fillRect(0, 0, W, H);

    const px = state.player.x, pz = state.player.z;

    // roads (grid lines)
    ctx.strokeStyle = '#2a3340';
    ctx.lineWidth = 3;
    const cell = CONFIG.world.cellSize;
    const half = CONFIG.world.halfExtent;
    ctx.beginPath();
    for (let i = 0; i <= CONFIG.world.gridCells + 1; i++) {
      const w = -half + i * cell;
      // vertical line at world x=w
      const sx = cx + (w - px) * scale;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, H);
      const sz = cy + (w - pz) * scale;
      ctx.moveTo(0, sz); ctx.lineTo(W, sz);
    }
    ctx.stroke();

    // buildings (boxes as small rects)
    ctx.fillStyle = '#1b2230';
    for (const b of state.buildings || []) {
      const sx = cx + (b.min.x - px) * scale;
      const sz = cy + (b.min.z - pz) * scale;
      const sw = (b.max.x - b.min.x) * scale;
      const sh = (b.max.z - b.min.z) * scale;
      if (sx + sw < 0 || sx > W || sz + sh < 0 || sz > H) continue;
      ctx.fillRect(sx, sz, sw, sh);
    }

    const dot = (wx, wz, color, r = 3) => {
      const sx = cx + (wx - px) * scale, sy = cy + (wz - pz) * scale;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
    };
    const tri = (wx, wz, ang, color, r = 4) => {
      const sx = cx + (wx - px) * scale, sy = cy + (wz - pz) * scale;
      ctx.fillStyle = color;
      ctx.save();
      ctx.translate(sx, sy); ctx.rotate(-ang);
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, r * 0.7); ctx.lineTo(-r * 0.7, r * 0.7);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    };

    // mission markers
    for (const m of state.markers || []) dot(m.x, m.z, m.color, 4);
    // vehicles
    for (const v of state.vehicles || []) dot(v.x, v.z, '#88aaff', 2);
    // police
    for (const c of state.cops || []) dot(c.x, c.z, '#ff4040', 3);
    // remote players
    for (const p of state.peers || []) tri(p.x, p.z, p.yaw, '#ffcc44', 4);

    // local player (center arrow)
    tri(px, pz, state.player.yaw, '#ffffff', 5);

    // north label
    ctx.fillStyle = '#8b94a0';
    ctx.font = '10px sans-serif';
    ctx.fillText('N', cx - 3, 12);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
