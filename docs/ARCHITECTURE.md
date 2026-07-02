# Twinio Mimari Notları

## Koordinat sistemi

- Dünya uzayı: başlangıç noktasına (origin lat/lon) merkezli **yerel teğet düzlem**, metre cinsinden.
- `+x = doğu`, `+y = yukarı (rakım)`, `+z = güney` (three.js kamerasının varsayılan bakışı -z = kuzey).
- Origin'den ~5 km içinde float32 hassasiyeti yeterli. Işınlama (arama) origin'i sıfırlayıp dünyayı yeniden kurar — böylece hassasiyet hiç bozulmaz.

## Karo akışı (streaming)

İki bağımsız karo katmanı vardır:

| Katman | Zoom | Boyut (~41°K) | Yarıçap | İçerik |
| --- | --- | --- | --- | --- |
| Arazi | z14 | ~1.9 km | 1 (3×3) | DEM grid 65×65, mesh + yükseklik örnekleyici |
| Veri | z15 | ~0.95 km | 1 (3×3) | OSM: bina/yol/alan/POI → 3D |

Akış döngüsü (0.5 s'de bir): kamera karosu değiştiyse eksik karolar yüklenir, `unloadRadius` dışındakiler dispose edilir. Veri karosu kurulmadan önce arazi örnekleyicisinin hazır olması beklenir (her şey araziye "drape" edilir).

**Tekilleştirme**: Bir OSM ögesi birden çok karoda görünebilir (Overpass bbox taşması). Global bir `claims` haritası ilk yükleyen karoya sahipliği verir; karo boşaltılınca iddia düşer.

## DEM hattı

1. `CopernicusSource`: 1°×1° COG hücreleri — OpenTopography S3 aynası (`opentopography.s3.sdsc.edu/raster/COP30`; ESA'nın `copernicus-dem-30m` bucket'ı CORS başlığı göndermediğinden tarayıcıdan doğrudan kullanılamıyor). `geotiff.js` HTTP range-request ile yalnızca gereken pencereyi okur (z14 karosu başına ~70×70 piksel). Hücre önbelleği oturum içi; grid önbelleği IndexedDB.
2. İlk erişim başarısızsa (CORS/ağ) kalıcı olarak `TerrariumSource`'a düşülür (PNG karo → `(R·256+G+B/256)−32768`).
3. `TerrainManager.sample(x,z)`: yüklü grid'lerde bilineer enterpolasyon; kapsam dışıysa en yakın karoya kenetlenir. **Binalar, yollar, ağaçlar, ajanlar ve oyuncu dahil her şey bu örnekleyiciyle araziye oturur.**

## 2D → 3D üretim motoru

- **Binalar** (`buildings.ts`): taban halkası → duvar quad'ları (metre-uv cephe dokusu, gece emissive pencere haritası) + `ShapeGeometry` çatı (delik destekli). Yükseklik: `height` → `building:levels`×3.1 → tür bazlı varsayılan + deterministik jitter. Karo başına 2 birleştirilmiş mesh (duvar + çatı).
- **Yollar** (`roads.ts`): polyline → miter-join şerit (ribbon), sınıf bazlı genişlik; ana yollarda şerit çizgisi dokusu. Kaldırımlar merkez çizgiden offset. OSM `crossing` node'ları en yakın yol segmentine kenetlenip zebra decal olur. Y-ofset katmanlaması z-fighting'i önler (alan < patika < yol < kaldırım < zebra).
- **Alanlar** (`greenery.ts`): `ShapeGeometry` araziye vertex bazında drape edilir; dünya-uzayı UV. Ağaçlar polygon içine deterministik (feature-id seed) serpilir, türe göre yoğunluk (orman > park > çim), karo başına tek `InstancedMesh`.
- **Donatılar** (`props.ts`): OSM lamba node'ları + aydınlatılmış yollar boyunca ~27 m aralıkla prosedürel lambalar (9 m grid ile çakışma önleme). Trafik ışıkları instanced; faz döngüsü instanceColor ile sürülür.

## Ajanlar

- **Yol grafı**: OSM yolları kavşaklarda bölünmüş geldiğinden her way bir kenardır; uçlar 1 m'ye yuvarlanan düğüm anahtarlarıyla bağlanır. Karo yüklendikçe/boşaldıkça kenarlar eklenir/silinir.
- **Araçlar**: tek `InstancedMesh` (kapasite 140). Kenar üzerinde ilerler, düğümde rastgele dönüş (oneway'e saygılı), sağ şerit ofseti, yol sınıfına göre hız. Kamera yakınında doğar, uzaklaşınca geri dönüştürülür.
- **Yayalar**: kaldırım/patika polyline'larında gidip gelir; bob animasyonu; tek `InstancedMesh`.

## Işık / gölge / gece

- `Sky` shader + saat kaydırıcısından güneş konumu; ACES tone mapping, pozlama saatle değişir.
- Tek yönlü ışık gölgesi: 2048² harita, kamerayı 20 m grid'e kenetlenerek takip eden ±160 m ortho frustum (shimmer önleme).
- Gece: cephe emissive haritası yanar, lamba başlıkları emissive olur, kameraya en yakın 8 lambaya gerçek `PointLight` atanır (0.7 s'de bir yeniden seçilir).

## Performans bütçesi

- Karo başına ~10-14 draw call (birleştirilmiş kategori mesh'leri + instanced setler); 3×3 sahnede tipik 100-150 call.
- Ağaç/lamba/araç/yaya instancing; ajan mesh'lerinde `frustumCulled=false` (instance'lar dağınık).
- Geometri üretimi kare aralarına dilimlenir (`requestAnimationFrame` yield) — ana thread uzun süre kilitlenmez. Sonraki adım: Web Worker'a taşımak.
- Overpass: eşzamanlılık 2, endpoint failover, 7 gün IndexedDB önbelleği.
