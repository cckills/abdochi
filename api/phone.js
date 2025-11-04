import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 20; // عدد الطلبات المتوازية
const baseUrl = "https://telfonak.com";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  const searchKey = (phone || "").toLowerCase().trim();
  const startTime = Date.now();

  // 🧠 في حالة عدم وجود كلمة بحث → جلب جميع الهواتف من كل الصفحات
  if (!searchKey) {
    console.log("🌐 لا يوجد استعلام — سيتم جلب جميع الهواتف من الموقع");

    try {
      // 1️⃣ جلب الصفحة الرئيسية لتحديد عدد الصفحات
      const homeRes = await fetch(baseUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!homeRes.ok)
        return res.status(500).json({ error: "فشل تحميل الصفحة الرئيسية." });

      const homeHtml = await homeRes.text();
      const $ = cheerio.load(homeHtml);

      const pagination = $(".page-numbers, .nav-links a.page-numbers")
        .map((_, el) => parseInt($(el).text().trim()))
        .get()
        .filter((n) => !isNaN(n));
      const totalPages = pagination.length ? Math.max(...pagination) : 1;

      console.log(`📄 عدد الصفحات: ${totalPages}`);

      // 2️⃣ إنشاء روابط كل الصفحات
      const pageUrls = Array.from({ length: totalPages }, (_, i) =>
        i === 0 ? baseUrl : `${baseUrl}/page/${i + 1}/`
      );

      const allPhones = [];

      // 3️⃣ جلب الصفحات بالتوازي
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

            console.log(`📃 صفحة: ${url} ➜ ${phones.length} هاتف`);
            return phones;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled" && Array.isArray(result.value)) {
            allPhones.push(...result.value);
          }
        }
        await delay(300);
      }

      console.log(`📱 إجمالي الهواتف قبل التنقية: ${allPhones.length}`);

      // 🧹 إزالة التكرار
      const uniquePhones = Array.from(
        new Map(allPhones.map((p) => [p.link, p])).values()
      );

      console.log(`✅ بعد إزالة التكرار: ${uniquePhones.length}`);

      const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
      return res.status(200).json({
        total: uniquePhones.length,
        totalPages,
        timeTaken,
        results: uniquePhones,
        all: true,
      });
    } catch (err) {
      console.error("❌ خطأ أثناء جلب الهواتف:", err);
      return res.status(500).json({ error: "حدث خطأ أثناء جلب جميع الهواتف." });
    }
  }

  // 🔎 الكود الأصلي للبحث المخصص (عند وجود كلمة)
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

  const firstUrl = `${baseUrl}/?s=${encodeURIComponent(searchKey)}`;
  const firstRes = await fetch(firstUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!firstRes.ok)
    return res.status(500).json({ error: "فشل تحميل الصفحة الأولى." });

  const firstHtml = await firstRes.text();
  const $ = cheerio.load(firstHtml);

  const pagination = $(".page-numbers, .nav-links a.page-numbers")
    .map((_, el) => parseInt($(el).text().trim()))
    .get()
    .filter((n) => !isNaN(n));
  const totalPages = pagination.length ? Math.max(...pagination) : 1;

  console.log(`📄 عدد الصفحات الكلي: ${totalPages}`);

  const allPageUrls = Array.from({ length: totalPages }, (_, i) =>
    i === 0
      ? firstUrl
      : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(searchKey)}`
  );

  const allPhones = [];
  for (let i = 0; i < allPageUrls.length; i += CONCURRENCY_LIMIT) {
    const chunk = allPageUrls.slice(i, i + CONCURRENCY_LIMIT);
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
    await delay(200);
  }

  const uniquePhones = Array.from(
    new Map(allPhones.map((p) => [p.link, p])).values()
  );

  cache.set(searchKey, { data: uniquePhones, timestamp: Date.now() });
  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
  return res.status(200).json({
    total: uniquePhones.length,
    totalPages,
    timeTaken,
    results: uniquePhones,
    cached: false,
  });
}
