import * as cheerio from "cheerio";

const searchCache = new Map(); // ✅ Cache داخلي

export default async function handler(req, res) {
  const { phone } = req.query;
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  const searchTerm = phone.toLowerCase().trim();

  // ✅ إذا تم البحث عن هذا الاسم من قبل — نرجع من الذاكرة مباشرة
  if (searchCache.has(searchTerm)) {
    return res.status(200).json({ mode: "list", results: searchCache.get(searchTerm) });
  }

  try {
    const results = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= 3) { // ✅ تقليل الصفحات = أسرع
      const searchUrl =
        page === 1
          ? `https://telfonak.com/?s=${encodeURIComponent(phone)}`
          : `https://telfonak.com/page/${page}/?s=${encodeURIComponent(phone)}`;

      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win32; x64)",
          "Accept-Language": "ar,en;q=0.9",
        },
      });

      if (!response.ok) break;
      const html = await response.text();
      const $ = cheerio.load(html);
      const items = $(".media, .post, article");

      if (items.length === 0) break;

      for (const el of items.toArray()) {
        const link = $(el).find("a.image-link").attr("href");
        const title = $(el).find("a.image-link").attr("title")?.trim();
        let img =
          $(el).find("span.img").attr("data-bgsrc") ||
          $(el).find("img").attr("src") ||
          "";

        img = img.replace(/-150x150|-\d+x\d+/g, ""); // ✅ صورة بجودة أصلية

        if (!link || !title) continue;

        try {
          const phonePage = await fetch(link, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win32; x64)",
              "Accept-Language": "ar,en;q=0.9",
            },
          });

          if (!phonePage.ok) continue;
          const phoneHtml = await phonePage.text();
          const $$ = cheerio.load(phoneHtml);

          // ✅ استخراج المعالج بدقة
          let fullChipset =
            $$("tr:contains('المعالج') td.aps-attr-value").text().trim().replace(/\s+/g, " ");

          let shortChipset = fullChipset.replace(/(ثماني|سداسي|رباعي|ثنائي) النواة/gi, "")
            .replace(/[\d.]+\s*GHz/gi, "")
            .replace(/[\(\)\-,]/g, " ")
            .trim();

          const match = shortChipset.match(/[A-Za-z0-9]+[- ]*[A-Za-z0-9]+/);
          shortChipset = match ? match[0] : (fullChipset || "غير محدد");

          // ✅ استخراج الموديل
          const modelRow =
            $$("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
            $$("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
            "";

          const modelArray = modelRow.split(/[,\s]+/).filter(Boolean);

          results.push({
            title,
            link,
            img,
            chipset: shortChipset,
            model: modelArray.join(", "),
            modelArray,
            source: "telfonak.com",
          });

        } catch {}
      }

      hasNext = $(".pagination .next, .nav-links .next").length > 0;
      page++;
    }

    // ✅ فلترة و ترتيب وإزالة تكرار
    let filtered = results.filter(r =>
      r.title.toLowerCase().includes(searchTerm) ||
      r.modelArray.some(m => m.toLowerCase().includes(searchTerm))
    );

    filtered = Array.from(new Map(filtered.map(i => [i.title.toLowerCase(), i])).values());

    // ✅ حفظ في Cache
    searchCache.set(searchTerm, filtered);

    if (filtered.length > 0)
      return res.status(200).json({ mode: "list", results: filtered });

    res.status(404).json({ error: "❌ لا توجد نتائج مطابقة." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "⚠️ حدث خطأ أثناء الجلب." });
  }
}
