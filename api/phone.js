import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة واحدة
const CONCURRENCY_LIMIT = 40; // ✅ رفع عدد الطلبات المتوازية لتسريع الجلب
const baseUrl = "https://telfonak.com";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  const searchKey = (phone || "").toLowerCase().trim();
  const startTime = Date.now();

  // ✅ إذا لا يوجد استعلام: نجلب كل الهواتف (لكل الماركات)
  if (!searchKey) {
    const cachedAll = cache.get("ALL_PHONES");
    if (cachedAll && Date.now() - cachedAll.timestamp < CACHE_TTL) {
      console.log("⚡ تم استخدام الكاش الكامل لجميع الهواتف");
      return res.status(200).json({
        total: cachedAll.data.length,
        results: cachedAll.data,
        cached: true,
      });
    }

    console.log("🚀 بدء جمع كل الهواتف من الموقع...");

    // 🧭 محاولة استخراج الماركات من الموقع
    const homeRes = await fetch(baseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await homeRes.text();
    const $ = cheerio.load(html);

    let brands = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (href && /brand|category|%d9%85%d8%a7%d8%b1%d9%83%d8%a9|ماركة|category-name/i.test(href)) {
        const name = $(el).text().trim();
        if (name && !brands.includes(name.toLowerCase())) brands.push(name.toLowerCase());
      }
    });

    // 🧩 قائمة احتياطية إن لم يجد ماركات
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
      ];
    }

    console.log(`🏷️ عدد الماركات التي سيتم جمعها: ${brands.length}`);

    const allPhones = [];

    for (const brand of brands) {
      console.log(`🔍 جمع هواتف الماركة: ${brand}`);
      const brandUrl = `${baseUrl}/?s=${encodeURIComponent(brand)}`;

      const firstRes = await fetch(brandUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const firstHtml = await firstRes.text();
      const $b = cheerio.load(firstHtml);

      // حساب عدد الصفحات للماركة
      const pagination = $b(".page-numbers, .nav-links a.page-numbers")
        .map((_, el) => parseInt($b(el).text().trim()))
        .get()
        .filter((n) => !isNaN(n));
      const totalPages = pagination.length ? Math.max(...pagination) : 1;

      const pageUrls = Array.from({ length: totalPages }, (_, i) =>
        i === 0
          ? brandUrl
          : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(brand)}`
      );

      // 🔁 جلب الصفحات بالتوازي (مع السرعة)
      const pageChunks = [];
      for (let i = 0; i < pageUrls.length; i += CONCURRENCY_LIMIT) {
        pageChunks.push(pageUrls.slice(i, i + CONCURRENCY_LIMIT));
      }

      for (const chunk of pageChunks) {
        const resultsChunk = await Promise.allSettled(
          chunk.map(async (url) => {
            const r = await fetch(url, {
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            if (!r.ok) return [];
            const html = await r.text();
            const $ = cheerio.load(html);
            const results = [];
            $(".media, .post, article").each((_, el) => {
              const link = $(el).find("a.image-link").attr("href");
              const title = $(el).find("a.image-link").attr("title");
              const img =
                $(el).find("span.img").attr("data-bgsrc") ||
                $(el).find("img").attr("src");
              if (link && title) results.push({ title, link, img });
            });
            return results;
          })
        );

        for (const res of resultsChunk) {
          if (res.status === "fulfilled") allPhones.push(...res.value);
        }

        await delay(80); // ✅ تم تقليل التأخير لتسريع التنفيذ
      }
    }

    // إزالة التكرارات
    const uniquePhones = Array.from(
      new Map(allPhones.map((p) => [p.link, p])).values()
    );
    console.log(`📱 عدد الهواتف بدون تكرار: ${uniquePhones.length}`);

    // ✅ الآن نجلب التفاصيل لكل هاتف (بسرعة عالية)
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

            // الأسعار
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

            // المعالج
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

            // الموديل
            const modelRow =
              $("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
              $("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
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
              prices,
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

      await delay(80);
    }

    // حفظ في الكاش
    cache.set("ALL_PHONES", { data: details, timestamp: Date.now() });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ تم جمع ${details.length} هاتفًا في ${timeTaken} ثانية`);

    return res.status(200).json({
      total: details.length,
      timeTaken,
      results: details,
      cached: false,
    });
  }

  // ✅ في حال البحث العادي
  const cached = cache.get(searchKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.status(200).json({
      cached: true,
      total: cached.data.length,
      results: cached.data,
    });
  }

  return res.status(400).json({ error: "تم تفعيل وضع الجلب الكامل فقط بدون استعلام." });
}
