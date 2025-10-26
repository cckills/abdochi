import * as cheerio from "cheerio";

export default async function handler(req, res) {
  const { phone, page = 1, limit = 20 } = req.query; // ✅ نضيف دعم page و limit من الاستعلام
  if (!phone)
    return res.status(400).json({ error: "يرجى إدخال اسم الهاتف أو الموديل." });

  try {
    const results = [];
    let pageNum = 1;
    let hasNext = true;
    let processedPages = 0;

    while (hasNext) {
      const searchUrl =
        pageNum === 1
          ? `https://telfonak.com/?s=${encodeURIComponent(phone)}`
          : `https://telfonak.com/page/${pageNum}/?s=${encodeURIComponent(phone)}`;

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

              const modelRow =
                $$("tr:contains('الموديل / الطراز') td.aps-attr-value span").text().trim() ||
                $$("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
                $$("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
                "";

              const modelArray = modelRow ? modelRow.split(",").map(m => m.trim()) : [];

              results.push({
                title,
                link,
                img,
                chipset: shortChipset || "غير محدد",
                model: modelArray.join(", "),
                modelArray,
                source: "telfonak.com",
              });
            }
          } catch (err) {
            console.error("⚠️ خطأ أثناء جلب صفحة الهاتف:", err.message);
          }
        }
      }

      hasNext = $(".pagination .next, .nav-links .next, a.next, .page-numbers .next").length > 0;
      processedPages++;
      pageNum++;
    }

    const searchTerm = phone.toLowerCase();

    let filteredResults = results.filter(item =>
      item.title.toLowerCase().includes(searchTerm) ||
      item.modelArray.some(m => m.toLowerCase() === searchTerm)
    );

    filteredResults.sort((a, b) => {
      const titleA = a.title.toLowerCase();
      const titleB = b.title.toLowerCase();
      const startA = titleA.startsWith(searchTerm) || a.modelArray.some(m => m.toLowerCase().startsWith(searchTerm)) ? 0 : 1;
      const startB = titleB.startsWith(searchTerm) || b.modelArray.some(m => m.toLowerCase().startsWith(searchTerm)) ? 0 : 1;
      return startA - startB;
    });

    const uniqueResultsMap = new Map();
    for (const item of filteredResults) {
      const key = `${item.title.toLowerCase().trim()}|${item.model.toLowerCase().trim()}`;
      if (!uniqueResultsMap.has(key)) uniqueResultsMap.set(key, item);
    }
    const uniqueResults = Array.from(uniqueResultsMap.values());

    // ✅ نظام الصفحات الجديد (بدون حذف شيء)
    const total = uniqueResults.length;
    const perPage = parseInt(limit);
    const totalPages = Math.ceil(total / perPage);
    const currentPage = Math.max(1, Math.min(parseInt(page), totalPages));

    const startIndex = (currentPage - 1) * perPage;
    const paginatedResults = uniqueResults.slice(startIndex, startIndex + perPage);

    if (paginatedResults.length > 0) {
      res.status(200).json({
        mode: "list",
        results: paginatedResults,
        total,
        totalPages,
        currentPage,
        pages: processedPages
      });
      return;
    }

    res.status(404).json({
      error: "❌ لم يتم العثور على أي نتائج لهذا الاسم أو الموديل في الموقع.",
    });

  } catch (err) {
    console.error("⚠️ خطأ أثناء الجلب:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب البيانات." });
  }
}
