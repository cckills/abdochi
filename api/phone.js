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

  try {
    let allPhones = [];
    let brandUrls = [];

    if (!phone) {
      console.log("🚀 تفعيل وضع الجلب الكامل لجميع الماركات...");
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
      brandUrls = [`${baseUrl}/?s=${encodeURIComponent(searchKey)}`];
    }

    // 🌀 جلب جميع صفحات كل ماركة بدون توقف حتى لا توجد نتائج جديدة
    const brandChunks = [];
    for (let i = 0; i < brandUrls.length; i += CONCURRENCY_LIMIT) {
      brandChunks.push(brandUrls.slice(i, i + CONCURRENCY_LIMIT));
    }

    for (const brandChunk of brandChunks) {
      const chunkResults = await Promise.allSettled(
        brandChunk.map(async (brandUrl) => {
          let phones = [];
          let currentPage = 1;
          let lastCount = 0;

          while (true) {
            const url =
              currentPage === 1
                ? brandUrl
                : brandUrl.endsWith("/")
                ? `${brandUrl}page/${currentPage}/`
                : `${brandUrl}/page/${currentPage}/`;

            console.log(`🌐 جلب الصفحة ${currentPage} من ${brandUrl}`);
            const resPage = await fetch(url, {
              headers: { "User-Agent": "Mozilla/5.0" },
            });
            if (!resPage.ok) break;

            const html = await resPage.text();
            const $ = cheerio.load(html);

            const pagePhones = [];
            $(".media, .post, article").each((_, el) => {
              const link = $(el).find("a.image-link").attr("href");
              const title = $(el).find("a.image-link").attr("title");
              const img =
                $(el).find("span.img").attr("data-bgsrc") ||
                $(el).find("img").attr("src");
              if (link && title) pagePhones.push({ link, title, img });
            });

            if (pagePhones.length === 0 || pagePhones.length === lastCount) {
              console.log(`🛑 لا مزيد من النتائج - توقف عند الصفحة ${currentPage}`);
              break;
            }

            phones.push(...pagePhones);
            lastCount = pagePhones.length;
            currentPage++;
            await delay(100); // تأخير بسيط بين الصفحات
          }

          console.log(`✅ تم جمع ${phones.length} من ${brandUrl}`);
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

    console.log(`📱 تم العثور على ${allPhones.length} هاتف قبل التفاصيل.`);

    // 🧹 إزالة التكرارات
    const uniquePhones = Array.from(
      new Map(allPhones.map((p) => [p.link, p])).values()
    );

    // 🧠 تخزين النتائج مباشرة
    cache.set(cacheKey, { data: uniquePhones, timestamp: Date.now() });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    return res.status(200).json({
      total: uniquePhones.length,
      timeTaken,
      cached: false,
      results: uniquePhones,
    });
  } catch (error) {
    console.error("❌ خطأ أثناء الجلب:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء الجلب الكامل." });
  }
}
