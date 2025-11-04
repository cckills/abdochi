import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 40; // عدد الطلبات المتوازية
const DELAY_BETWEEN_BATCHES = 80; // بالمللي ثانية
const baseUrl = "https://telfonak.com";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  const searchKey = phone ? phone.toLowerCase().trim() : null;
  const cacheKey = searchKey || "all";
  const startTime = Date.now();

  // ✅ تحقق من الكاش أولاً
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ من الكاش: ${cacheKey}`);
    return res.status(200).json({
      cached: true,
      total: cached.data.length,
      results: cached.data,
    });
  }

  if (!phone) {
    console.log("🚀 تفعيل وضع الجلب الكامل لجميع الماركات من الموقع...");
  } else {
    console.log(`🔍 بدء البحث عن "${searchKey}" في telfonak.com ...`);
  }

  try {
    let allPhones = [];

    // 🧠 إذا لم يوجد استعلام → استخرج قائمة الماركات أولًا
    let brandUrls = [];
    if (!phone) {
      const homeRes = await fetch(baseUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const homeHtml = await homeRes.text();
      const $ = cheerio.load(homeHtml);

      brandUrls = $("ul.menu a, .brand-list a")
        .map((_, el) => $(el).attr("href"))
        .get()
        .filter((u) => u && u.includes("https://telfonak.com/") && !u.includes("?s="));

      brandUrls = [...new Set(brandUrls)];
      console.log(`🏷️ تم العثور على ${brandUrls.length} ماركة.`);
    } else {
      // وضع البحث
      brandUrls = [`${baseUrl}/?s=${encodeURIComponent(searchKey)}`];
    }

    // 🌀 جلب جميع الصفحات لجميع الماركات
    const brandChunks = [];
    for (let i = 0; i < brandUrls.length; i += CONCURRENCY_LIMIT) {
      brandChunks.push(brandUrls.slice(i, i + CONCURRENCY_LIMIT));
    }

    for (const brandChunk of brandChunks) {
      const chunkResults = await Promise.allSettled(
        brandChunk.map(async (brandUrl) => {
          const phones = [];
          let currentPage = 1;
          let totalPages = 1;

          do {
            const url =
              currentPage === 1
                ? brandUrl
                : `${brandUrl}page/${currentPage}/`;
            const resPage = await fetch(url, {
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            if (!resPage.ok) break;

            const html = await resPage.text();
            const $ = cheerio.load(html);

            // تحديد عدد الصفحات
            if (currentPage === 1) {
              const pagination = $(".page-numbers, .nav-links a.page-numbers")
                .map((_, el) => parseInt($(el).text().trim()))
                .get()
                .filter((n) => !isNaN(n));
              totalPages = pagination.length ? Math.max(...pagination) : 1;
              console.log(`📄 ${brandUrl} يحتوي على ${totalPages} صفحة.`);
            }

            $(".media, .post, article").each((_, el) => {
              const link = $(el).find("a.image-link").attr("href");
              const title = $(el).find("a.image-link").attr("title");
              const img =
                $(el).find("span.img").attr("data-bgsrc") ||
                $(el).find("img").attr("src");
              if (link && title) phones.push({ link, title, img });
            });

            currentPage++;
          } while (currentPage <= totalPages);

          return phones;
        })
      );

      for (const result of chunkResults) {
        if (result.status === "fulfilled" && Array.isArray(result.value)) {
          allPhones.push(...result.value);
        }
      }

      await delay(DELAY_BETWEEN_BATCHES);
    }

    console.log(`📱 تم العثور على ${allPhones.length} هاتف مبدئيًا.`);

    // 🧹 إزالة التكرارات
    const uniquePhones = Array.from(
      new Map(allPhones.map((p) => [p.link, p])).values()
    );
    console.log(`🧩 بعد إزالة التكرارات: ${uniquePhones.length}`);

    // 🧠 جلب التفاصيل (المعالج + الأسعار + الموديل)
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

            // 🟢 الأسعار
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

            // 🔹 المعالج
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

            // 🔹 الموديل
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

      await delay(DELAY_BETWEEN_BATCHES);
    }

    console.log(`✅ تم جمع ${details.length} هاتف بالتفاصيل.`);

    // 🧠 تخزين في الكاش
    cache.set(cacheKey, { data: details, timestamp: Date.now() });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    return res.status(200).json({
      total: details.length,
      timeTaken,
      cached: false,
      results: details,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء الجلب:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء الجلب." });
  }
}
