import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { CONFIG } from '../config';
import type { HeightSampler } from '../types';

export type MoveMode = 'walk' | 'iso';

/** Two camera modes:
 * - iso: free-cursor isometric city view — drag to pan, wheel to zoom,
 *   right-drag / Q,E to rotate. UI stays clickable (no pointer lock).
 * - walk: first-person with pointer lock (WASD + mouse look). */
export class PlayerControls {
  mode: MoveMode = 'iso';
  private lock: PointerLockControls;
  private keys = new Set<string>();
  onModeChange?: (mode: MoveMode) => void;

  // isometric state
  private isoTarget = new THREE.Vector3();
  private isoDist = 300;
  private isoYaw = 0;
  private readonly isoPitch = (54 * Math.PI) / 180;
  private dragButton = -1;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    private sample: HeightSampler,
    private resolveCollision?: (x: number, z: number, r: number) => { x: number; z: number },
  ) {
    this.lock = new PointerLockControls(camera, dom);

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyF') this.toggleMode();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('mousedown', (e) => {
      if (this.mode !== 'iso') return;
      this.dragButton = e.button;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => (this.dragButton = -1));
    window.addEventListener('mousemove', (e) => {
      if (this.mode !== 'iso' || this.dragButton < 0) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragButton === 2) {
        // right-drag: rotate view
        this.isoYaw -= dx * 0.006;
      } else {
        // left/middle drag: grab-pan the map
        const f = this.isoDist * 0.0016;
        const fwd = this.isoForward();
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        this.isoTarget.addScaledVector(right, -dx * f).addScaledVector(fwd, dy * f);
      }
      this.applyIso();
    });
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'iso') return;
        e.preventDefault();
        this.isoDist = Math.min(Math.max(this.isoDist * Math.exp(e.deltaY * 0.0012), 45), 1100);
        this.applyIso();
      },
      { passive: false },
    );
  }

  get isLocked(): boolean {
    return this.lock.isLocked;
  }

  requestLock(): void {
    if (this.mode === 'walk') this.lock.lock();
  }

  onLock(cb: () => void): void {
    this.lock.addEventListener('lock', cb);
  }

  onUnlock(cb: () => void): void {
    this.lock.addEventListener('unlock', cb);
  }

  /** Center the iso camera over a world point (also used on boot/teleport). */
  focus(x: number, z: number, dist?: number): void {
    this.isoTarget.set(x, 0, z);
    if (dist) this.isoDist = dist;
    if (this.mode === 'iso') this.applyIso();
  }

  /** e2e/debug: park controls so manual camera placement sticks. */
  detachForDebug(): void {
    this.mode = 'walk'; // walk without pointer lock = update() is a no-op
  }

  toggleMode(): void {
    if (this.mode === 'iso') {
      this.mode = 'walk';
      const x = this.isoTarget.x;
      const z = this.isoTarget.z;
      this.camera.position.set(x, this.sample(x, z) + CONFIG.eyeHeight, z);
      // keep looking the same compass direction as the iso view
      this.camera.rotation.set(0, this.isoYaw, 0, 'YXZ');
      this.lock.lock();
    } else {
      this.mode = 'iso';
      if (this.lock.isLocked) this.lock.unlock();
      this.isoTarget.set(this.camera.position.x, 0, this.camera.position.z);
      this.applyIso();
    }
    this.onModeChange?.(this.mode);
  }

  private isoForward(): THREE.Vector3 {
    // horizontal view direction (camera → target)
    return new THREE.Vector3(-Math.sin(this.isoYaw), 0, -Math.cos(this.isoYaw));
  }

  private applyIso(): void {
    const t = this.isoTarget;
    const ty = this.sample(t.x, t.z);
    const horiz = Math.cos(this.isoPitch) * this.isoDist;
    const fwd = this.isoForward();
    this.camera.position.set(
      t.x - fwd.x * horiz,
      ty + Math.sin(this.isoPitch) * this.isoDist,
      t.z - fwd.z * horiz,
    );
    this.camera.lookAt(t.x, ty, t.z);
  }

  update(dt: number): void {
    if (this.mode === 'iso') {
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      const speed = this.isoDist * (fast ? 1.5 : 0.7) * dt;
      const fwd = this.isoForward();
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      let moved = false;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
        this.isoTarget.addScaledVector(fwd, speed);
        moved = true;
      }
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
        this.isoTarget.addScaledVector(fwd, -speed);
        moved = true;
      }
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) {
        this.isoTarget.addScaledVector(right, -speed);
        moved = true;
      }
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) {
        this.isoTarget.addScaledVector(right, speed);
        moved = true;
      }
      if (this.keys.has('KeyQ')) {
        this.isoYaw += 1.5 * dt;
        moved = true;
      }
      if (this.keys.has('KeyE')) {
        this.isoYaw -= 1.5 * dt;
        moved = true;
      }
      if (moved) this.applyIso();
      return;
    }

    // walk mode
    if (!this.lock.isLocked) return;
    const cam = this.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const fwdFlat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (fwdFlat.lengthSq() < 1e-6) fwdFlat.set(0, 0, -1);
    fwdFlat.normalize();
    const left = new THREE.Vector3().crossVectors(fwdFlat, new THREE.Vector3(0, 1, 0)).negate();

    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(fwdFlat);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(fwdFlat);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.add(left);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.sub(left);

    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar((fast ? CONFIG.runSpeed : CONFIG.walkSpeed) * dt);
      cam.position.add(move);
    }
    if (this.resolveCollision) {
      const c = this.resolveCollision(cam.position.x, cam.position.z, 0.45);
      cam.position.x = c.x;
      cam.position.z = c.z;
    }
    const targetY = this.sample(cam.position.x, cam.position.z) + CONFIG.eyeHeight;
    cam.position.y += (targetY - cam.position.y) * Math.min(dt * 12, 1);
  }
}
