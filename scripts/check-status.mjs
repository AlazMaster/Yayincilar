// #DeathKO Yayıncılar — Canlı Yayın ve Yeni Video Kontrol Scripti
//
// Bu script GitHub Actions tarafından her ~5 dakikada bir çalıştırılır.
// Hiçbir ücretli servis veya API anahtarı KULLANMAZ:
//  - YouTube: herkese açık RSS akışı (feeds/videos.xml) + /live yönlendirme kontrolü
//  - Kick: kick.com'un genel kanal endpoint'i (merkezi, tek noktadan, nazik bir sıklıkla)
//
// Çıktılar:
//  - status.json           -> sitenin canlı/yeni video rozetlerini okuduğu dosya
//  - data/resolved-ids.json -> @handle -> channelId eşlemesinin önbelleği (gereksiz istek atmamak için)
//
// Bir şey ters giderse (Kick engellerse, YouTube sayfa yapısını değiştirirse vs.)
// script çökmez; o kanal için önceki bilinen durumu korur ve devam eder.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CHANNELS_PATH = path.join(ROOT, "channels.json");
const STATUS_PATH = path.join(ROOT, "status.json");
const RESOLVED_IDS_PATH = path.join(ROOT, "data", "resolved-ids.json");

const NEW_VIDEO_WINDOW_HOURS = 48; // "Yeni Video" rozeti kaç saat görünsün
const REQUEST_TIMEOUT_MS = 10000;
const KICK_DELAY_MS = 500; // Kick isteklerini birbirinden ayır (nazik davran)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      redirect: options.redirect ?? "follow",
      signal: controller.signal,
      headers: { "User-Agent": UA, ...(options.headers || {}) },
    });
  } finally {
    clearTimeout(t);
  }
}

export function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function extractYouTubeHandlePath(url) {
  try {
    const u = new URL(url);
    const first = u.pathname.split("/").filter(Boolean)[0];
    if (!first) return null;
    return `/${first}`;
  } catch {
    return null;
  }
}

async function resolveChannelId(entry, cache) {
  if (entry.channelID) return entry.channelID;
  if (cache[entry.url]) return cache[entry.url];

  const handlePath = extractYouTubeHandlePath(entry.url);
  if (!handlePath) {
    return null;
  }

  try {
    const res = await fetchWithTimeout(`https://www.youtube.com${handlePath}`);
    if (!res.ok) return null;
    const html = await res.text();
    // YouTube sayfa yapısını zaman zaman değiştiriyor (ör. yeni "WIZ" tabanlı
    // düzen). Tek bir alana güvenmek yerine, kanal sayfasında görülmesi
    // muhtemel birkaç farklı yeri sırayla deniyoruz - en kararlı olanlar
    // (RSS besleme linki, canonical link) önce.
    const patterns = [
      /feeds\/videos\.xml\?channel_id=(UC[0-9A-Za-z_-]{22})/,
      /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/,
      /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})"/,
      /"externalId":"(UC[0-9A-Za-z_-]{22})"/,
      /"browseId":"(UC[0-9A-Za-z_-]{22})"/,
      /"channelId":"(UC[0-9A-Za-z_-]{22})"/,
      /<meta itemprop="channelId" content="(UC[0-9A-Za-z_-]{22})">/,
    ];
    let m = null;
    for (const re of patterns) {
      m = html.match(re);
      if (m) break;
    }
    if (m) {
      cache[entry.url] = m[1];
      return m[1];
    }
  } catch (err) {
    log(`[youtube] channelId çözülemedi (${entry.name}):`, err.message);
  }
  return null;
}

