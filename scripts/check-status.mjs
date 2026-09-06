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

// GEÇİCİ TEŞHİS (2. tur): İlk denemedeki (videoId<->isLive proximity) yöntem
// yanlış çıktı - Mukmir gerçekten canlıyken hâlâ live:false veriyordu. Şimdi
// "isLiveNow" tabanlı yeni yönteme geçtik; bunu gerçek veriyle doğrulamak
// için tek kanal için ham durumu status.json'a yazıyoruz. Doğrulanınca bu
// blok (ve _liveDebug2 alanı main()'de) kaldırılacak.
const DEBUG_LIVE_CHANNEL_ID = "UC2IhlhOhWkA8t_eLBmFVK-w";
const DEBUG_KNOWN_LIVE_VIDEO_ID = "L64pOwPX3jM";

async function checkYouTubeLive(channelId) {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/channel/${channelId}/live`,
      { redirect: "manual" }
    );
    let parsed = parseLiveRedirect(res.status, res.headers.get("location") || "");
    let debug2 = null;
    // Canlı değilse profil fotoğrafını (avatar) da EK bir istek atmadan çıkarmaya
    // çalışıyoruz. Ama bu isteğin gövdesi her zaman kanalın kendi sayfası olmayabilir:
    // - Durum 200 ise gövde zaten kanal sayfasıdır, doğrudan kullanılır.
    // - Durum 3xx ama hedef bir video (watch?v=) değilse (örn. kanalın ana sayfasına
    //   yönlendirme), "manual" modda gövde boş gelir; bu durumda hedefe ayrıca,
    //   normal (takip eden) bir istekle gidip gerçek sayfayı çekiyoruz.
    let avatar = null;
    if (!parsed.live) {
      let html = "";
      try {
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          const target = location
            ? new URL(location, "https://www.youtube.com").toString()
            : `https://www.youtube.com/channel/${channelId}`;
          const res2 = await fetchWithTimeout(target);
          html = await res2.text();
        } else {
          html = await res.text();
        }
        avatar = parseChannelAvatar(html);
      } catch {
        // gövde okunamadı -> avatar bulunamadı sayılır, script çökmez
      }

      // YouTube artık bazı kanallarda /live adresine gidildiğinde 3xx
      // yönlendirmesi YAPMIYOR: kanal gerçekten canlı olsa bile durum kodu
      // doğrudan 200 ve gövde, canlı yayının kendi (watch) sayfası oluyor.
      // Bu durumda yönlendirme yerine gövdenin içine gömülü oynatıcı
      // (player response) JSON'undaki "isLive" alanına bakarak anlıyoruz.
      if (html) {
        const fromHtml = parseLiveFromHtml(html);
        if (fromHtml.live) parsed = fromHtml;
      }

      if (channelId === DEBUG_LIVE_CHANNEL_ID) {
        // 3. tur: "labelLive" eşleşmesi sahte çıktı - "PLAYER_LIVE_LABEL":"Live"
        // gibi her sayfada bulunan, oynatıcı arayüzünün genel çeviri metniymiş,
        // canlı yayınla ilgisi yok. Bu sefer dolaylı desenlerle uğraşmak yerine
        // KULLANICININ DOĞRULADIĞI gerçek canlı videoId'sini
        // (DEBUG_KNOWN_LIVE_VIDEO_ID, "L64pOwPX3jM") sayfada nerede/nasıl
        // geçtiğine doğrudan bakıyoruz: her geçtiği yerin 200 karakter
        // öncesi/sonrasını görürsek, YouTube'un bu videoyu canlı olarak
        // işaretlediği gerçek JSON alanını gözle görebiliriz.
        const occurrences = [];
        const re = new RegExp(DEBUG_KNOWN_LIVE_VIDEO_ID, "g");
        let m;
        while ((m = re.exec(html)) && occurrences.length < 8) {
          occurrences.push(html.slice(Math.max(0, m.index - 200), m.index + 200));
        }
        debug2 = {
          status: res.status,
          location: res.headers.get("location") || null,
          htmlLength: html.length,
          knownLiveVideoIdOccurrenceCount: occurrences.length,
          knownLiveVideoIdContexts: occurrences,
          canonicalLink: html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || null,
          parsedFromHtmlResult: parseLiveFromHtml(html),
        };
      }
    }
    return { ...parsed, avatar, debug2 };
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
// /live adresi 3xx yönlendirmesi yapmadan doğrudan 200 ile canlı yayın
// sayfasını döndürdüğünde kullanılır.
//
// İlk denemede "videoDetails":{"videoId":"..."..."isLive":true} alanlarını
// birbirine yakınlığa (proximity) bakarak eşleştirmeye çalışmıştık, ama bu
// YANLIŞ ÇIKTI: videoDetails içindeki "shortDescription" alanı genelde
// birkaç yüz karakterden uzun olduğu için videoId ile gerçek "isLive"
// alanı arası bizim aradığımız pencereden (600 karakter) daha uzun kalıyor;
// üstelik sayfada başka (önerilen/ilgili video) bir videoya ait "isLive"
// benzeri alanlar da bulunabiliyor ve yanlışlıkla eşleşebiliyor.
//
// Bunun yerine yt-dlp gibi araçların da kullandığı, sayfanın KENDİ videosuna
// özgü ve konumdan bağımsız çalışan alanı kullanıyoruz:
// microformat.playerMicroformatRenderer.liveBroadcastDetails.isLiveNow
// -> JSON'da düz metin olarak "isLiveNow":true şeklinde geçer ve sadece o
// sayfanın ait olduğu video gerçekten O AN yayındaysa true olur (biten bir
// yayında bu alan ya hiç yok ya da false'a döner, "isLiveContent" gibi kalıcı
// olarak true kalmaz). videoId'yi ise ayrı ve güvenilir bir yerden
// (canonical link, o yoksa ilk "videoId" alanı) alıyoruz.
export function parseLiveFromHtml(html) {
  if (!html) return { live: false, videoId: null };
  if (!/"isLiveNow":true/.test(html)) return { live: false, videoId: null };
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

  const [latest, liveInfo] = await Promise.all([
    getLatestVideo(channelId),
    checkYouTubeLive(channelId),
  ]);

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
    _liveDebug2: liveInfo?.debug2 || null,
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
      ...(r._liveDebug2 ? { _liveDebug2: r._liveDebug2 } : {}),
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
