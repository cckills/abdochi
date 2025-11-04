import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة واحدة
const CONCURRENCY_LIMIT = 15;
const baseUrl = "https://telfonak.com";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  const searchKey = (phone || "").toLowerCase().trim();
  const cacheKey = searchKey || "__ALL__";
  const startTime = Date.now();

  // ✅ تحقق من الكاش
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ من الكاش: ${cacheKey}`);
    return res.status(200).json({
      cached: true,
      total: cached.data.length,
      results: cached.data,
    });
  }

  console.log(
    `🚀 بدء جمع ${
      searchKey ? `نتائج "${searchKey}"` : "كل الهواتف من الموقع بالكامل"
    } ...`
  );

  try {
    // 🟢 الخطوة 1: استخراج الماركات من الصفحة الرئيسية
    const mainRes = await fetch(baseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const mainHtml = await mainRes.text();
    

    // نحاول استخراج روابط الماركات (إن وُجدت)
    let brands = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes("/brand/") || href.includes("/category/")) {
        const name = $(el).text().trim();
        if (name && !brands.includes(name.toLowerCase())) brands.push(name.toLowerCase());
      }
    });

    // قائمة احتياطية في حال لم يُعثر على ماركات بالموقع
    if (brands.length === 0) {
      brands = [
        "samsung",
        "apple",
        "xiaomi",
        "oppo",
        "huawei",
        "realme",
        "infinix",
        "vivo",
        "honor",
        "tecno",
        "nokia",
        "oneplus",
        "google",
        "lenovo",
        "sony",
      ];
      console.log(`⚙️ لم يتم العثور على ماركات في الموقع — استخدام القائمة الاحتياطية (${brands.length})`);
    } else {
      console.log(`✅ تم العثور على ${brands.length} ماركات من الموقع`);
    }

    // 🌀 الروابط التي سيتم جلبها
    const allSearchUrls = brands.map(
      (b) => `${baseUrl}/?s=${encodeURIComponent(b)}`
    );

    const allPhones = [];

    // 🧩 الخطوة 2: جلب جميع صفحات نتائج كل ماركة
    for (const searchUrl of allSearchUrls) {
      console.log(`🔍 البحث عن: ${searchUrl}`);
      const resSearch = await fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!resSearch.ok) continue;
      const html = await resSearch.text();
      const $ = cheerio.load(html);

      // تحديد عدد الصفحات
      const pagination = $(".page-numbers, .nav-links a.page-numbers")
        .map((_, el) => parseInt($(el).text().trim()))
        .get()
        .filter((n) => !isNaN(n));
      const totalPages = pagination.length ? Math.max(...pagination) : 1;

      // إنشاء روابط كل الصفحات
      const pageUrls = Array.from({ length: totalPages }, (_, i) =>
        i === 0
          ? searchUrl
          : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(
              searchUrl.split("=")[1]
            )}`
      );

      // تحميل كل الصفحات
      for (let i = 0; i < pageUrls.length; i += CONCURRENCY_LIMIT) {
        const chunk = pageUrls.slice(i, i + CONCURRENCY_LIMIT);
        const results = await Promise.allSettled(
          chunk.map(async (url) => {
            const resPage = await fetch(url, {
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            if (!resPage.ok) return [];
            const html = await resPage.text();
            const $ = cheerio.load(html);
            const phones = [];

            $(".media, .post, article").each((_, el) => {
              const link = $(el).find("a.image-link").attr("href");
              const title = $(el).find("a.image-link").attr("title");
              const img =
                $(el).find("span.img").attr("data-bgsrc") ||
                $(el).find("img").attr("src");
              if (link && title) phones.push({ title, link, img });
            });

            console.log(`📄 ${url} ➜ ${phones.length} هواتف`);
            return phones;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled" && Array.isArray(result.value))
            allPhones.push(...result.value);
        }

        await delay(300);
      }
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
