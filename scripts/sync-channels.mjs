// #DeathKO — Google Sheet'ten channels.json üretimi
//
// Amaç: Yayıncı/içerik üretici listesini artık elle JSON düzenleyerek değil,
// basit bir Google E-Tablosu üzerinden yönetebilmen. Tabloya bir satır
// ekleyip/silince, bir sonraki otomatik çalışmada (en geç ~5 dakika içinde)
// site kendiliğinden güncellenir.
//
// Nasıl çalışır: Aşağıdaki CSV_URL, o E-Tablonun "Publish to web" (Web'de
// yayınla) ile aldığın herkese açık CSV linkidir (bkz. gönderdiğim rehber).
// Bu script o linki okur, satırları ayrıştırır ve channels.json'ı YENİDEN
// YAZAR. Tablo okunamazsa (ağ sorunu, link henüz ayarlanmamış vs.) script
// çökmez, mevcut channels.json'a DOKUNMADAN çıkar — böylece geçici bir
// aksaklık site içeriğini silmez.
//
// Beklenen sütunlar (bu sırada): Ad | Tür | Platform | Link | Sponsor mu
//   - Tür: "Yayıncı" veya "İçerik Üreticisi"
//   - Platform: "YouTube" veya "Kick" (İçerik Üreticisi satırlarında boş
//     bırakılabilir, otomatik YouTube kabul edilir)
//   - Sponsor mu: "evet"/"true"/"1" gibi bir şey yazılırsa sponsor sayılır,
//     boşsa sponsor değildir.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const CHANNELS_PATH = path.join(ROOT, "channels.json");

// Google E-Tablosu'nu "Dosya > Paylaş > Web'de yayınla" ile CSV olarak
// yayınladığında aldığın link buraya gelecek. Link değişirse sadece bu
// satırı güncellemen yeterli.
const CSV_URL = process.env.CHANNELS_SHEET_CSV_URL || "";

const REQUEST_TIMEOUT_MS = 15000;

function log(...args) {
  console.log(new Date().toISOString(), "[sync-channels]", ...args);
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(t);
  }
}

// Basit ama doğru bir CSV satır ayrıştırıcı — tırnak içindeki virgülleri ve
// çift tırnak kaçışlarını ("" -> ") doğru ele alır. Harici pakete gerek yok.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // son satır (sonda newline olmayabilir)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

// NOT: Türkçe'de "İ".toLowerCase() -> "i̇" (noktası ayrı bir karakter) olur,
// "içerik".startsWith gibi karşılaştırmalar bu yüzden İngilizce toLowerCase()
// ile sessizce yanlış sonuç verir. Bütün Türkçe karşılaştırmalarda bu yüzden
// toLocaleLowerCase("tr") kullanıyoruz.
function trLower(value) {
  return (value || "").trim().toLocaleLowerCase("tr");
}

function truthy(value) {
  const v = trLower(value);
  return v === "evet" || v === "true" || v === "1" || v === "x" || v === "sponsor";
}

// Saf fonksiyon (ağ çağrısı yok) -> test edilebilir
export function buildChannelsFromRows(rows) {
  const result = { youtube: [], kick: [], icerik: [] };
  // İlk satır başlık satırı olabilir ("Ad" ile başlıyorsa atla)
  const dataRows = rows.length > 0 && trLower(rows[0][0]) === "ad" ? rows.slice(1) : rows;

  for (const cells of dataRows) {
    const [nameRaw, typeRaw, platformRaw, urlRaw, sponsorRaw] = cells;
    const name = (nameRaw || "").trim();
    const type = trLower(typeRaw);
    const platform = trLower(platformRaw);
    const url = (urlRaw || "").trim();
    if (!name || !url) continue; // eksik satırı sessizce atla

    const isIcerik = type.startsWith("içerik") || type.startsWith("icerik");
    const isKick = platform.startsWith("kick");

    const entry = { name, url };
    entry.platform = isIcerik ? "YouTube" : isKick ? "Kick" : "YouTube";
    if (truthy(sponsorRaw)) entry.sponsor = true;

    if (isIcerik) result.icerik.push(entry);
    else if (isKick) result.kick.push(entry);
    else result.youtube.push(entry);
  }
  return result;
}

async function main() {
  if (!CSV_URL) {
    log("CHANNELS_SHEET_CSV_URL ayarlanmamış, bu adım atlanıyor (channels.json elle yönetiliyor demektir).");
    return;
  }

  let text;
  try {
    const res = await fetchWithTimeout(CSV_URL);
    if (!res.ok) {
      log(`CSV indirilemedi (HTTP ${res.status}), channels.json'a dokunulmuyor.`);
      return;
    }
    text = await res.text();
  } catch (err) {
    log("CSV indirilemedi:", err.message, "— channels.json'a dokunulmuyor.");
    return;
  }

  const rows = parseCsv(text);
  const built = buildChannelsFromRows(rows);
  const total = built.youtube.length + built.kick.length + built.icerik.length;

  if (total === 0) {
    log("Tablodan hiç geçerli satır okunamadı, channels.json'a dokunulmuyor (güvenlik için).");
    return;
  }

  await writeFile(CHANNELS_PATH, JSON.stringify(built, null, 2) + "\n", "utf8");
  log(
    `channels.json güncellendi: youtube=${built.youtube.length}, kick=${built.kick.length}, icerik=${built.icerik.length}`
  );
}

main().catch((err) => {
  console.error("[sync-channels] Beklenmeyen hata:", err);
  // Bu adım başarısız olsa bile ana kontrol scripti (check-status.mjs) elindeki
  // mevcut channels.json ile çalışmaya devam edebilsin diye process'i 1 ile
  // değil sessizce bitiriyoruz.
});
