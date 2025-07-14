async function isYouTubeLive(channel, username) {
    try {
        const res = await fetch(`https://youtube-stream-checker.vercel.app/api/check-live?url=${channel}&username=${username}`)
        const data = await res.json();
        return data.live;
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

    // YouTube - paralel kontrol + sıralama
    const youtubeStatuses = await Promise.all(
        data.youtube.map(async (channel) => {
            const channelUrl = channel.url.trim();
            const username = channel.name.trim();
            const isLive = await isYouTubeLive(channelUrl, username);
            return { ...channel, isLive };
        })
    );

    const orderedYoutube = [
        ...youtubeStatuses.filter(c => c.isLive),
        ...youtubeStatuses.filter(c => !c.isLive)
    ];

    for (const channel of orderedYoutube) {
        const card = createCard(channel, channel.isLive, "youtube");
        youtubeList.appendChild(card);
    }

    // Kick - paralel kontrol + sıralama
    const kickStatuses = await Promise.all(
        data.kick.map(async (channel) => {
            const username = extractKickUsername(channel.url);
            const isLive = await isKickLive(username);
            return { ...channel, isLive };
        })
    );

    const orderedKick = [
        ...kickStatuses.filter(c => c.isLive),
        ...kickStatuses.filter(c => !c.isLive)
    ];

    for (const channel of orderedKick) {
        const card = createCard(channel, channel.isLive, "kick");
        kickList.appendChild(card);
    }

    // Diğer içerikler
    for (const channel of data.icerik) {
        const card = createCard(channel, false, "icerik");
        icerikList.appendChild(card);
    }
}

loadChannels();
