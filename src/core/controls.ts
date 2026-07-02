import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { CONFIG } from '../config';
import type { HeightSampler } from '../types';

export type MoveMode = 'walk' | 'fly';

/** First-person controls: pointer-lock look, WASD move, walk (terrain-clamped) or fly. */
export class PlayerControls {
  mode: MoveMode = 'walk';
  private lock: PointerLockControls;
  private keys = new Set<string>();
  private velY = 0;
  onModeChange?: (mode: MoveMode) => void;

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
  }

  get isLocked(): boolean {
    return this.lock.isLocked;
  }

  requestLock(): void {
    this.lock.lock();
  }

  onLock(cb: () => void): void {
    this.lock.addEventListener('lock', cb);
  }

  onUnlock(cb: () => void): void {
    this.lock.addEventListener('unlock', cb);
  }

  toggleMode(): void {
    this.mode = this.mode === 'walk' ? 'fly' : 'walk';
    if (this.mode === 'fly') {
      // hop up a bit so the switch is visible
      this.camera.position.y += 15;
    }
    this.onModeChange?.(this.mode);
  }

  update(dt: number): void {
    if (!this.lock.isLocked) return;
    const cam = this.camera;

    // basis vectors from camera yaw
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const fwdFlat = new THREE.Vector3(fwd.x, 0, fwd.z);
    if (fwdFlat.lengthSq() < 1e-6) fwdFlat.set(0, 0, -1);
    fwdFlat.normalize();
    const right = new THREE.Vector3().crossVectors(fwdFlat, new THREE.Vector3(0, 1, 0)).negate();

    const move = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) move.add(this.mode === 'fly' ? fwd : fwdFlat);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) move.sub(this.mode === 'fly' ? fwd : fwdFlat);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) move.add(right);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) move.sub(right);

    const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    if (this.mode === 'fly') {
      if (this.keys.has('KeyE') || this.keys.has('Space')) move.y += 1;
      if (this.keys.has('KeyQ') || this.keys.has('KeyC')) move.y -= 1;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar((fast ? CONFIG.flyFastSpeed : CONFIG.flySpeed) * dt);
        cam.position.add(move);
      }
      // never fly below terrain
      const minY = this.sample(cam.position.x, cam.position.z) + 1.2;
      if (cam.position.y < minY) cam.position.y = minY;
    } else {
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar((fast ? CONFIG.runSpeed : CONFIG.walkSpeed) * dt);
        cam.position.add(move);
      }
      // slide along building footprints
      if (this.resolveCollision) {
        const c = this.resolveCollision(cam.position.x, cam.position.z, 0.45);
        cam.position.x = c.x;
        cam.position.z = c.z;
      }
      const targetY = this.sample(cam.position.x, cam.position.z) + CONFIG.eyeHeight;
      // smooth vertical follow (stairs/slopes)
      cam.position.y += (targetY - cam.position.y) * Math.min(dt * 12, 1);
    }
  }
}
