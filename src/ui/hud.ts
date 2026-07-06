import { CONFIG } from '../config';

export interface HudCallbacks {
  onHourChange: (hour: number) => void;
  onLayerToggle: (cat: string, visible: boolean) => void;
  onSearch: (query: string) => void;
  onLockRequest: () => void;
  onShadowToggle: (on: boolean) => void;
  onScenarioToggle: (on: boolean) => void;
  onInspectorClose?: () => void;
}

const LAYERS: [string, string][] = [
  ['buildings', 'Binalar'],
  ['roads', 'Yollar'],
  ['areas', 'Yeşil Alanlar'],
  ['trees', 'Ağaçlar'],
  ['water', 'Su'],
  ['props', 'Donatılar'],
  ['vehicles', 'Araçlar'],
  ['pedestrians', 'Yayalar'],
];

/** DOM overlay: stats, time-of-day, layer toggles, location search, hints. */
export class Hud {
  private stats: HTMLElement;
  private toast: HTMLElement;
  private toastTimer: number | undefined;
  private lockOverlay: HTMLElement;
  private modeLabel: HTMLElement;

  constructor(private cb: HudCallbacks) {
    document.body.insertAdjacentHTML(
      'beforeend',
      `
      <div id="hud-left" class="hud panel">
        <h1>TWINIO <span>DİJİTAL İKİZ</span></h1>
        <div id="hud-stats">yükleniyor…</div>
      </div>
      <div id="hud-right" class="hud">
        <div class="panel">
          <div class="sec">Konum</div>
          <div id="search-box">
            <input id="search-input" type="text" placeholder="Şehir / adres ara…" />
            <button id="search-btn">Git</button>
          </div>
        </div>
        <div class="panel">
          <div class="sec">Saat: <span id="hour-label">13:00</span></div>
          <div class="row"><input id="hour-slider" type="range" min="0" max="24" step="0.25" value="13" /></div>
          <label style="margin-top:6px"><input id="shadow-chk" type="checkbox" checked /> Gölgeler</label>
        </div>
        <div class="panel">
          <div class="sec">Katmanlar</div>
          <div class="grid" id="layer-grid"></div>
        </div>
        <div class="panel">
          <div class="sec">Senaryo</div>
          <button id="scenario-traffic" class="btn scen-btn">🚦 Trafik Yoğunluğu</button>
        </div>
      </div>
      <div id="hud-help" class="hud panel">
        Mod: <b id="mode-label">izometrik</b> · <b>tık</b> incele · <b>F</b> mod değiştir · <b>sürükle</b> kaydır · <b>sağ tık / Q·E</b> döndür · <b>tekerlek</b> zoom · <b>WASD</b> hareket · <b>Shift</b> hızlı
      </div>
      <div id="hud-toast" class="hud hidden"></div>
      <div id="inspector" class="hud panel hidden">
        <button id="inspector-close" title="Kapat">×</button>
        <div id="inspector-body"></div>
      </div>
      <div id="lock-overlay" class="hidden">
        <div class="inner"><b>Yürüme Modu</b><br/><br/>Bakışı kilitlemek için tıkla<br/><span style="font-size:12px;color:#8fa0b8">fare ile bak · WASD ile yürü · ESC imleci bırakır · F izometrik görünüme döner</span></div>
      </div>
      `,
    );

    this.stats = document.getElementById('hud-stats')!;
    this.toast = document.getElementById('hud-toast')!;
    this.lockOverlay = document.getElementById('lock-overlay')!;
    this.modeLabel = document.getElementById('mode-label')!;

    const grid = document.getElementById('layer-grid')!;
    for (const [cat, label] of LAYERS) {
      const el = document.createElement('label');
      el.innerHTML = `<input type="checkbox" checked data-cat="${cat}" /> ${label}`;
      grid.appendChild(el);
      el.querySelector('input')!.addEventListener('change', (e) => {
        const t = e.target as HTMLInputElement;
        cb.onLayerToggle(cat, t.checked);
      });
    }

    const slider = document.getElementById('hour-slider') as HTMLInputElement;
    const hourLabel = document.getElementById('hour-label')!;
    slider.addEventListener('input', () => {
      const h = parseFloat(slider.value);
      const hh = Math.floor(h) % 24;
      const mm = Math.round((h % 1) * 60);
      hourLabel.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      cb.onHourChange(h);
    });

    (document.getElementById('shadow-chk') as HTMLInputElement).addEventListener('change', (e) => {
      cb.onShadowToggle((e.target as HTMLInputElement).checked);
    });

    const scenBtn = document.getElementById('scenario-traffic')!;
    scenBtn.addEventListener('click', () => {
      cb.onScenarioToggle(scenBtn.classList.toggle('on'));
    });

    const input = document.getElementById('search-input') as HTMLInputElement;
    const go = () => {
      if (input.value.trim()) cb.onSearch(input.value.trim());
    };
    document.getElementById('search-btn')!.addEventListener('click', go);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
      e.stopPropagation();
    });

    this.lockOverlay.addEventListener('click', () => cb.onLockRequest());
    document.getElementById('inspector-close')!.addEventListener('click', () => this.hideInspector());
  }

  /** Click-to-inspect modal (debug: OSM tags + engine decisions). */
  showInspector(html: string): void {
    document.getElementById('inspector-body')!.innerHTML = html;
    document.getElementById('inspector')!.classList.remove('hidden');
  }

  hideInspector(): void {
    document.getElementById('inspector')!.classList.add('hidden');
    this.cb.onInspectorClose?.();
  }

  setHourFromUrl(h: number): void {
    const slider = document.getElementById('hour-slider') as HTMLInputElement;
    slider.value = String(h);
    slider.dispatchEvent(new Event('input'));
  }

  setLocked(locked: boolean): void {
    this.lockOverlay.classList.toggle('hidden', locked);
  }

  setMode(mode: string): void {
    this.modeLabel.textContent = mode === 'walk' ? 'YÜRÜME' : 'izometrik';
  }

  showToast(msg: string, ms = 4000): void {
    this.toast.textContent = msg;
    this.toast.classList.remove('hidden');
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.add('hidden'), ms);
  }

  updateStats(s: {
    fps: number;
    lat: number;
    lon: number;
    elev: number;
    tiles: number;
    loading: number;
    calls: number;
    tris: number;
    dem: string;
  }): void {
    this.stats.textContent =
      `FPS: ${s.fps.toFixed(0)}\n` +
      `Konum: ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}\n` +
      `Rakım: ${s.elev.toFixed(1)} m\n` +
      `Karolar: ${s.tiles}${s.loading > 0 ? ` (+${s.loading} yükleniyor)` : ''}\n` +
      `Çizim: ${s.calls} çağrı · ${(s.tris / 1000).toFixed(0)}k üçgen\n` +
      `DEM: ${s.dem}`;
  }

  /** Geocode with Nominatim and hand back the first hit. */
  async geocode(query: string): Promise<{ lat: number; lon: number; name: string } | null> {
    try {
      const url = `${CONFIG.nominatimUrl}?format=json&limit=1&q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) return null;
      const arr = (await resp.json()) as { lat: string; lon: string; display_name: string }[];
      if (!arr.length) return null;
      return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), name: arr[0].display_name };
    } catch {
      return null;
    }
  }
}