async function getLatestVideo(channelId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    );
    if (!res.ok) return null;
    const xml = await res.text();
    return parseLatestVideoFromXml(xml);
  } catch (err) {
    log(`[youtube] RSS okunamadı (${channelId}):`, err.message);
    return null;
  }
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
export function parseLatestVideoFromXml(xml) {
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  if (!entryMatch) return null;
  const block = entryMatch[1];
  const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
  const title = decodeEntities(block.match(/<title>([^<]*)<\/title>/)?.[1]);
  const published = block.match(/<published>([^<]+)<\/published>/)?.[1];
  if (!videoId) return null;
  return {
    videoId,
    title: title || "",
    publishedAt: published || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

// GEÇMİŞ TEŞHİS SÜRECİ (özet): Mukmir örneğinde YouTube'un /channel/{id}/live
// adresi artık her zaman 3xx yönlendirmesi YAPMIYOR; bazı kanallarda doğrudan
// 200 ile kanalın kendi (ana/ev) sayfasını döndürüyor. Sırasıyla "videoId<->
// isLive yakınlığı" ve "isLiveNow düz metni" gibi regex tahminleri denendi,
// ikisi de yanlış çıktı - çünkü bu 200 yanıtının gövdesi aslında TAM bir
// izleme (watch) sayfası değil, kanalın ana sayfası (ve içindeki küçük bir
// "şu an canlı" widget'ı); bu widget'ta tam "videoDetails"/"microformat"
// oynatıcı verisi gömülü değil. Gerçek veriyle (kullanıcının doğruladığı
// canlı videoId'si sayfada nerede geçiyor diye bakarak) doğrulandı.
//
// KESİN ÇÖZÜM: /live yönlendirmesine güvenmek yerine, RSS'ten bildiğimiz en
// son videonun KENDİ izleme sayfasını (https://www.youtube.com/watch?v=...)
// ayrıca çekip, oradaki TAM oynatıcı verisini (ytInitialPlayerResponse)
// düzgün bir JSON ayrıştırıcıyla (parantez dengeleme, regex yakınlığı değil)
// okuyoruz. Gerçekten canlıysa YouTube bu videoyu RSS akışına daima en üstte
// koyduğu için bu güvenilir bir varsayım.
//
// ÖNEMLİ (rate-limit dersi): Bir önceki denemede hem /channel/{id}/live HEM
// de /watch?v=... adreslerine istek atıyorduk. Bu, kanal başına isteği
// ikiye katladı ve GitHub Actions'ın paylaşımlı IP'lerinden YouTube'a
// gidildiğinde HTTP 429 (Too Many Requests) almaya başladık - bu da watch
// sayfasının hiç okunamamasına (ve olduğundan farklı, yanlış "canlı değil"
// sonucuna) yol açtı. Bu yüzden artık MÜMKÜNSE TEK istek atıyoruz: RSS'ten
// zaten bildiğimiz en son videonun kendi izleme sayfası hem canlı durumunu
// hem avatarı verir, /live adresine ayrıca gitmiyoruz. /live'a sadece hiç
// video bilgisi olmayan (RSS'i boş/başarısız) kanallar için düşüyoruz.
async function checkYouTubeLive(channelId, latestVideoId) {
  try {
    if (latestVideoId) {
      const watchRes = await fetchWithTimeout(`https://www.youtube.com/watch?v=${latestVideoId}`);
      if (!watchRes.ok) {
        // 429/5xx gibi geçici bir durumda "kesinlikle canlı değil" diye
        // yanlış bir sonuca varmak yerine "bilinmiyor" döndürüyoruz -
        // main() bunu önceki bilinen durumu (live=true olabilir) koruyarak
        // ele alıyor, yanlışlıkla false'a çevirmiyor.
        log(`[youtube] watch sayfası HTTP ${watchRes.status} döndü (${channelId}), önceki durum korunuyor.`);
        return null;
      }
      const watchHtml = await watchRes.text();
      const parsed = parseLiveFromHtml(watchHtml);
      const avatar = parseChannelAvatar(watchHtml);
      return { ...parsed, avatar };
    }

    // latestVideoId yoksa (ör. RSS okunamadı ya da kanalın hiç videosu yok)
    // eski /live yöntemine düşüyoruz - bu durumda ekstra istek maliyeti
    // zaten sınırlı sayıda kanalı etkiler.
    const res = await fetchWithTimeout(
      `https://www.youtube.com/channel/${channelId}/live`,
      { redirect: "manual" }
    );
    const parsed = parseLiveRedirect(res.status, res.headers.get("location") || "");
    let avatar = null;
    if (!parsed.live) {
      try {
        const html =
          res.status >= 300 && res.status < 400
            ? await (
                await fetchWithTimeout(
                  new URL(res.headers.get("location") || `/channel/${channelId}`, "https://www.youtube.com").toString()
                )
              ).text()
            : await res.text();
        avatar = parseChannelAvatar(html);
      } catch {
        // gövde okunamadı -> avatar bulunamadı sayılır, script çökmez
      }
    }
    return { ...parsed, avatar };
  } catch (err) {
    log(`[youtube] live kontrolü başarısız (${channelId}):`, err.message);
    return null; // bilinmiyor -> önceki durumu koru
  }
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
export function parseLiveRedirect(status, location) {
  if (status >= 300 && status < 400 && location.includes("watch?v=")) {
    const videoId = new URL(location, "https://www.youtube.com").searchParams.get("v");
    return { live: true, videoId };
  }
  return { live: false, videoId: null };
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
//
// Metin içinde startIdx'teki '{' veya '['  ile başlayan JSON değerinin tam
// olarak nerede bittiğini, tırnak içi karakterleri ve kaçış (\") dizilerini
// doğru sayarak bulur. Regex ile "yakınlık" tahmini yapmak yerine (ki bu
// -shortDescription gibi uzun alanlar yüzünden yanlış çıkabiliyordu-) parantez
// dengesini gerçekten sayar, böylece iç içe obje/dizi ne kadar uzun/karmaşık
// olursa olsun doğru sınırı bulur.
export function extractBalancedJson(text, startIdx) {
  const open = text[startIdx];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
//
// `"anahtar":` metnini bulup hemen ardından gelen JSON değerini (obje/dizi)
// ayrıştırır ve JS nesnesi olarak döner. Bozuk/eksikse null döner, script
// çökmez.
export function extractJsonValueAfterKey(text, keyLiteral) {
  if (!text) return null;
  const idx = text.indexOf(keyLiteral);
  if (idx === -1) return null;
  const valueStart = idx + keyLiteral.length;
  const ch = text[valueStart];
  if (ch !== "{" && ch !== "[") return null;
  const raw = extractBalancedJson(text, valueStart);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
//
// Bir video izleme (watch) sayfasının HTML'inden gerçekten O AN canlı olup
// olmadığını çıkarır. Sayfaya gömülü oynatıcı verisindeki iki bağımsız alana
// bakıyoruz (biri varsa yeter):
//   - videoDetails.isLive
//   - microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow
// "isLiveContent" alanına KASITLI olarak bakmıyoruz; o alan geçmişte canlı
// yayınlanmış ama artık bitmiş (VOD) videolar için de hep true kalıyor.
export function parseLiveFromHtml(html) {
  if (!html) return { live: false, videoId: null };

  // GERÇEK VERİYLE DOĞRULANDI (2026-09-06, TalkativeKo örneği): sayfada
  // "videoDetails" metni BİRDEN FAZLA yerde geçiyor - bunlardan ilki (ve bu
  // yüzden extractJsonValueAfterKey'in yakaladığı) aslında oynatıcının üst
  // bilgi kutusuna ait küçük bir UI nesnesi (playerOverlayVideoDetailsRenderer),
  // asıl ytInitialPlayerResponse.videoDetails DEĞİL; "microformat" da bu
  // sayfa türünde hiç bulunmuyordu. Yani "isLive"/"isLiveNow" alanlarına
  // güvenmek (önceki 2 deneme) hep başarısız oldu.
  //
  // Bunun yerine GÖZLE GÖRÜLEN, çok daha güvenilir bir işarete geçiyoruz:
  // YouTube, izleyici sayısını SADECE o an gerçekten canlı olan videolarda
  // "X watching now" ("X kişi izliyor") şeklinde gösteriyor; bitmiş/normal
  // videolarda bunun yerine "X views" yazıyor. Bu metin, oynatıcının hemen
  // altındaki başlık/alt başlık kutusunda (playerOverlayVideoDetailsRenderer.
  // subtitle) gerçek zamanlı render ediliyor ve doğrudan üretim verisiyle
  // (29 watching now) doğrulandı.
  const isLive = /watching now/i.test(html);

  if (!isLive) return { live: false, videoId: null };

  // Kendi videoId'sini kanonik linkten alıyoruz - sayfa zaten kendi
  // watch?v=... adresine ait olduğu için bu her zaman doğru videoId'yi
  // verir (JSON içindeki ilk "videoId" alanına güvenmekten daha sağlam,
  // o alan alakasız/önerilen bir videoya da ait olabilir).
  const videoId =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1] ||
    html.match(/"videoId":"([\w-]{11})"/)?.[1] ||
    null;
  return { live: true, videoId };
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
//
// YouTube kanal fotoğrafını sayfada birden fazla olası biçimde taşıyabiliyor:
// klasik <meta>/<link> etiketleri her zaman bulunmayabiliyor (özellikle
// JavaScript ile doldurulan bazı sayfa varyantlarında), o yüzden sayfanın
// içine gömülü ilk yükleme JSON'undaki alanları da yedek olarak deniyoruz.
// <meta>/<link> etiketlerindeki özellik sırası (property/content, content/property...)
// YouTube'un farklı sayfa şablonlarında değişebiliyor; bu yüzden tek bir sıraya
// güvenmek yerine etiketin tamamını bulup içinden istediğimiz özelliği çekiyoruz.
function extractTagAttr(html, tagRegexSource, attrToExtract) {
  const tagMatch = html.match(new RegExp(tagRegexSource, "i"));
  if (!tagMatch) return null;
  const attrMatch = tagMatch[0].match(new RegExp(`${attrToExtract}=["']([^"']+)["']`, "i"));
  return attrMatch ? attrMatch[1] : null;
}

export function parseChannelAvatar(html) {
  if (!html) return null;

  // 1) og:image / twitter:image meta etiketi - özellik sırasından bağımsız
  for (const key of ["og:image", "twitter:image"]) {
    const url = extractTagAttr(html, `<meta[^>]*(?:property|name)=["']${key}["'][^>]*>`, "content");
    if (url) return decodeEntities(url);
  }

  // 2) <link itemprop="thumbnailUrl"> - özellik sırasından bağımsız
  const thumbUrl = extractTagAttr(html, `<link[^>]*itemprop=["']thumbnailUrl["'][^>]*>`, "href");
  if (thumbUrl) return decodeEntities(thumbUrl);

  // 3) Eski/bilinen gömülü JSON şekilleri
  const jsonPatterns = [
    /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/,
    /"avatarViewModel":\{"image":\{"sources":\[\{"url":"([^"]+)"/,
  ];
  for (const re of jsonPatterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }

  // 4) Genel yedek: YouTube sayfa yapısını değiştirdiğinde (ör. yeni "WIZ"
  // tabanlı düzen) yukarıdaki kalıpların hiçbiri tutmayabilir. Bu durumda
  // "avatar" geçen kelimenin hemen ardından gelen ilk "url":"..." alanını
  // yakalamayı deniyoruz - iç JSON anahtar adları değişse bile genelde
  // "avatar" kelimesi bir şekilde geçmeye devam ediyor.
  const looseMatch = html.match(/avatar[\s\S]{0,300}?"url":"([^"]+)"/i);
  if (looseMatch) return decodeEntities(looseMatch[1]);

  return null;
}

export function extractKickUsername(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() || null;
  } catch {
    return null;
  }
}

async function checkKickLive(username) {
  try {
    const res = await fetchWithTimeout(`https://kick.com/api/v1/channels/${username}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null; // engellenmiş/oran sınırlı olabilir -> bilinmiyor
    const data = await res.json();
    // Kick'in kanal cevabı zaten profil fotoğrafını içeriyor -> ekstra istek gerekmiyor.
    const avatar = data?.user?.profile_pic || data?.user?.profilePic || null;
    if (data && data.livestream) {
      return {
        live: true,
        title: data.livestream.session_title || "",
        thumbnail: data.livestream.thumbnail?.url || null,
        avatar,
      };
    }
    return { live: false, title: "", thumbnail: null, avatar };
  } catch (err) {
    log(`[kick] kontrol başarısız (${username}):`, err.message);
    return null;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function isWithinHours(isoDate, hours) {
  if (!isoDate) return false;
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= hours * 60 * 60 * 1000;
}

async function sendDiscord(webhookUrl, embed) {
  if (!webhookUrl) return;
  try {
    await fetchWithTimeout(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    await sleep(400); // Discord rate limitine takılmamak için
  } catch (err) {
    log("[discord] gönderilemedi:", err.message);
  }
}

async function processYouTubeEntry(entry, cache) {
  const channelId = await resolveChannelId(entry, cache);
  if (!channelId) {
    return { key: entry.url, name: entry.name, live: undefined, newVideo: undefined, error: "channelId yok" };
  }

  // Sırayla çalıştırıyoruz (paralel değil): checkYouTubeLive artık RSS'ten
  // bilinen en son videonun izleme sayfasını da kontrol ediyor, bu yüzden
  // önce onu (latest) bilmesi gerekiyor.
  const latest = await getLatestVideo(channelId);
  const liveInfo = await checkYouTubeLive(channelId, latest?.videoId || null);

  const newVideo = latest ? isWithinHours(latest.publishedAt, NEW_VIDEO_WINDOW_HOURS) : false;

  return {
    key: entry.url,
    name: entry.name,
    channelId,
    live: liveInfo ? liveInfo.live : undefined, // undefined = bilinmiyor, önceki değeri koru
    liveVideoId: liveInfo?.videoId || null,
    newVideo,
    videoId: latest?.videoId || null,
    videoTitle: latest?.title || null,
    videoUrl: latest?.url || null,
    thumbnail: latest?.thumbnail || null,
    publishedAt: latest?.publishedAt || null,
    avatar: liveInfo?.avatar || null,
  };
}

async function processKickEntry(entry, index) {
  await sleep(index * KICK_DELAY_MS);
  const username = extractKickUsername(entry.url);
  if (!username) return { key: entry.url, live: false, error: "kullanıcı adı yok" };
  const info = await checkKickLive(username);
  return {
    key: entry.url,
    name: entry.name,
    username,
    live: info ? info.live : undefined,
    videoTitle: info?.title || null,
    thumbnail: info?.thumbnail || null,
    avatar: info?.avatar || null,
  };
}

async function main() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL || "";
  const channels = await readJsonSafe(CHANNELS_PATH, { youtube: [], kick: [], icerik: [] });
  const prevStatus = await readJsonSafe(STATUS_PATH, null);
  const isFirstRun = prevStatus === null;
  const prev = prevStatus || {};
  const cache = await readJsonSafe(RESOLVED_IDS_PATH, {});

  const youtubeLike = [...(channels.youtube || []), ...(channels.icerik || [])].filter(
    (c) => (c.platform || "").toLowerCase() === "youtube"
  );
  const kickEntries = channels.kick || [];

  log(`YouTube tipi kanal: ${youtubeLike.length}, Kick kanalı: ${kickEntries.length}`);

  const youtubeResults = await mapWithConcurrency(youtubeLike, 5, (entry) =>
    processYouTubeEntry(entry, cache)
  );
  const kickResults = await mapWithConcurrency(kickEntries, 3, (entry, idx) =>
    processKickEntry(entry, idx)
  );

  const newStatus = {};
  const events = [];

  for (const r of [...youtubeResults, ...kickResults]) {
    const before = prev[r.key];
    const live = r.live === undefined ? before?.live ?? false : r.live;
    const newVideo = r.newVideo === undefined ? before?.newVideo ?? false : r.newVideo;

    newStatus[r.key] = {
      name: r.name,
      live,
      newVideo,
      // channelId kalıcıdır (biri @handle'ını değiştirse bile aynı kalır) -> kartın
      // linkini bundan üretiyoruz ki eski/geçersiz bir url'e takılıp kalmasın.
      channelId: r.channelId ?? before?.channelId ?? null,
      videoId: r.videoId ?? before?.videoId ?? null,
      videoTitle: r.videoTitle ?? before?.videoTitle ?? null,
      videoUrl: r.videoUrl ?? before?.videoUrl ?? null,
      thumbnail: r.thumbnail ?? before?.thumbnail ?? null,
      // avatar nadiren değişir; bu turda bulunamadıysa (ör. kanal o an canlıydı)
      // önceki bilinen avatarı koruyoruz, hiç bulunamadıysa null kalır (site
      // platform ikonuna geri düşer).
      avatar: r.avatar ?? before?.avatar ?? null,
      checkedAt: new Date().toISOString(),
    };

    if (!isFirstRun) {
      // Canlıya yeni geçiş
      if (live && !(before?.live)) {
        // Canlı ise yayın videosunun linkini kullan (YouTube); yoksa kanalın kendi
        // sayfasına yönlendir (Kick, ya da video linki henüz bilinmiyorsa).
        const liveUrl = r.liveVideoId
          ? `https://www.youtube.com/watch?v=${r.liveVideoId}`
          : r.key;
        events.push({ type: "live", name: r.name, url: liveUrl, entry: r });
      }
      // Yeni video (daha önce görmediğimiz bir videoId). Eğer bu "yeni video" aslında
      // az önce başlayan canlı yayının kendisiyse, ayrı bir "yeni video" bildirimi atmıyoruz —
      // "CANLI YAYINDA" bildirimi zaten aynı şeyi haber veriyor, çift bildirim olmasın.
      const isLiveBroadcastItself = live && r.liveVideoId && r.liveVideoId === r.videoId;
      if (
        r.videoId &&
        before?.videoId &&
        r.videoId !== before.videoId &&
        !isLiveBroadcastItself
      ) {
        events.push({ type: "video", name: r.name, entry: r });
      }
    }
  }

  await mkdir(path.dirname(RESOLVED_IDS_PATH), { recursive: true });
  await writeFile(STATUS_PATH, JSON.stringify(newStatus, null, 2) + "\n", "utf8");
  await writeFile(RESOLVED_IDS_PATH, JSON.stringify(cache, null, 2) + "\n", "utf8");

  log(`${events.length} yeni olay bulundu (canlı geçişi / yeni video).`);

  for (const ev of events) {
    if (ev.type === "live") {
      await sendDiscord(webhookUrl, {
        title: "🔴 CANLI YAYINDA",
        description: `**${ev.name}** şu an yayında!`,
        url: ev.url,
        color: 0xe53935,
        thumbnail: ev.entry.thumbnail ? { url: ev.entry.thumbnail } : undefined,
      });
    } else if (ev.type === "video") {
      await sendDiscord(webhookUrl, {
        title: "🎬 Yeni Video",
        description: `**${ev.name}** yeni bir video yükledi: [${ev.entry.videoTitle || "İzle"}](${ev.entry.videoUrl})`,
        url: ev.entry.videoUrl,
        color: 0x43a047,
        thumbnail: ev.entry.thumbnail ? { url: ev.entry.thumbnail } : undefined,
      });
    }
  }

  log("Tamamlandı.");
}

main().catch((err) => {
  console.error("Beklenmeyen hata:", err);
  process.exit(1);
});
