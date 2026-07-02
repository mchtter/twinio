# Twinio Yol Haritası

## Faz 0 — Core & Engine ✅ (bu sürüm)

- [x] Karo tabanlı akış motoru (yalnızca çevre bölge render edilir)
- [x] Copernicus GLO-30 DEM arazi + Terrarium yedeği
- [x] OSM 2D katman → 3D üretim motoru (bina/yol/yeşil/su/donatı)
- [x] Yaya geçitleri, kaldırımlar, sokak lambaları, trafik ışıkları
- [x] Gezen araçlar + yürüyen yayalar (instanced ajan sistemi)
- [x] Birinci şahıs yürüme + uçuş modu, gün/gece döngüsü, katman kontrolü
- [x] GitHub Pages deploy

## Faz 1 — Engine sağlamlaştırma (devam ediyor)

- [x] Beşik çatılar: `roof:shape=gabled/hipped` + müstakil ev sezgiseli (dörtgen taban)
- [x] LOD halkası: 5×5 karo, dış halka hafif mod (bina+yol+alan; ağaç/donatı/ajan yok), yaklaşınca tam moda yükseltme
- [x] Oyuncu-bina çarpışması (yürüme modunda taban kenarlarından kayarak itme, 8 m grid hash)
- [ ] Geometri üretimini Web Worker'lara taşıma (ana thread tamamen serbest)
- [ ] Vektör karo sunucusuna geçiş seçeneği (Overpass bağımlılığını azaltır; protomaps/pmtiles)
- [ ] Kırma (hipped) çatı, `building:part` desteği
- [ ] Uzak karolarda ağaç billboard'ları
- [ ] Köprü/viyadük geometrisi, tünel desteği
- [ ] Su shader'ı (dalga/yansıma), yağmur-kar efektleri

## Faz 2 — Trafik simülasyonu (başladı)

- [x] Araçların trafik ışıklarına uyması (kırmızı/sarıda kavşak öncesi durma, ivmelenme/fren modeli)
- [x] Basit araç takibi: aynı kenarda öndeki araca yavaşlama/durma (kuyruk oluşumu)
- [ ] Tam IDM araç takip modeli, şerit değiştirme
- [ ] Yaya geçitlerine uyma (geçen yayaya durma)
- [ ] Kavşak faz planları (OSM `traffic_signals` gruplaması — karşılıklı kollar aynı fazda)
- [ ] Yoğunluk ısı haritası katmanı, O-D matrisi ile talep üretimi

## Faz 3 — Akıllı kavşak sistemleri

- [ ] Adaptif sinyal kontrolü (kuyruk uzunluğuna göre faz optimizasyonu)
- [ ] Senaryo karşılaştırma: sabit plan vs adaptif (gecikme/kuyruk metrikleri)
- [ ] Gerçek zamanlı sensör verisi entegrasyon arayüzü (MQTT/WebSocket)

## Faz 4 — Afet & acil durum simülasyonları

- [ ] **Deprem**: bina hasar olasılık modeli (yaş/kat/zemin proxy'leri), hasar görselleştirme, enkaz-yol kapanması
- [ ] **Acil toplanma alanları**: kapasite analizi, yürüme mesafesi izokronları, en yakın alan atama
- [ ] **Tahliye**: yaya akış simülasyonu (sosyal kuvvet modeli), darboğaz tespiti
- [ ] Senaryo editörü: yol kapatma, alan tanımlama, rapor çıktısı

## Faz 5 — Platform

- [ ] Belediye/kurum verisi entegrasyonu (GeoJSON/WFS yükleme)
- [ ] Çoklu kullanıcı (paylaşılan görünüm), zaman çizelgesi kaydı/oynatma
- [ ] 3D Tiles / CityGML içe aktarma
