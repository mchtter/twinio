import * as THREE from 'three';

/** All textures are generated procedurally on canvas — zero asset downloads. */

function canvas(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function noise(ctx: CanvasRenderingContext2D, s: number, alpha: number, light: number): void {
  for (let i = 0; i < s * s * 0.08; i++) {
    const v = Math.floor(Math.random() * 60 + light);
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
}

/** Urban ground: neutral soil/concrete blotches — green comes from OSM area polygons. */
export function makeGroundTexture(): THREE.CanvasTexture {
  return canvas(256, (ctx, s) => {
    ctx.fillStyle = '#b1ada4';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 380; i++) {
      const g = 150 + Math.random() * 45;
      ctx.fillStyle = `rgba(${g + 6},${g},${g - 12},0.45)`;
      const r = 2 + Math.random() * 9;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, r, 0, 7);
      ctx.fill();
    }
    // sparse dry-grass hints so it doesn't read as pure concrete
    for (let i = 0; i < 60; i++) {
      const g = 140 + Math.random() * 30;
      ctx.fillStyle = `rgba(${g - 15},${g},${g - 45},0.25)`;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, 3 + Math.random() * 10, 0, 7);
      ctx.fill();
    }
    noise(ctx, s, 0.1, 118);
  });
}

/** Road texture: u = across the road (0..1), v = along (repeats every ~8 m). */
export function makeRoadTexture(marked: boolean): THREE.CanvasTexture {
  return canvas(256, (ctx, s) => {
    ctx.fillStyle = '#3b3d42';
    ctx.fillRect(0, 0, s, s);
    noise(ctx, s, 0.16, 45);
    ctx.fillStyle = '#d8d8d2';
    if (marked) {
      // edge lines
      ctx.fillRect(s * 0.03, 0, 3, s);
      ctx.fillRect(s * 0.97 - 3, 0, 3, s);
      // dashed center line (dash 3m / gap 5m of an 8m repeat)
      ctx.fillRect(s / 2 - 2, s * 0.1, 4, s * 0.375);
    } else {
      ctx.globalAlpha = 0.35;
      ctx.fillRect(s * 0.04, 0, 2, s);
      ctx.fillRect(s * 0.96 - 2, 0, 2, s);
      ctx.globalAlpha = 1;
    }
  });
}

export function makePavementTexture(): THREE.CanvasTexture {
  return canvas(128, (ctx, s) => {
    ctx.fillStyle = '#a2a19c';
    ctx.fillRect(0, 0, s, s);
    noise(ctx, s, 0.12, 110);
    ctx.strokeStyle = 'rgba(60,60,60,0.35)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i * s) / 4);
      ctx.lineTo(s, (i * s) / 4);
      ctx.stroke();
    }
  });
}

/** Zebra crossing: stripes run along v. */
export function makeCrosswalkTexture(): THREE.CanvasTexture {
  return canvas(128, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(235,235,230,0.92)';
    const stripes = 6;
    for (let i = 0; i < stripes; i++) {
      ctx.fillRect(0, (i + 0.15) * (s / stripes), s, (s / stripes) * 0.55);
    }
  });
}

export function makeGrassTexture(dark: boolean): THREE.CanvasTexture {
  return canvas(256, (ctx, s) => {
    ctx.fillStyle = dark ? '#4c6339' : '#6d8a4d';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const g = (dark ? 80 : 115) + Math.random() * 45;
      ctx.fillStyle = `rgba(${g * 0.55},${g},${g * 0.42},0.55)`;
      ctx.beginPath();
      ctx.arc(Math.random() * s, Math.random() * s, 1.5 + Math.random() * 5, 0, 7);
      ctx.fill();
    }
  });
}

export function makeSandTexture(): THREE.CanvasTexture {
  return canvas(128, (ctx, s) => {
    ctx.fillStyle = '#cfc09a';
    ctx.fillRect(0, 0, s, s);
    noise(ctx, s, 0.12, 150);
  });
}

/** Facade cell grid: FACADE_CELLS × FACADE_CELLS windows per texture repeat.
 * One cell ≈ 3m × 3m, so one repeat covers FACADE_METERS of wall. */
export const FACADE_CELLS = 4;
export const FACADE_METERS = FACADE_CELLS * 3;

// Which cells are lit at night — shared between facade + emissive maps.
const litCells: boolean[] = Array.from({ length: FACADE_CELLS * FACADE_CELLS }, () => Math.random() < 0.42);

function eachCell(s: number, fn: (cx: number, cy: number, cs: number, i: number) => void): void {
  const cs = s / FACADE_CELLS;
  for (let j = 0; j < FACADE_CELLS; j++) {
    for (let i = 0; i < FACADE_CELLS; i++) {
      fn(i * cs, j * cs, cs, j * FACADE_CELLS + i);
    }
  }
}

