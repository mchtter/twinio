# Twinio — Gezilebilir Dijital İkiz

**OSM + Copernicus** verileriyle, tarayıcıda çalışan, içinde birinci şahıs olarak gezilebilir, etkileşimli bir dijital ikiz platformu.

> 🌍 Canlı demo: GitHub Pages üzerinde yayında (repo ayarlarındaki Pages bağlantısı).
> URL parametreleriyle başlangıç noktası seçilebilir: `?lat=39.92&lon=32.85&hour=21`

## Ne yapıyor?

- **Arazi**: Copernicus GLO-30 DEM (AWS Open Data üzerindeki COG'lardan doğrudan tarayıcıya, `geotiff.js` ile aralıklı okuma). Erişilemezse otomatik olarak Terrarium DEM'e düşer.
- **Şehir dokusu**: OSM Overpass API'den binalar, yollar, kaldırımlar, yeşil alanlar (park/orman/mezarlık/çim…), su, kumsal, otoparklar.
- **3D üretim motoru**: 2D vektör katmanlarını gerçek zamanlı 3D'ye çevirir — bina ekstrüzyonu (pencere dokulu cepheler, gece yanan pencereler), şerit çizgili yollar, yaya geçitleri (zebra), kaldırımlar.
- **Donatılar**: OSM'deki sokak lambası / trafik ışığı / yaya geçidi node'ları + ana yollar boyunca prosedürel sokak aydınlatması. Trafik ışıkları faz döngüsüyle çalışır.
- **Ajanlar**: Yol grafında dolaşan araçlar, kaldırım ve patikalarda yürüyen yayalar.
- **Gün döngüsü**: Fiziksel gökyüzü, güneş açısına bağlı aydınlatma, gece modunda sokak lambaları (gerçek point-light havuzu) ve yanan bina pencereleri.
- **Optimizasyon**: Sadece kamera çevresindeki bölge yüklenir (karo akışı), karo başına geometri birleştirme (draw call ~10/karo), ağaç/lamba/araç/yaya için instancing, IndexedDB veri önbelleği, sis + uzaklık kırpma, gölge frustum'u kamerayı takip eder.

## Kullanım

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # üretim derlemesi (dist/)
```

**Kontroller**: Tıkla → imleç kilidi · `WASD` hareket · `Shift` hızlı · `F` yürüme/uçuş · uçuşta `E/Q` yüksel/alçal · `ESC` imleci bırak.

**HUD**: konum arama (Nominatim), saat kaydırıcısı (gün/gece), katman aç/kapa (binalar, yollar, yeşil, ağaçlar, su, donatılar, araçlar, yayalar), FPS/çizim istatistikleri.

## Mimari

```text
src/
├─ config.ts            # tüm ayarlar (karo yarıçapları, hızlar, limitler)
├─ geo/                 # projeksiyon (yerel ENU), slippy tile matematiği, IndexedDB önbelleği
├─ terrain/             # Copernicus COG + Terrarium kaynakları, arazi mesh + yükseklik örnekleyici
├─ data/                # Overpass sorguları, OSM → spec ayrıştırıcı, karo bazlı tekilleştirme
├─ world/               # 2D→3D üreticiler: binalar, yollar, yeşil/su, donatılar + karo akış yöneticisi
├─ agents/              # yol grafı, araç ve yaya sistemleri (instanced)
├─ core/                # kontroller (yürü/uç), gökyüzü/aydınlatma/gölge ortamı
└─ ui/                  # HUD (istatistik, katmanlar, saat, arama)
```

Ayrıntı: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Yol haritası: [docs/ROADMAP.md](docs/ROADMAP.md)

## Veri kaynakları

| Katman | Kaynak | Erişim |
| --- | --- | --- |
| Arazi (DEM) | Copernicus GLO-30 (ESA) | OpenTopography S3 aynası (COG, CORS'lu range-request; AWS ana bucket'ı CORS başlığı göndermediği için tarayıcıdan kullanılamıyor) |
| Arazi (yedek) | Terrarium (Mapzen/Joerd) | AWS S3 PNG karoları |
| Binalar, yollar, alanlar, POI | OpenStreetMap | Overpass API (7 gün IndexedDB önbelleği) |
| Coğrafi arama | Nominatim | OSM |

## Lisans / Atıf

Kod: MIT. Harita verisi © OpenStreetMap katkıcıları (ODbL). DEM: © ESA — Copernicus DEM GLO-30.
