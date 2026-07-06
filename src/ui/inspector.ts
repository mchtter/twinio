import type { InspectResult } from '../world/featureIndex';

/** Context captured at the click: where, what render layer, live agent data. */
export interface InspectContext {
  lat: number;
  lon: number;
  x: number;
  z: number;
  terrain: number;
  cat?: string;
  vehicle?: { speed: number; cruise: number; highway?: string; lane?: number; lanes?: number } | null;
}

const CAT_TR: Record<string, string> = {
  buildings: 'Bina', roads: 'Yol', areas: 'Alan', water: 'Su', trees: 'Ağaç',
  props: 'Donatı', vehicles: 'Araç', terrain: 'Arazi', pedestrians: 'Yaya',
};

const USE_TR: Record<string, string> = {
  residential: 'Konut', commercial: 'Ticari/Ofis', retail: 'Mağaza/AVM', industrial: 'Sanayi',
  stadium: 'Stadyum/Spor', hospital: 'Sağlık', education: 'Eğitim', hotel: 'Otel',
  worship: 'İbadethane', utility: 'Müştemilat',
};

const KIND_TR: Record<string, string> = {
  grass: 'Yeşil alan', forest: 'Orman/Ağaçlık', sand: 'Kum/Plaj', water: 'Su',
  parking: 'Otopark', zone: 'İmar/Kullanım bölgesi',
};

const POI_TR: Record<string, string> = {
  lamp: 'Sokak lambası', signal: 'Trafik ışığı', crossing: 'Yaya geçidi', tree: 'Ağaç',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function osmLink(id: string): string {
  const type = id[0] === 'w' ? 'way' : id[0] === 'n' ? 'node' : 'relation';
  const num = id.slice(1).split('_')[0];
  return `<a href="https://www.openstreetmap.org/${type}/${num}" target="_blank" rel="noopener">OSM ${type}/${num} ↗</a>`;
}

function tagsTable(tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return '<div class="dim">etiket yok</div>';
  const rows = Object.entries(tags)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join('');
  return `<table class="tags">${rows}</table>`;
}

function sec(title: string, body: string): string {
  return `<div class="insp-sec"><div class="insp-title">${title}</div>${body}</div>`;
}

/** Build the inspector modal HTML for a clicked point. */
export function renderInspectorHtml(r: InspectResult, ctx: InspectContext): string {
  const parts: string[] = [];

  parts.push(
    `<div class="insp-head">${CAT_TR[ctx.cat ?? ''] ?? 'Nokta'} incelemesi</div>` +
      `<div class="dim">${ctx.lat.toFixed(6)}, ${ctx.lon.toFixed(6)} · rakım ${ctx.terrain.toFixed(1)} m · ` +
      `dünya (${ctx.x.toFixed(0)}, ${ctx.z.toFixed(0)})</div>`,
  );

  if (ctx.vehicle) {
    parts.push(
      sec(
        'Hareketli araç',
        `<div>Hız: <b>${(ctx.vehicle.speed * 3.6).toFixed(0)} km/s</b> (seyir ${(ctx.vehicle.cruise * 3.6).toFixed(0)})` +
          (ctx.vehicle.highway ? ` · yol: ${esc(ctx.vehicle.highway)}` : '') +
          (ctx.vehicle.lane && ctx.vehicle.lanes ? ` · şerit: ${ctx.vehicle.lane}/${ctx.vehicle.lanes}` : '') +
          `</div>`,
      ),
    );
  }

  if (r.building) {
    const b = r.building;
    parts.push(
      sec(
        `Bina — ${USE_TR[b.use] ?? esc(b.use)}`,
        `<div>${osmLink(b.id)}</div>` +
          `<div>Tür: <b>${esc(b.kind)}</b> · Yükseklik: <b>${b.height.toFixed(1)} m</b>` +
          (b.roofShape ? ` · Çatı: ${b.roofShape}` : '') +
          (b.wallColour ? ` · Renk: ${esc(b.wallColour)}` : '') +
          `</div>` +
          tagsTable(b.tags),
      ),
    );
  }

  if (r.junction) {
    parts.push(
      sec(
        'Kavşak (motorun birleştirdiği)',
        `<div>Kol sayısı: <b>${r.junction.arms}</b> · Plaka yarıçapı: <b>${r.junction.ext.toFixed(1)} m</b> · ` +
          `uzaklık ${r.junction.dist.toFixed(1)} m</div>`,
      ),
    );
  }

  for (let i = 0; i < r.roads.length; i++) {
    const rr = r.roads[i];
    const s = rr.spec;
    const flags = [
      s.bridge ? 'köprü/viyadük' : '',
      s.tunnel ? 'altgeçit/tünel' : '',
      s.level !== 0 ? `kat ${s.level}` : '',
      s.oneway ? 'tek yön' : '',
      s.sidewalks ? 'kaldırımlı' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    parts.push(
      sec(
        `Yol — ${esc(s.highway)} (${rr.dist.toFixed(1)} m)`,
        `<div>${osmLink(s.id)}</div>` +
          `<div>Sınıf: <b>${s.cls}</b> · Genişlik: <b>${s.width.toFixed(1)} m</b>${flags ? ' · ' + flags : ''}</div>` +
          (i === 0 ? tagsTable(s.tags) : ''),
      ),
    );
  }

  if (r.lot) {
    parts.push(
      sec(
        'Otopark doluluk (simülasyon)',
        `<div>Kapasite: <b>${r.lot.capacity}</b> · Park halinde: <b>${r.lot.parked}</b> · ` +
          `Doluluk: <b>%${Math.round(r.lot.occupancy * 100)}</b></div>` +
          `<div class="dim">Faz 6: canlı otopark API bağlanınca bu oran gerçek veriden gelecek</div>`,
      ),
    );
  }

  for (let i = 0; i < r.areas.length; i++) {
    const a = r.areas[i];
    parts.push(
      sec(
        `Alan — ${KIND_TR[a.kind] ?? esc(a.kind)}`,
        `<div>${osmLink(a.id)}</div>` + (i === 0 ? tagsTable(a.tags) : ''),
      ),
    );
  }

  if (r.poi) {
    parts.push(
      sec(
        `Donatı — ${POI_TR[r.poi.kind] ?? esc(r.poi.kind)} (${r.poi.dist.toFixed(1)} m)`,
        `<div>${osmLink(r.poi.id)}</div>` + tagsTable(r.poi.tags),
      ),
    );
  }

  if (parts.length === 1 && !ctx.vehicle) {
    parts.push(sec('Arazi', `<div class="dim">Bu noktada OSM nesnesi yok — çıplak arazi (Copernicus DEM).</div>`));
  }

  return parts.join('');
}
