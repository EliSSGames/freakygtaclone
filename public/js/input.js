// ============================================================
// input.js — keyboard, mouse, pointer-lock, and a small touch shim
// Centralizes raw input into a polled state object the rest of the
// game reads each frame. Also handles pointer lock requests.
// ============================================================

export class Input {
  constructor(canvas) {
    this.canvas = canvas;

    /** keys currently down (lowercased codes via event.code, e.g. 'KeyW') */
    this.keys = new Set();
    /** keys pressed this frame (edge-triggered). Cleared by consumer. */
    this.pressed = new Set();

    // mouse
    this.mouseX = 0; this.mouseY = 0;     // accumulated delta since last consume
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseDown = false;
    this.mouseRightDown = false;
    this.mousePressed = false;            // edge

    // wheel
    this.wheel = 0;

    this.pointerLocked = false;
    this.enabled = true;

    // touch (very basic — for mobile look + move)
    this.touch = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      // don't hijack typing in inputs
      if (this._isTypingTarget(e.target)) return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      // prevent space-scroll, etc.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.mouseDown = true; this.mousePressed = true; }
      if (e.button === 2) this.mouseRightDown = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.mouseRightDown = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
    document.addEventListener('mousemove', (e) => {
      if (this.pointerLocked) {
        this.mouseDX += e.movementX || 0;
        this.mouseDY += e.movementY || 0;
      }
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });

    window.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    // --- basic touch: left half = move, right half = look ---
    const touches = new Map();
    this.canvas.addEventListener('touchstart', (e) => {
      for (const t of e.changedTouches) {
        const side = t.clientX < window.innerWidth / 2 ? 'move' : 'look';
        touches.set(t.identifier, { side, sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY });
      }
    }, { passive: true });
    this.canvas.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier);
        if (!s) continue;
        if (s.side === 'move') {
          this.touch.moveX = (t.clientX - s.sx) / 60;
          this.touch.moveY = (t.clientY - s.sy) / 60;
        } else {
          this.touch.lookX += (t.clientX - s.lx);
          this.touch.lookY += (t.clientY - s.ly);
        }
        s.lx = t.clientX; s.ly = t.clientY;
      }
    }, { passive: true });
    this.canvas.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        const s = touches.get(t.identifier);
        if (s && s.side === 'move') { this.touch.moveX = 0; this.touch.moveY = 0; }
        touches.delete(t.identifier);
      }
    }, { passive: true });
  }

  _isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  /** Request pointer lock (call on a user gesture like canvas click). */
  requestLock() {
    if (!this.pointerLocked && this.canvas.requestPointerLock) {
      this.canvas.requestPointerLock();
    }
  }

  /** Is a key held? Accepts either code (KeyW) or alias (w). */
  down(code) {
    return this.keys.has(code) || this.keys.has('Key' + code.toUpperCase());
  }

  /** Was a key pressed this frame (edge)? Consumer clears via endFrame(). */
  justPressed(code) {
    return this.pressed.has(code) || this.pressed.has('Key' + code.toUpperCase());
  }

  /** Consume accumulated mouse delta for this frame. */
  consumeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0; this.mouseDY = 0;
    // include touch look scaled into similar units
    const tx = this.touch.lookX, ty = this.touch.lookY;
    this.touch.lookX = 0; this.touch.lookY = 0;
    return { dx: dx + tx * 0.6, dy: dy + ty * 0.6 };
  }

  /** Call at end of each frame to reset edge-triggered state. */
  endFrame() {
    this.pressed.clear();
    this.mousePressed = false;
    this.wheel = 0;
  }
}
