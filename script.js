// #DeathKO Yayıncılar sayfası
//
// ÖNEMLİ DEĞİŞİKLİK: Bu sürüm artık Kick/YouTube'a tarayıcıdan DOĞRUDAN istek atmıyor.
// Bunun yerine, arka planda GitHub Actions tarafından ~5 dakikada bir güncellenen
// status.json dosyasını okuyor. Bu sayede:
//  - Ziyaretçi sayısı arttıkça Kick/YouTube'a giden istek sayısı ARTMIYOR (herkes aynı
//    dosyayı okuyor), bu da engellenme/rate-limit riskini ortadan kaldırıyor.
//  - Sayfa açık kaldığı sürece durum kendiliğinden tazeleniyor (60 saniyede bir).

const STATUS_REFRESH_MS = 60 * 1000;

let channelsData = null;
let statusData = {};

async function loadJson(url) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} yüklenemedi (${res.status})`);
  return res.json();
}

function createCard(channel, status, platform) {
  const card = document.createElement("div");
  card.className = "channel-card";

  let logo = "default.png";
  if (platform === "kick") logo = "kk.png";
  else if (platform === "youtube") logo = "yt.png";
  else if (platform === "icerik") logo = "yt.png";

  const isLive = !!status?.live;
  const isNewVideo = !isLive && !!status?.newVideo; // aynı anda ikisini birden göstermeye gerek yok

  // channelId kalıcıdır (biri YouTube @handle'ını değiştirse bile aynı kalır).
  // Elimizde varsa linki ondan üretiyoruz ki channels.json'daki url eskiyince
  // "sayfa bulunamadı" sorunu çıkmasın; yoksa channels.json'daki url'e düşüyoruz.
  const watchUrl = status?.channelId
    ? `https://www.youtube.com/channel/${status.channelId}`
    : channel.url;

  card.innerHTML = `
    ${isNewVideo ? '<span class="new-video-badge">🎬 Yeni Video</span>' : ""}
    <img class="platform-logo" src="${logo}" alt="${platform}">
    <div>
      <strong>${channel.name}</strong>
      ${isLive ? '<span class="live-badge">🔴 Live</span>' : ""}
      <br>
      <a href="${watchUrl}" target="_blank" rel="noopener">Tıkla İzle</a>
    </div>
  `;
  return card;
}

function renderColumn(listEl, channels, platform) {
  listEl.innerHTML = "";
  const withStatus = channels.map((c) => ({ channel: c, status: statusData[c.url] }));

  const ordered = [
    ...withStatus.filter((c) => c.status?.live),
    ...withStatus.filter((c) => !c.status?.live && c.status?.newVideo),
    ...withStatus.filter((c) => !c.status?.live && !c.status?.newVideo),
  ];

  for (const { channel, status } of ordered) {
    listEl.appendChild(createCard(channel, status, platform));
  }
}

function renderAll() {
  if (!channelsData) return;
  renderColumn(document.querySelector(".youtube-list"), channelsData.youtube || [], "youtube");
  renderColumn(document.querySelector(".kick-list"), channelsData.kick || [], "kick");
  renderColumn(document.querySelector(".icerik-list"), channelsData.icerik || [], "icerik");
}

async function refreshStatus() {
  try {
    statusData = await loadJson("status.json");
  } catch (err) {
    console.warn("status.json okunamadı, rozetler olmadan devam ediliyor:", err.message);
    statusData = statusData || {};
  }
  renderAll();
}

async function init() {
  try {
    channelsData = await loadJson("channels.json");
  } catch (err) {
    console.error("channels.json okunamadı:", err.message);
    return;
  }
  await refreshStatus();
  setInterval(refreshStatus, STATUS_REFRESH_MS);
}

init();