export function makeFacadeTexture(): THREE.CanvasTexture {
  return canvas(512, (ctx, s) => {
    ctx.fillStyle = '#e3e0da';
    ctx.fillRect(0, 0, s, s);
    noise(ctx, s, 0.05, 160);
    eachCell(s, (cx, cy, cs) => {
      const jitter = Math.random() * 14 - 7;
      ctx.fillStyle = `rgb(${90 + jitter},${106 + jitter},${120 + jitter})`;
      ctx.fillRect(cx + cs * 0.28, cy + cs * 0.22, cs * 0.44, cs * 0.5);
      ctx.fillStyle = '#3d4b58';
      ctx.fillRect(cx + cs * 0.31, cy + cs * 0.26, cs * 0.38, cs * 0.42);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(cx + cs * 0.28, cy + cs * 0.7, cs * 0.44, cs * 0.04);
    });
  });
}

/** Emissive lit-windows map (night). Same cell layout as facade. */
export function makeFacadeEmissiveTexture(): THREE.CanvasTexture {
  return canvas(512, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, s, s);
    eachCell(s, (cx, cy, cs, i) => {
      if (!litCells[i]) return;
      ctx.fillStyle = `rgba(255,${200 + Math.random() * 30},${130 + Math.random() * 40},${0.75 + Math.random() * 0.25})`;
      ctx.fillRect(cx + cs * 0.31, cy + cs * 0.26, cs * 0.38, cs * 0.42);
    });
  });
}

export interface SharedMaterials {
  roadMajor: THREE.MeshStandardMaterial;
  roadMinor: THREE.MeshStandardMaterial;
  path: THREE.MeshStandardMaterial;
  sidewalk: THREE.MeshStandardMaterial;
  crosswalk: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  forest: THREE.MeshStandardMaterial;
  sand: THREE.MeshStandardMaterial;
  parking: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  tree: THREE.MeshStandardMaterial;
  pole: THREE.MeshStandardMaterial;
  lampHead: THREE.MeshStandardMaterial;
  vehicle: THREE.MeshStandardMaterial;
  person: THREE.MeshStandardMaterial;
}

let shared: SharedMaterials | undefined;

export function getMaterials(): SharedMaterials {
  if (shared) return shared;

  const roadTexMajor = makeRoadTexture(true);
  const roadTexMinor = makeRoadTexture(false);
  const pavementTex = makePavementTexture();
  const crossTex = makeCrosswalkTexture();
  const grassTex = makeGrassTexture(false);
  const forestTex = makeGrassTexture(true);
  const sandTex = makeSandTexture();
  const facadeTex = makeFacadeTexture();
  const facadeEmissiveTex = makeFacadeEmissiveTexture();
  grassTex.repeat.set(1 / 14, 1 / 14);
  forestTex.repeat.set(1 / 14, 1 / 14);
  sandTex.repeat.set(1 / 10, 1 / 10);
  pavementTex.repeat.set(1 / 2, 1 / 2);

  shared = {
    roadMajor: new THREE.MeshStandardMaterial({ map: roadTexMajor, roughness: 0.92 }),
    roadMinor: new THREE.MeshStandardMaterial({ map: roadTexMinor, roughness: 0.94 }),
    path: new THREE.MeshStandardMaterial({ color: 0x8f8d86, roughness: 1 }),
    sidewalk: new THREE.MeshStandardMaterial({ map: pavementTex, roughness: 1 }),
    crosswalk: new THREE.MeshStandardMaterial({
      map: crossTex, transparent: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.9,
    }),
    grass: new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
    forest: new THREE.MeshStandardMaterial({ map: forestTex, roughness: 1 }),
    sand: new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 }),
    parking: new THREE.MeshStandardMaterial({ color: 0x4a4c52, roughness: 0.95 }),
    water: new THREE.MeshStandardMaterial({
      color: 0x2e5d7a, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.92,
    }),
    wall: new THREE.MeshStandardMaterial({
      map: facadeTex, vertexColors: true, roughness: 0.85,
      emissive: 0xffc87a, emissiveIntensity: 0, emissiveMap: facadeEmissiveTex,
    }),
    roof: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
    tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }),
    pole: new THREE.MeshStandardMaterial({ color: 0x4c5157, roughness: 0.6, metalness: 0.6 }),
    lampHead: new THREE.MeshStandardMaterial({
      color: 0x777770, emissive: 0xffdc9a, emissiveIntensity: 0, roughness: 0.5,
    }),
    vehicle: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.55 }),
    person: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
  };
  return shared;
}
