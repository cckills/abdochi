import * as cheerio from "cheerio";

export default async function handler(req, res) {
  const { phone, searchType } = req.query;
  
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف." });

  if (!searchType || !["model", "name"].includes(searchType)) {
    return res.status(400).json({ error: "يرجى تحديد نوع البحث (model أو name)." });
  }

  try {
    const results = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= 5) {
      const searchUrl =
        page === 1
          ? `https://telfonak.com/?s=${encodeURIComponent(phone)}`
          : `https://telfonak.com/page/${page}/?s=${encodeURIComponent(phone)}`;

      console.log("⏳ Fetching:", searchUrl);

      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept-Language": "ar,en;q=0.9",
        },
      });

      if (!response.ok) break;
      const html = await response.text();
      const $ = cheerio.load(html);
      const items = $(".media, .post, article");

      if (items.length === 0) {
        hasNext = false;
        break;
      }

      for (const el of items.toArray()) {
        const link = $(el).find("a.image-link").attr("href");
        const title = $(el).find("a.image-link").attr("title");
        const img =
          $(el).find("span.img").attr("data-bgsrc") ||
          $(el).find("img").attr("src");

        if (link && title) {
          try {
            const phonePage = await fetch(link, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept-Language": "ar,en;q=0.9",
              },
            });

            if (phonePage.ok) {
              const phoneHtml = await phonePage.text();
              const $$ = cheerio.load(phoneHtml);

              let fullChipset =
                $$("tr:contains('المعالج') td.aps-attr-value span").text().trim() ||
                $$("tr:contains('المعالج') td.aps-attr-value").text().trim() ||
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

              // 🔹 جلب موديل/طراز الجهاز إن وجد
              const model =
                $$("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
                $$("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
                "";

              results.push({
                title,
                link,
                img,
                chipset: shortChipset || "غير محدد",
                model: model || "", // إضافة الموديل هنا
                source: "telfonak.com",
              });
            }
          } catch (err) {
            console.error("⚠️ خطأ أثناء جلب صفحة الهاتف:", err.message);
          }
        }
      }

      hasNext = $(".pagination .next, .nav-links .next").length > 0;
      page++;
    }

    const searchTerm = phone.toLowerCase();

    // 🔹 فلترة النتائج بناءً على نوع البحث (الموديل أو الاسم)
    let filteredResults = [];
    if (searchType === "name") {
      filteredResults = results.filter(item =>
        item.title.toLowerCase().includes(searchTerm)
      );
    } else if (searchType === "model") {
      filteredResults = results.filter(item =>
        item.model.toLowerCase().includes(searchTerm)
      );
    }

    // 🔹 ترتيب النتائج بحيث تبدأ الأجهزة الأقرب لاسم البحث أولاً
    filteredResults.sort((a, b) => {
      const titleA = a.title.toLowerCase();
      const titleB = b.title.toLowerCase();
      const startA = titleA.startsWith(searchTerm) || (a.model && a.model.toLowerCase().startsWith(searchTerm)) ? 0 : 1;
      const startB = titleB.startsWith(searchTerm) || (b.model && b.model.toLowerCase().startsWith(searchTerm)) ? 0 : 1;
      return startA - startB;
    });

    // 🔹 إزالة النتائج المكررة حسب العنوان والموديل
    const uniqueResultsMap = new Map();
    for (const item of filteredResults) {
      const key = `${item.title.toLowerCase().trim()}|${(item.model || "").toLowerCase().trim()}`;
      if (!uniqueResultsMap.has(key)) uniqueResultsMap.set(key, item);
    }
    const uniqueResults = Array.from(uniqueResultsMap.values());

    // ✅ إرسال النتائج النهائية
    if (uniqueResults.length > 0) {
      res.status(200).json({ mode: "list", results: uniqueResults });
      return;
    }

    res.status(404).json({
      error: "❌ لم يتم العثور على أي نتائج لهذا الاسم في الموقع.",
    });
  } catch (err) {
    console.error("⚠️ خطأ أثناء الجلب:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب البيانات." });
  }
}
