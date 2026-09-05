// #DeathKO Prime XL — Yayıncılar sayfası
//
// Bu script artık Kick/YouTube'a tarayıcıdan DOĞRUDAN istek atmıyor.
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

function createRow(channel, status, platform) {
  const row = document.createElement("div");
  row.className = "roster-row";

  let logo = "default.svg";
  if (platform === "kick") logo = "kk.svg";
  else if (platform === "youtube") logo = "yt.svg";
  else if (platform === "icerik") logo = "yt.svg";

  // Gerçek kanal fotoğrafı varsa onu göster; yoksa (henüz çekilememiş veya
  // yüklenemezse) platform ikonuna düş.
  const avatarSrc = status?.avatar || logo;

  const isLive = !!status?.live;
  // "Yeni video" rozeti sadece İçerik Üreticileri için anlamlı; Yayıncılar
  // (YouTube/Kick) zaten canlı yayın yapıyor, video yükleme onların işi değil.
  const isNewVideo = !isLive && !!status?.newVideo && platform === "icerik";
  if (isLive) row.classList.add("is-live");

  // channelId kalıcıdır (biri YouTube @handle'ını değiştirse bile aynı kalır).
  // Elimizde varsa linki ondan üretiyoruz ki channels.json'daki url eskiyince
  // "sayfa bulunamadı" sorunu çıkmasın; yoksa channels.json'daki url'e düşüyoruz.
  const watchUrl = status?.channelId
    ? `https://www.youtube.com/channel/${status.channelId}`
    : channel.url;

  let statusHtml = "";
  if (isLive) statusHtml = '<span class="roster-status">Canlı</span>';
  else if (isNewVideo) statusHtml = '<span class="roster-status roster-status--new">Yeni video</span>';

  row.innerHTML = `
    <img class="avatar" src="${avatarSrc}" data-fallback="${logo}" onerror="this.onerror=null;this.src=this.dataset.fallback;" alt="">
    <div class="roster-main">
      <span class="roster-name">${channel.name}</span>
      ${statusHtml}
    </div>
    <a class="roster-link" href="${watchUrl}" target="_blank" rel="noopener">İzle</a>
  `;
  return row;
}

function createSponsorCard(channel, status, platform) {
  const card = document.createElement("div");
  card.className = "sponsor-card";

  let logo = "default.svg";
  if (platform === "kick") logo = "kk.svg";
  else if (platform === "youtube") logo = "yt.svg";
  else if (platform === "icerik") logo = "yt.svg";

  const avatarSrc = status?.avatar || logo;
  const isLive = !!status?.live;
  // Aynı mantık: "Yeni video" rozeti sadece İçerik Üreticileri için.
  const isNewVideo = !isLive && !!status?.newVideo && platform === "icerik";
  if (isLive) card.classList.add("is-live");

  const watchUrl = status?.channelId
    ? `https://www.youtube.com/channel/${status.channelId}`
    : channel.url;

  let statusHtml = "";
  if (isLive) statusHtml = '<span class="roster-status">Canlı</span>';
  else if (isNewVideo) statusHtml = '<span class="roster-status roster-status--new">Yeni video</span>';

  card.innerHTML = `
    <img class="avatar" src="${avatarSrc}" data-fallback="${logo}" onerror="this.onerror=null;this.src=this.dataset.fallback;" alt="">
    <div class="roster-main">
      <span class="roster-name">${channel.name}</span>
      <span class="sponsor-tag">Sponsor</span>
      ${statusHtml}
    </div>
    <a class="roster-link" href="${watchUrl}" target="_blank" rel="noopener">İzle</a>
  `;
  return card;
}

function renderSponsors() {
  const section = document.getElementById("sponsor-section");
  const listEl = document.getElementById("sponsor-list");
  if (!section || !listEl) return;

  const grouped = [
    ...(channelsData?.youtube || []).map((c) => ({ channel: c, platform: "youtube" })),
    ...(channelsData?.kick || []).map((c) => ({ channel: c, platform: "kick" })),
    ...(channelsData?.icerik || []).map((c) => ({ channel: c, platform: "icerik" })),
  ].filter((c) => c.channel.sponsor === true);

  listEl.innerHTML = "";
  for (const { channel, platform } of grouped) {
    listEl.appendChild(createSponsorCard(channel, statusData[channel.url], platform));
  }
  section.hidden = grouped.length === 0;
}

function renderColumn(listEl, countEl, channels, platform) {
  listEl.innerHTML = "";
  const withStatus = channels.map((c) => ({ channel: c, status: statusData[c.url] }));

  const ordered = [
    ...withStatus.filter((c) => c.status?.live),
    ...withStatus.filter((c) => !c.status?.live && c.status?.newVideo),
    ...withStatus.filter((c) => !c.status?.live && !c.status?.newVideo),
  ];

  for (const { channel, status } of ordered) {
    listEl.appendChild(createRow(channel, status, platform));
  }
  if (countEl) countEl.textContent = `(${channels.length})`;
}

function updateLiveLine() {
  const allChannels = [
    ...(channelsData?.youtube || []),
    ...(channelsData?.kick || []),
    ...(channelsData?.icerik || []),
  ];
  let liveCount = 0;
  for (const c of allChannels) {
    if (statusData[c.url]?.live) liveCount++;
  }
  const el = document.getElementById("live-line");
  if (!el) return;
  if (liveCount === 0) {
    el.textContent = "Şu an canlı yayın yok.";
    el.classList.remove("has-live");
  } else if (liveCount === 1) {
    el.textContent = "Şu an 1 yayıncı canlı.";
    el.classList.add("has-live");
  } else {
    el.textContent = `Şu an ${liveCount} yayıncı canlı.`;
    el.classList.add("has-live");
  }
}

function renderAll() {
  if (!channelsData) return;
  renderSponsors();
  renderColumn(
    document.querySelector(".youtube-list"),
    document.getElementById("count-youtube"),
    channelsData.youtube || [],
    "youtube"
  );
  renderColumn(
    document.querySelector(".kick-list"),
    document.getElementById("count-kick"),
    channelsData.kick || [],
    "kick"
  );
  renderColumn(
    document.querySelector(".icerik-list"),
    document.getElementById("count-icerik"),
    channelsData.icerik || [],
    "icerik"
  );
  updateLiveLine();
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
