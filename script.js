async function isYouTubeLive(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  try {
    const res = await fetch(rssUrl);
    const text = await res.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "application/xml");

    const latestEntry = xml.querySelector("entry");
    if (!latestEntry) return false;

    const title = latestEntry.querySelector("title").textContent.toLowerCase();
    return title.includes("live") || title.includes("canlı");
  } catch (err) {
    console.error("YouTube RSS Hatası:", err);
    return false;
  }
}

async function isKickLive(username) {
  try {
    const res = await fetch(`https://kick.com/api/v1/channels/${username}`);
    const data = await res.json();
    return data.livestream !== null;
  } catch (e) {
    console.error("Kick API Hatası:", e);
    return false;
  }
}

function extractKickUsername(url) {
  try {
    const parts = new URL(url);
    return parts.pathname.split("/")[1].toLowerCase();
  } catch (e) {
    return "";
  }
}

function createCard(channel, isLive, platform) {
  const card = document.createElement("div");
  card.className = "channel-card";

  let logo = "default.png";
  if (platform === "kick") logo = "kk.png";
  else if (platform === "youtube") logo = "yt.png";
  else if (platform === "icerik") logo = "yt.png";

  card.innerHTML = `
    <img class="platform-logo" src="${logo}" alt="${platform}">
    <div>
      <strong>${channel.name}</strong>
      ${isLive ? '<span class="live-badge">🔴 Live</span>' : ""}
      <br>
      <a href="${channel.url}" target="_blank">Tıkla İzle</a>
    </div>
  `;
  return card;
}

async function loadChannels() {
  const res = await fetch("channels.json");
  const data = await res.json();

  const youtubeList = document.querySelector(".youtube-list");
  const kickList = document.querySelector(".kick-list");
  const icerikList = document.querySelector(".icerik-list");

  // YouTube
  for (const channel of data.youtube) {
    const channelId = channel.channelID.trim();
    const isLive = await isYouTubeLive(channelId);
    const card = createCard(channel, isLive, "youtube");
    youtubeList.appendChild(card);
  }

  // Kick - parallel
  const kickStatuses = await Promise.all(
    data.kick.map(async (channel) => {
      const username = extractKickUsername(channel.url);
      const isLive = await isKickLive(username);
      return { ...channel, isLive };
    })
  );

  // canlıları üstte göster
  const orderedKick = [
    ...kickStatuses.filter(c => c.isLive),
    ...kickStatuses.filter(c => !c.isLive)
  ];

  for (const channel of orderedKick) {
    const card = createCard(channel, channel.isLive, "kick");
    kickList.appendChild(card);
  }

  // icerik
  for (const channel of data.icerik) {
    const card = createCard(channel, false, "icerik");
    icerikList.appendChild(card);
  }
}

loadChannels();
