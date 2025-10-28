import * as cheerio from "cheerio";

// 🧠 كاش في الذاكرة (يختفي عند إعادة تشغيل السيرفر)
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 ساعة

export default async function handler(req, res) {
  const { phone } = req.query;
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  const searchKey = phone.toLowerCase().trim();

  // ✅ تحقق من الكاش أولاً
  const cached = cache.get(searchKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ تم جلب النتيجة من الكاش: ${searchKey}`);
    return res.status(200).json({
      mode: "cached",
      results: cached.data,
      total: cached.data.length,
      cached: true,
    });
  }

  try {
    const baseUrl = "https://telfonak.com";
    const allResults = [];

    console.log("🚀 بدء البحث الشامل عن:", phone);

    // 🟢 جلب الصفحة الأولى لتحديد عدد الصفحات
    const firstUrl = `${baseUrl}/?s=${encodeURIComponent(phone)}`;
    const firstResponse = await fetch(firstUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ar,en;q=0.9" },
    });
    if (!firstResponse.ok)
      throw new Error("تعذر تحميل الصفحة الأولى من الموقع.");

    const firstHtml = await firstResponse.text();
    const $first = cheerio.load(firstHtml);

    // 🔹 تحديد عدد الصفحات من الترقيم (أو 1 إن لم يوجد)
    const lastPage =
      parseInt(
        $first(".pagination a.page-numbers, .nav-links a.page-numbers")
          .last()
          .text()
          .trim()
      ) || 1;

    console.log(`📄 عدد الصفحات المكتشفة: ${lastPage}`);

    // 🟢 توليد كل روابط الصفحات
    const pageUrls = Array.from({ length: lastPage }, (_, i) =>
      i === 0
        ? firstUrl
        : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(phone)}`
    );

    // 🟢 جلب جميع الصفحات بالتوازي
    const pageHtmls = await Promise.allSettled(
      pageUrls.map(async (url) => {
        const resPage = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "ar,en;q=0.9",
          },
        });
        if (!resPage.ok) return null;
        return await resPage.text();
      })
    );

    // 🟢 استخراج روابط الهواتف من جميع الصفحات
    const allPhoneLinks = [];
    for (const result of pageHtmls) {
      if (result.status === "fulfilled" && result.value) {
        const $ = cheerio.load(result.value);
        $(".media, .post, article").each((_, el) => {
          const link = $(el).find("a.image-link").attr("href");
          const title = $(el).find("a.image-link").attr("title");
          const img =
            $(el).find("span.img").attr("data-bgsrc") ||
            $(el).find("img").attr("src");
          if (link && title) allPhoneLinks.push({ link, title, img });
        });
      }
    }

    console.log(`📱 تم العثور على ${allPhoneLinks.length} نتيجة أولية.`);

    // 🟢 تحميل صفحات الهواتف بالتوازي (مع حد لتجنب الضغط)
    const concurrencyLimit = 10;
    const chunks = [];
    for (let i = 0; i < allPhoneLinks.length; i += concurrencyLimit) {
      chunks.push(allPhoneLinks.slice(i, i + concurrencyLimit));
    }

    for (const batch of chunks) {
      const batchResults = await Promise.allSettled(
        batch.map(async ({ link, title, img }) => {
          try {
            const phonePage = await fetch(link, {
              headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept-Language": "ar,en;q=0.9",
              },
            });
            if (!phonePage.ok) return null;
            const html = await phonePage.text();
            const $ = cheerio.load(html);

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
              source: "telfonak.com",
            };
          } catch {
            return null;
          }
        })
      );

      allResults.push(
        ...batchResults
          .filter((r) => r.status === "fulfilled" && r.value)
          .map((r) => r.value)
      );
    }

    console.log(`✅ تم استخراج ${allResults.length} هاتف من جميع الصفحات.`);

    // 🟢 فلترة النتائج وتنظيفها
    const searchTerm = phone.toLowerCase();
    const filtered = allResults.filter(
      (item) =>
        item.title.toLowerCase().includes(searchTerm) ||
        item.modelArray.some((m) => m.toLowerCase().includes(searchTerm))
    );

    const uniqueMap = new Map();
    for (const item of filtered) {
      const key = `${item.title.toLowerCase()}|${item.model.toLowerCase()}`;
      if (!uniqueMap.has(key)) uniqueMap.set(key, item);
    }

    const uniqueResults = Array.from(uniqueMap.values());

    // 🧠 تخزين النتيجة في الكاش
    cache.set(searchKey, { data: uniqueResults, timestamp: Date.now() });

    return res.status(200).json({
      mode: "list",
      results: uniqueResults,
      total: uniqueResults.length,
      totalPages: lastPage,
      cached: false,
    });
  } catch (err) {
    console.error("⚠️ خطأ أثناء الجلب:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب البيانات." });
  }
}
