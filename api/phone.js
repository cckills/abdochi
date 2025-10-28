import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة واحدة
const CONCURRENCY_LIMIT = 15; // عدد الطلبات المتوازية (يمكن زيادته لـ 20 لو السيرفر يتحمل)

// أداة انتظار بسيطة بين الدُفعات
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const { phone } = req.query;
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  const startTime = Date.now();
  const searchKey = phone.toLowerCase().trim();
  const baseUrl = "https://telfonak.com";

  // ✅ الكاش أولاً
  const cached = cache.get(searchKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ تم جلب النتائج من الكاش: ${searchKey}`);
    return res.status(200).json({
      mode: "cached",
      results: cached.data,
      total: cached.data.length,
      cached: true,
    });
  }

  console.log("🚀 بدء البحث عن:", searchKey);

  // 🧠 جلب أول صفحة لاكتشاف عدد الصفحات المتاحة
  const firstPageUrl = `${baseUrl}/?s=${encodeURIComponent(searchKey)}`;
  const firstResp = await fetch(firstPageUrl, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ar,en;q=0.9" },
  });

  if (!firstResp.ok)
    return res.status(500).json({ error: "فشل في تحميل الصفحة الأولى." });

  const firstHtml = await firstResp.text();
  const $ = cheerio.load(firstHtml);

  // تحديد عدد الصفحات (إذا وُجد pagination)
  let totalPages = 1;
  const pagination = $(".page-numbers li a")
    .map((_, el) => parseInt($(el).text()))
    .get();
  const maxPage = Math.max(...pagination.filter((n) => !isNaN(n)));
  if (maxPage > 1) totalPages = maxPage;

  console.log(`📄 عدد الصفحات المتوقع: ${totalPages}`);

  // 🌀 تحميل جميع الصفحات بالتوازي
  const pageUrls = Array.from({ length: totalPages }, (_, i) =>
    i === 0
      ? firstPageUrl
      : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(searchKey)}`
  );

  const pageResults = await Promise.allSettled(
    pageUrls.map(async (url, i) => {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept-Language": "ar,en;q=0.9",
          },
        });
        if (!resp.ok) return [];

        const html = await resp.text();
        const $ = cheerio.load(html);
        const posts = $(".media, .post, article");

        const phones = [];
        posts.each((_, el) => {
          const link = $(el).find("a.image-link").attr("href");
          const title = $(el).find("a.image-link").attr("title");
          const img =
            $(el).find("span.img").attr("data-bgsrc") ||
            $(el).find("img").attr("src");
          if (link && title) phones.push({ link, title, img });
        });

        console.log(`✅ الصفحة ${i + 1}: ${phones.length} هاتف`);
        return phones;
      } catch {
        console.log(`⚠️ فشل الصفحة ${i + 1}`);
        return [];
      }
    })
  );

  const allPhones = pageResults.flatMap((r) =>
    r.status === "fulfilled" ? r.value : []
  );

  // إزالة التكرارات بسرعة باستخدام Set
  const uniquePhones = Array.from(
    new Map(allPhones.map((p) => [p.link, p])).values()
  );
  console.log(`📱 إجمالي الهواتف الفريدة: ${uniquePhones.length}`);

  if (uniquePhones.length === 0)
    return res.status(404).json({
      error: "❌ لم يتم العثور على نتائج.",
      total: 0,
      results: [],
    });

  // 🔁 تحميل تفاصيل الهواتف بسرعة بدُفعات متوازية
  const fullResults = [];
  for (let i = 0; i < uniquePhones.length; i += CONCURRENCY_LIMIT) {
    const batch = uniquePhones.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.allSettled(
      batch.map(async ({ link, title, img }) => {
        try {
          const phonePage = await fetch(link, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!phonePage.ok) return null;
          const html = await phonePage.text();
          const $ = cheerio.load(html);

          // استخراج المعالج
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

          // استخراج الموديل
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

    fullResults.push(
      ...results
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value)
    );

    console.log(`📦 معالجة ${fullResults.length}/${uniquePhones.length}`);
    await delay(200); // تأخير بسيط لتجنب حظر السيرفر
  }

  // فلترة النتيجة النهائية
  const searchTermLower = searchKey.toLowerCase();
  const filtered = fullResults.filter(
    (item) =>
      item.title.toLowerCase().includes(searchTermLower) ||
      item.modelArray.some((m) => m.toLowerCase().includes(searchTermLower))
  );

  // إزالة التكرارات النهائية
  const finalMap = new Map();
  for (const item of filtered) {
    const key = `${item.title.toLowerCase()}|${item.model.toLowerCase()}`;
    if (!finalMap.has(key)) finalMap.set(key, item);
  }

  const uniqueResults = Array.from(finalMap.values());

  // حفظ الكاش
  cache.set(searchKey, { data: uniqueResults, timestamp: Date.now() });

  const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`✅ اكتمل البحث في ${timeTaken} ثانية — ${uniqueResults.length} نتيجة`);

  return res.status(200).json({
    mode: "list",
    total: uniqueResults.length,
    totalPages,
    timeTaken,
    results: uniqueResults,
    cached: false,
  });
}
