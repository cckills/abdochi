import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 20; // عدد الطلبات المتوازية
const baseUrl = "https://telfonak.com";
const brandList = ["samsung", "apple", "xiaomi", "oppo", "huawei", "realme", "vivo", "honor", "infinix"];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    return cheerio.load(html);
  } catch {
    return null;
  }
}

async function fetchAllPhonesForBrand(brand) {
  const allPhones = [];
  const firstUrl = `${baseUrl}/?s=${encodeURIComponent(brand)}`;
  const $ = await fetchPage(firstUrl);
  if (!$) return [];

  // تحديد عدد الصفحات
  const pagination = $(".page-numbers, .nav-links a.page-numbers")
    .map((_, el) => parseInt($(el).text().trim()))
    .get()
    .filter((n) => !isNaN(n));
  const totalPages = pagination.length ? Math.max(...pagination) : 1;

  // إنشاء روابط كل الصفحات
  const allPageUrls = Array.from({ length: totalPages }, (_, i) =>
    i === 0
      ? firstUrl
      : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(brand)}`
  );

  // جلب كل الصفحات بالتوازي
  const pageChunks = [];
  for (let i = 0; i < allPageUrls.length; i += CONCURRENCY_LIMIT) {
    pageChunks.push(allPageUrls.slice(i, i + CONCURRENCY_LIMIT));
  }

  for (const chunk of pageChunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map(async (url) => {
        const $ = await fetchPage(url);
        if (!$) return [];
        const results = [];
        $(".media, .post, article").each((_, el) => {
          const link = $(el).find("a.image-link").attr("href");
          const title = $(el).find("a.image-link").attr("title");
          const img =
            $(el).find("span.img").attr("data-bgsrc") ||
            $(el).find("img").attr("src");
          if (link && title) results.push({ link, title, img });
        });
        return results;
      })
    );

    for (const result of chunkResults) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        allPhones.push(...result.value);
      }
    }

    await delay(200);
  }

  return allPhones;
}

async function fetchPhoneDetails(phone) {
  const { link, title, img } = phone;
  const $ = await fetchPage(link);
  if (!$) return null;

  // جلب الأسعار
  const prices = [];
  $(".bs-shortcode-list li, .telfon-price tr").each((_, el) => {
    const country =
      $(el).find("strong").text().trim() ||
      $(el).find("td:first-child").text().trim();
    const price =
      $(el).find("span").text().trim() ||
      $(el).find("td:last-child").text().trim();
    if (country && price) prices.push({ country, price });
  });

  // جلب المعالج
  let fullChipset =
    $("tr:contains('المعالج') td.aps-attr-value span").text().trim() ||
    $("tr:contains('المعالج') td.aps-attr-value").text().trim() ||
    "";
  fullChipset = fullChipset.replace(/\s+/g, " ").trim();

  let shortChipset = fullChipset;
  if (fullChipset) {
    fullChipset = fullChipset
      .replace(/ثماني النواة|سداسي النواة|رباعي النواة|ثنائي النواة/gi, "")
      .replace(/[\(\)\-\–\,]/g, " ")
      .replace(/\b\d+(\.\d+)?\s*GHz\b/gi, "")
      .replace(/\b\d+\s*nm\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = fullChipset.match(/[A-Za-z\u0600-\u06FF]+\s*[A-Za-z0-9\-]+/);
    shortChipset = match ? match[0].trim() : fullChipset;
  }

  // جلب الموديل
  const modelRow =
    $("tr:contains('الموديل / الطراز') td.aps-attr-value span").text().trim() ||
    $("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
    $("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
    "";
  const modelArray = modelRow ? modelRow.split(",").map((m) => m.trim()) : [];

  return {
    title,
    link,
    img,
    chipset: shortChipset || "غير محدد",
    model: modelArray.join(", "),
    modelArray,
    prices,
    source: "telfonak.com",
  };
}

export default async function handler(req, res) {
  const { phone } = req.query;
  const startTime = Date.now();

  let searchKeys = [];
  if (phone) {
    searchKeys = [phone.toLowerCase().trim()];
  } else {
    searchKeys = brandList; // جلب كل الماركات عند الوضع الكامل
  }

  let allPhones = [];
  for (const key of searchKeys) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      allPhones.push(...cached.data);
      continue;
    }

    const brandPhones = await fetchAllPhonesForBrand(key);

    // جلب التفاصيل لكل هاتف
    const detailChunks = [];
    for (let i = 0; i < brandPhones.length; i += CONCURRENCY_LIMIT) {
      detailChunks.push(brandPhones.slice(i, i + CONCURRENCY_LIMIT));
    }

    const details = [];
    for (const batch of detailChunks) {
      const batchResults = await Promise.allSettled(
        batch.map(fetchPhoneDetails)
      );
      for (const result of batchResults) {
        if (result.status === "fulfilled" && result.value) details.push(result.value);
      }
      await delay(200);
    }

    // إزالة التكرار
    const uniqueResults = Array.from(
      new Map(details.map((r) => [`${r.title.toLowerCase()}|${r.model.toLowerCase()}`, r])).values()
    );

    cache.set(key, { data: uniqueResults, timestamp: Date.now() });
    allPhones.push(...uniqueResults);
  }

  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
  return res.status(200).json({
    total: allPhones.length,
    timeTaken,
    results: allPhones,
    cached: false,
  });
}
