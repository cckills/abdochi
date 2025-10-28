import * as cheerio from "cheerio";

// 🧠 كاش في الذاكرة (اختياري لتسريع الطلبات المتكررة)
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة واحدة

export default async function handler(req, res) {
  const { phone } = req.query;
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  const searchKey = phone.toLowerCase().trim();
  const baseUrl = "https://telfonak.com";

  // ✅ تحقق من الكاش أولًا
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

  const allPhones = [];
  let page = 1;

  console.log("🚀 بدء البحث عن:", searchKey);

  // ✅ تحميل جميع الصفحات حتى آخر صفحة بها نتائج
  while (true) {
    const url =
      page === 1
        ? `${baseUrl}/?s=${encodeURIComponent(searchKey)}`
        : `${baseUrl}/page/${page}/?s=${encodeURIComponent(searchKey)}`;

    console.log(`🔎 تحميل الصفحة ${page}: ${url}`);

    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept-Language": "ar,en;q=0.9",
      },
    });

    if (!resp.ok) {
      console.log(`⚠️ فشل تحميل الصفحة ${page}`);
      break;
    }

    const html = await resp.text();
    const $ = cheerio.load(html);
    const posts = $(".media, .post, article");

    if (posts.length === 0) {
      console.log(`❌ لا توجد نتائج في الصفحة ${page} — التوقف`);
      break;
    }

    posts.each((_, el) => {
      const link = $(el).find("a.image-link").attr("href");
      const title = $(el).find("a.image-link").attr("title");
      const img =
        $(el).find("span.img").attr("data-bgsrc") ||
        $(el).find("img").attr("src");
      if (link && title) allPhones.push({ link, title, img });
    });

    console.log(`✅ تم استخراج ${posts.length} من الصفحة ${page}`);
    page++;
  }

  console.log(`📄 المجموع الكلي من الصفحات: ${page - 1}`);
  console.log(`📱 عدد الهواتف المجمعة: ${allPhones.length}`);

  if (allPhones.length === 0)
    return res.status(404).json({
      error: "❌ لم يتم العثور على أي نتائج لهذا الاسم.",
      total: 0,
      results: [],
    });

  // 🧩 إزالة التكرارات
  const uniquePhones = Array.from(
    new Map(allPhones.map((p) => [p.link, p])).values()
  );

  console.log(`🧹 بعد إزالة التكرارات: ${uniquePhones.length}`);

  // ✅ تحميل تفاصيل الهواتف بالتوازي مع تحديد السرعة
  const concurrencyLimit = 10;
  const chunks = [];
  for (let i = 0; i < uniquePhones.length; i += concurrencyLimit) {
    chunks.push(uniquePhones.slice(i, i + concurrencyLimit));
  }

  const fullResults = [];
  let processed = 0;

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
          const phoneHtml = await phonePage.text();
          const $ = cheerio.load(phoneHtml);

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
          console.log(`📦 تمت معالجة (${processed}/${uniquePhones.length}): ${title}`);

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
      ...batchResults
        .filter((r) => r.status === "fulfilled" && r.value)
        .map((r) => r.value)
    );
  }

  console.log(`✅ تم استخراج تفاصيل ${fullResults.length} هاتف.`);

  // 🔍 فلترة وتنظيف النتائج
  const searchTermLower = searchKey.toLowerCase();
  const filtered = fullResults.filter(
    (item) =>
      item.title.toLowerCase().includes(searchTermLower) ||
      item.modelArray.some((m) => m.toLowerCase().includes(searchTermLower))
  );

  const uniqueMap = new Map();
  for (const item of filtered) {
    const key = `${item.title.toLowerCase()}|${item.model.toLowerCase()}`;
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }

  const uniqueResults = Array.from(uniqueMap.values());

  // 🧠 تخزين في الكاش
  cache.set(searchKey, { data: uniqueResults, timestamp: Date.now() });

  return res.status(200).json({
    mode: "list",
    results: uniqueResults,
    total: uniqueResults.length,
    totalPages: page - 1,
    cached: false,
  });
}
