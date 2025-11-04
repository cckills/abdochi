import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 20; // عدد الطلبات المتوازية (يمكن تعديله)
const baseUrl = "https://telfonak.com";
const brandList = ["samsung", "apple", "xiaomi", "oppo", "huawei", "realme", "vivo", "honor", "infinix"];

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  const searchKey = phone.toLowerCase().trim();
  const startTime = Date.now();

  // ✅ التحقق من الكاش أولاً
  const cached = cache.get(searchKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ من الكاش: ${searchKey}`);
    return res.status(200).json({
      cached: true,
      total: cached.data.length,
      results: cached.data,
    });
  }

  console.log(`🚀 بدء البحث عن "${searchKey}" في telfonak.com`);

  // 🧠 جلب أول صفحة لتحديد عدد الصفحات الكلي
  const firstUrl = `${baseUrl}/?s=${encodeURIComponent(searchKey)}`;
  const firstRes = await fetch(firstUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!firstRes.ok)
    return res.status(500).json({ error: "فشل تحميل الصفحة الأولى." });

  const firstHtml = await firstRes.text();
  const $ = cheerio.load(firstHtml);

  // 🔢 تحديد عدد الصفحات (إن وُجد ترقيم)
  const pagination = $(".page-numbers, .nav-links a.page-numbers")
    .map((_, el) => parseInt($(el).text().trim()))
    .get()
    .filter((n) => !isNaN(n));
  const totalPages = pagination.length ? Math.max(...pagination) : 1;

  console.log(`📄 عدد الصفحات الكلي: ${totalPages}`);

  // 🌀 إنشاء روابط كل الصفحات
  const allPageUrls = Array.from({ length: totalPages }, (_, i) =>
    i === 0
      ? firstUrl
      : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(searchKey)}`
  );

  // 🧩 جلب كل الصفحات بالتوازي
  const allPhones = [];
  const pageChunks = [];
  for (let i = 0; i < allPageUrls.length; i += CONCURRENCY_LIMIT) {
    pageChunks.push(allPageUrls.slice(i, i + CONCURRENCY_LIMIT));
  }

  for (const chunk of pageChunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map(async (url) => {
        try {
          const resPage = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!resPage.ok) return [];

          const html = await resPage.text();
          const $ = cheerio.load(html);

          const results = [];
          $(".media, .post, article").each((_, el) => {
            const link = $(el).find("a.image-link").attr("href");
            const title = $(el).find("a.image-link").attr("title");
            const img =
              $(el).find("span.img").attr("data-bgsrc") ||
              $(el).find("img").attr("src");
            if (link && title) results.push({ link, title, img });
          });

          console.log(`📃 صفحة: ${url} ➜ ${results.length} نتيجة`);
          return results;
        } catch {
          return [];
        }
      })
    );

    for (const result of chunkResults) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        allPhones.push(...result.value);
      }
    }

    await delay(200); // تأخير بسيط بين الدُفعات لتجنب الحظر
  }

  console.log(`📱 إجمالي النتائج الأولية: ${allPhones.length}`);

  // 🧹 إزالة التكرارات بسرعة
  const uniquePhones = Array.from(
    new Map(allPhones.map((p) => [p.link, p])).values()
  );

  console.log(`🧩 بعد إزالة التكرار: ${uniquePhones.length}`);

  // 🔍 جلب تفاصيل الهواتف بالتوازي
  const details = [];
  const detailChunks = [];
  for (let i = 0; i < uniquePhones.length; i += CONCURRENCY_LIMIT) {
    detailChunks.push(uniquePhones.slice(i, i + CONCURRENCY_LIMIT));
  }

  let processed = 0;

  for (const batch of detailChunks) {
    const batchResults = await Promise.allSettled(
      batch.map(async ({ link, title, img }) => {
        try {
          const phoneRes = await fetch(link, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!phoneRes.ok) return null;

          const html = await phoneRes.text();
          const $ = cheerio.load(html);
// 🟢 جلب الأسعار من الصفحة
let prices = [];
$(".bs-shortcode-list li, .telfon-price tr").each((_, el) => {
  const country =
    $(el).find("strong").text().trim() ||
    $(el).find("td:first-child").text().trim();
  const price =
    $(el).find("span").text().trim() ||
    $(el).find("td:last-child").text().trim();

  if (country && price) {
    prices.push({ country, price });
  }
});

          // 🔹 استخراج المعالج
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

          // 🔹 استخراج الموديل / الإصدار
          const modelRow =
            $("tr:contains('الموديل / الطراز') td.aps-attr-value span").text().trim() ||
            $("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
            $("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
            "";
          const modelArray = modelRow ? modelRow.split(",").map((m) => m.trim()) : [];

          processed++;
          console.log(`📦 (${processed}/${uniquePhones.length}) ${title}`);

          return {
            title,
            link,
            img,
            chipset: shortChipset || "غير محدد",
            model: modelArray.join(", "),
            modelArray,
       prices, // ← تمت الإضافة هنا
            source: "telfonak.com",
          };
        } catch {
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value)
        details.push(result.value);
    }

    await delay(200);
  }

  // 🔎 فلترة النتائج وتنظيفها
  const term = searchKey.toLowerCase();
  const filtered = details.filter(
    (item) =>
      item.title.toLowerCase().includes(term) ||
      item.modelArray.some((m) => m.toLowerCase().includes(term))
  );

  // إزالة التكرارات النهائية
  const uniqueResults = Array.from(
    new Map(
      filtered.map((r) => [`${r.title.toLowerCase()}|${r.model.toLowerCase()}`, r])
    ).values()
  );

  // 🧠 تخزين في الكاش
  cache.set(searchKey, { data: uniqueResults, timestamp: Date.now() });

  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ اكتمل البحث في ${timeTaken} ثانية — ${uniqueResults.length} نتيجة`);

  return res.status(200).json({
    total: uniqueResults.length,
    totalPages,
    timeTaken,
    results: uniqueResults,
    cached: false,
  });
}

