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

// GEÇİCİ TEŞHİS: YouTube avatarı neden bulunamıyor anlayana kadar, ilk birkaç
// kanal için gerçek sayfa yapısını loglara yazıyoruz. Sorun çözülünce bu blok
// (ve aşağıdaki log çağrıları) kaldırılacak.
let ytDebugRemaining = 3;

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
  if (!handlePath) return null;

  try {
    const res = await fetchWithTimeout(`https://www.youtube.com${handlePath}`);
    if (!res.ok) return null;
    const html = await res.text();
    const m =
      html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) ||
      html.match(/<meta itemprop="channelId" content="(UC[0-9A-Za-z_-]{22})">/);
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

async function checkYouTubeLive(channelId) {
  // GEÇİCİ TEŞHİS: ilk birkaç kanal için NE OLURSA OLSUN (canlı/değil, hata/hatasız)
  // en az bir log satırı basılır - önceki teşhis denemesi hiç tetiklenmediği için
  // artık hiçbir dala bağlı olmayan, koşulsuz bir kayıt tutuyoruz.
  const shouldDebug = ytDebugRemaining > 0;
  if (shouldDebug) ytDebugRemaining--;

  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/channel/${channelId}/live`,
      { redirect: "manual" }
    );
    if (shouldDebug) {
      log(
        `[yt-debug] channelId=${channelId} ilkDurum=${res.status} location=${res.headers.get("location") || "(yok)"}`
      );
    }
    const parsed = parseLiveRedirect(res.status, res.headers.get("location") || "");
    // Canlı değilse profil fotoğrafını (avatar) da EK bir istek atmadan çıkarmaya
    // çalışıyoruz. Ama bu isteğin gövdesi her zaman kanalın kendi sayfası olmayabilir:
    // - Durum 200 ise gövde zaten kanal sayfasıdır, doğrudan kullanılır.
    // - Durum 3xx ama hedef bir video (watch?v=) değilse (örn. kanalın ana sayfasına
    //   yönlendirme), "manual" modda gövde boş gelir; bu durumda hedefe ayrıca,
    //   normal (takip eden) bir istekle gidip gerçek sayfayı çekiyoruz.
    let avatar = null;
    if (!parsed.live) {
      let html = "";
      let debugStatus = res.status;
      try {
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          const target = location
            ? new URL(location, "https://www.youtube.com").toString()
            : `https://www.youtube.com/channel/${channelId}`;
          const res2 = await fetchWithTimeout(target);
          html = await res2.text();
          debugStatus = res2.status;
        } else {
          html = await res.text();
        }
        avatar = parseChannelAvatar(html);
      } catch (innerErr) {
        if (shouldDebug) {
          log(`[yt-debug] channelId=${channelId} gövde okunurken hata: ${innerErr.message}`);
        }
      }

      if (shouldDebug) {
        log(
          `[yt-debug] channelId=${channelId} sonDurum=${debugStatus} htmlUzunluk=${html.length} avatarBulundu=${!!avatar}`
        );
        log(`[yt-debug] ilk 300 karakter: ${JSON.stringify(html.slice(0, 300))}`);
      }
    } else if (shouldDebug) {
      log(`[yt-debug] channelId=${channelId} canlı olarak algılandı, avatar denenmedi`);
    }
    return { ...parsed, avatar };
  } catch (err) {
    if (shouldDebug) {
      log(`[yt-debug] channelId=${channelId} DIŞ HATA: ${err.message} (${err.name})`);
    }
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
// YouTube kanal fotoğrafını sayfada birden fazla olası biçimde taşıyabiliyor:
// klasik <meta>/<link> etiketleri her zaman bulunmayabiliyor (özellikle
// JavaScript ile doldurulan bazı sayfa varyantlarında), o yüzden sayfanın
// içine gömülü ilk yükleme JSON'undaki alanları da yedek olarak deniyoruz.
export function parseChannelAvatar(html) {
  if (!html) return null;
  const patterns = [
    /<meta property="og:image" content="([^"]+)"/,
    /<link itemprop="thumbnailUrl" href="([^"]+)"/,
    /"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
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
