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
| Veri (tam) | z15 | ~0.95 km | 1 (3×3) | OSM: bina/yol/alan/POI → 3D, ajan + çarpışma kaydı |
| Veri (hafif LOD) | z15 | ~0.95 km | 2 (5×5 halka) | Yalnız bina+yol+alan; ağaç/donatı/ajan yok. Kamera yaklaşınca tam moda yeniden kurulur |

Akış döngüsü (0.5 s'de bir): kamera karosu değiştiyse eksik karolar yüklenir, `unloadRadius` dışındakiler dispose edilir. Veri karosu kurulmadan önce arazi örnekleyicisinin hazır olması beklenir (her şey araziye "drape" edilir).

**Tekilleştirme**: Bir OSM ögesi birden çok karoda görünebilir (Overpass bbox taşması). Global bir `claims` haritası ilk yükleyen karoya sahipliği verir; karo boşaltılınca iddia düşer.

## DEM hattı

1. `CopernicusSource`: 1°×1° COG hücreleri — OpenTopography S3 aynası (`opentopography.s3.sdsc.edu/raster/COP30`; ESA'nın `copernicus-dem-30m` bucket'ı CORS başlığı göndermediğinden tarayıcıdan doğrudan kullanılamıyor). `geotiff.js` HTTP range-request ile yalnızca gereken pencereyi okur (z14 karosu başına ~70×70 piksel). Hücre önbelleği oturum içi; grid önbelleği IndexedDB.
2. İlk erişim başarısızsa (CORS/ağ) kalıcı olarak `TerrariumSource`'a düşülür (PNG karo → `(R·256+G+B/256)−32768`).
3. `TerrainManager.sample(x,z)`: yüklü grid'lerde bilineer enterpolasyon; kapsam dışıysa en yakın karoya kenetlenir. **Binalar, yollar, ağaçlar, ajanlar ve oyuncu dahil her şey bu örnekleyiciyle araziye oturur.**

## 2D → 3D üretim motoru

- **Binalar** (`buildings.ts`): taban halkası → duvar quad'ları (metre-uv cephe dokusu, gece emissive pencere haritası) + çatı: beşik (`gabled`), kırma (`hipped` — mahya içeri çekilir, uçlar çatı üçgeni olur), piramit (`pyramidal/dome` — merkezden fan) veya düz. `roof:shape` etiketi öncelikli; etiketsiz alçak konut dörtgenleri prosedürel olarak beşik/kırma/düz karışımı alır. Renkler: `building:colour`/`roof:colour` etiketleri (CSS renk, doygunluk kelepçeli) → kullanım stili (USE_STYLES) → genişletilmiş prosedürel palet. Yükseklik: `height` → `building:levels`×3.1 → tür bazlı varsayılan + deterministik jitter. Karo başına 2 duvar mesh'i (pencereli/sağır) + 1 çatı mesh'i.
- **Otopark araçları** (`parking.ts`): `amenity=parking` alanları en uzun kenara hizalı sıralarla (sıra aralığı 9.5 m, araç aralığı 3 m) park halinde araçlarla doldurulur; her nokta poligon/bina izi/taşıt yolu testinden geçer. Doluluk bugün lot başına deterministik %35-80 simülasyonudur — Faz 6'da canlı otopark API'sine bağlanınca yalnız oran değişecek, yerleşim kodu aynı kalacak. Kapasite/park/doluluk metadatası inceleme modalında görünür.
- **Tıkla-incele** (`featureIndex.ts` + `ui/inspector.ts`): her karonun ham spec'leri (bina/yol/alan/POI/kavşak/otopark) uzamsal indekste tutulur; izometrik modda tıklama raycast + nokta sorgusuyla modal açar — ham OSM etiketleri, motorun kararları (yükseklik, sınıf, köprü/tünel/kat, kavşak kol sayısı), OSM linki. `window.__twinio.inspect(x,z)` ile programatik erişim (e2e/konsol).
- **Çarpışma** (`collision.ts`): bina taban kenarları 8 m'lik uniform grid hash'e yazılır; yürüme modunda oyuncu dairesi (r=0.45) yakın kenarlardan dışarı itilir (2 geçiş, kayarak ilerleme).
- **Yollar** (`roads.ts`): polyline → miter-join şerit (ribbon), sınıf bazlı genişlik; ana yollarda şerit çizgisi dokusu. Kaldırımlar merkez çizgiden offset. OSM `crossing` node'ları en yakın yol segmentine kenetlenip zebra decal olur. Y-ofset katmanlaması z-fighting'i önler (alan < patika < yol < kaldırım < zebra).
- **Alanlar** (`greenery.ts`): `ShapeGeometry` araziye vertex bazında drape edilir; dünya-uzayı UV. Ağaçlar polygon içine deterministik (feature-id seed) serpilir, türe göre yoğunluk (orman > park > çim), karo başına tek `InstancedMesh`.
- **Donatılar** (`props.ts`): OSM lamba node'ları + aydınlatılmış yollar boyunca ~27 m aralıkla prosedürel lambalar (9 m grid ile çakışma önleme). Trafik ışıkları instanced; faz döngüsü instanceColor ile sürülür.

## Veri bozukluğuna karşı motor kuralları

OSM/DEM verisi mükemmel değildir; görüntü bütünlüğünü motor garanti eder:

1. **Yol drape**: her yol polyline'ı ~9 m'de bir alt bölümlenir ve vertex-vertex araziye oturtulur — uzun segmentlerin arazi altında kalması imkânsızlaşır. Araç grafiği de aynı alt bölümlenmiş noktaları kullanır (araçlar yokuşu takip eder).
2. **Kenar/merkez max kuralı**: şerit kenarı, merkez hattın arazi kotunun altına inemez — yanal eğimde yol araziyle yatıklaşır ama gömülmez.
3. **Mikro-jitter**: her yol, id'sinden türetilen 0–3.5 cm'lik deterministik y-ofseti alır — aynı sınıftan çakışan yollarda z-fighting oluşmaz (katman sırası: alan < patika < yol < kaldırım < zebra korunur).
4. **Taban izi (footprint) kuralı**: karo başına bina tabanları 16 m'lik grid hash'e yazılır; **bina içine düşen kaldırım segmenti, sokak lambası ve ağaç üretilmez**. Yayalar yalnız bina dışındaki kaldırım koşularında yürür.
5. **Kentsel zemin**: arazi tabanı nötr toprak/beton tonundadır; yeşillik yalnız OSM poligonlarından gelir — şehir merkezi çim halıya dönmez.
6. **Üçgen-tutarlı örnekleyici**: yükseklik örnekleyici, arazi mesh'inin render ettiği üçgen yüzeyin TA KENDİSİNİ enterpolasyon yapar (bilinear değil) — örneklenen her nokta görünen yüzeyle birebir aynıdır.
7. **DEM bekleme kuralı**: veri karosu, kapsadığı alan (+300 m taşma payı) DEM ile örtülmeden asla kurulmaz — tahmini yükseklikle inşa edilip sonradan arazi altında kalan geometri oluşamaz.
8. **Orta nokta sondajı**: yol vertex yüksekliği, komşu vertex'lere giden orta noktaların arazi kotunu da yoklar — iki örnek arasındaki arazi sırtı şeridi delemez.
9. **Topolojik kavşaklar (birinci sınıf nesne)**: ≥3 kolun buluştuğu her düğüm bir `Junction` nesnesidir. Her kolun görsel geometrisi (şerit + kaldırım) kavşaktan `ext` kadar **geriye kırpılır** — kavşağın içine ribbon hiç girmez, şerit çizgileri ağızda biter. Kol ağızlarının köşe noktalarından örülen **plaka poligonu kavşağın gerçek yüzeyidir** (örtü değil). Araç grafiği kırpılmamış hattı kullanır: araçlar plakanın üzerinden geçer. Komşu kolların kaldırım uçları **kerb kavisleriyle** birbirine bağlanır — kaldırım kavşak çevresinde kesintisiz akar, yaya hatları köşeleri döner. Kavşak sahipliği karo-bazlı claim ile tekildir; simülasyon katmanı (faz planları, dönüş hareketleri) bu nesneye bağlanacaktır.
10. **Taşıt yolu açıklık kuralı**: kaldırım vertex'leri ve lambalar, *kendi yolu hariç* her yolun taşıt yolu genişliğine (grid hash, nokta-segment mesafesi) karşı test edilir — başka bir yolun asfaltına düşen kaldırım segmenti/lamba üretilmez. Kural geometrisi **sahiplik (claim) bağımsızdır**: komşu karonun render ettiği yollar da bu karonun kurallarına girer, karo sınırındaki kesişimler de temizdir.
11. **Offset katlanma ayıklama**: kaldırım offset çizgisinin bir segmenti, ebeveyn segmentine ters yönde akıyorsa (iç bükey keskin köşede kendi üzerine katlanma) o vertex'ler atılır — soluk üçgen/kama artıkları oluşamaz.
12. **Alan drape kuralı**: yeşil alan/otopark/kum/iç su poligonlarının üçgenleri, en uzun kenar ~16 m altına inene dek 4'lü alt bölümlemeyle inceltilir ve her vertex araziye oturtulur — dev düz üçgenlerin engebeli arazide gömülmesi/z-fighting yapması imkânsızlaşır (üçgen bütçesi poligon alanına göre ~20k ile sınırlanır). Üst üste binen OSM alanları (park+çim mükerrerleri) deterministik y-jitter ile ayrışır. İç sular da drape edilir: DSM su yüzeyi kotunu taşıdığından nehirler doğal eğimle akar.
13. **Deniz üretimi**: OSM'de deniz poligonu yoktur — `natural=coastline` way'leri (kara solda, su sağda) karo dikdörtgenine kırpılır, art arda gelen way'ler uç noktalarından dikişlenir ve zincirler dikdörtgen çevresi boyunca (x-kuzey uzayında saat yönünde) kapatılarak deniz poligonları üretilir. Kıyısı olmayan açık deniz karoları DEM sezgiseliyle (veri yok + tüm kotlar ≈ 0) tam karo su tabakası alır. DSM'nin su üstü radar gürültüsü (±1-2 m) arazi grid'inde 0'a oturtulur; deniz +0.3 m sabit kottadır — arazi denizi asla delemez.
14. **Katman bantları**: zone(0.04) < alan(0.08) < iç su(0.12) < patika(0.14) < tali yol(0.18) < ana yol(0.22) < kavşak plakası(0.26) < deniz(0.3) < kaldırım(0.30) < zebra(0.32); her bant kendi jitter payına sahiptir, bantlar kesişmez.
15. **Logaritmik derinlik tamponu**: standart derinlik tamponunun hassasiyeti 500 m mesafede ~15 cm'dir — cm'lik katman bantları uzak/izometrik bakışta tampona sığmaz ve her şey titrer. Log-depth ile hassasiyet her mesafede ~mm'dir; bantlar kuşbakışında da ayrık kalır.
16. **Sabit yukarı normal**: drape edilen alan/bölge/su yüzeyleri yüzey normalini araziden değil sabit +y'den alır — dokusuz düz renkli katmanlarda alt bölümleme üçgenlerinin facet'li aydınlanması (üçgen yaması görüntüsü) oluşamaz.
17. **Köprü/viyadük profili**: `bridge=yes` way'ler araziye drape edilmez; tabliye, iki başlangıç kotu arasında düz bir profil izler (`max(doğrusal, arazi+0.3)` — DSM tümseklerini tolere eder). Tabliye kenarlarına korkuluk duvarları, arazi ile arasında >3.2 m boşluk olan yerlere ~26 m arayla beton ayaklar dikilir. Araç/yaya ajanları da aynı profili kullanır — köprüden gerçekten geçilir. Katman ayrımı: köprü kolları kavşak sayılmaz, üstgeçit altındaki zemin kaldırımlarını bloklamaz (clearance grid'i kat-duyarlıdır).
18. **Altgeçit/tünel**: `tunnel=yes` way'ler (≤500 m) portal-portal doğrusal profil alır; DSM dar hendeği düzlediği için verinin İMA ETTİĞİ çukur sentezlenir — üstten geçen zemin-seviyesi her yol için profil, kesişimde o yolun 5.2 m altına bastırılır (%12 rampalarla portallara geri bağlanır). Arazi mesh'inde koridor vertex'leri taban kotuna indirilir ve koridor üstü fragment'lar alpha maskesiyle delinir (karo başına 512² discard maskesi, uv1 kanalı) — hendek gerçekten açılır, içinden geçilir. Yol şeridi hendek tabanını duvardan duvara doldurur, gömülü kesimlere istinat duvarları örülür. Diğer tüm dünya geometrisi KESİLMEMİŞ yüzeye drape edilir: üstteki yol hendeğin üzerinden kapak gibi geçer; hendek üstüne denk gelen alan/bölge üçgenleri ayıklanır (renkli kapak asılı kalamaz). >500 m dağ tünelleri hiç üretilmez (açık hendek olarak gösterilemez).
19. **Su üstü arazi bastırma**: deniz poligonu bilinen her yerde arazi grid'i deniz tabanına (-0.6) bastırılır — boğaz/koy üstündeki metrelerce DSM radar gürültüsü (akıntı, gemiler, köprü tabliyesi izi) su tabakasını delemez. Açık-deniz sezgiseli kantil bazlıdır (9 örneğin 7'si <1.5 m): karoyu kesen köprü tabliyesinin DSM izi tek başına kararı bozamaz; köprü/tünel way'leri ve bölge (zone) taşmaları karoyu "karasal" saymaz. Kara tintleri (zone/yeşil/otopark) su poligonu içine veya kot-0 DSM düzlüğüne drape edilmez (plaj/kum ve iç su hariç).
20. **Kıyı dikişi baş-öncelikli**: art arda gelen coastline way'leri birleştirilirken zincir BAŞLARINDAN (başka way'in sonu olmayan başlangıçlar) başlanır — rastgele tohumlama, akış aşağı parçayı erken tüketip kıyıyı karo içinde kopan ölü zincirlere böler ve deniz poligonu hiç üretilemezdi.

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
