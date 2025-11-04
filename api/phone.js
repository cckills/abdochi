// phone.js
import * as cheerio from "cheerio";

/**
 * Phone scraper for telfonak.com
 * - Extracts brand links automatically (fallback to a default list if none found)
 * - For each brand: fetches all pages (until no new results)
 * - Then fetches details for each phone (prices, chipset, model)
 * - Supports: /api/phone  => fetch all brands
 *             /api/phone?phone=samsung => fetch only that search
 *
 * Notes:
 * - CONCURRENCY_LIMIT and DELAY_BETWEEN_BATCHES can be tuned for faster/slower runs.
 * - Results are cached in-memory for CACHE_TTL milliseconds.
 */

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 40; // طلبات متوازية (زدّه بحذر)
const DELAY_BETWEEN_BATCHES = 80; // مللي ثانية
const baseUrl = "https://telfonak.com";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==== مساعدة: استخراج الماركات من الصفحة الرئيسية ==== */
async function extractBrandsFromHome() {
  try {
    const res = await fetch(baseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const candidates = new Map();

    // بحث في روابط القائمة أو sidebar أو أي رابط يحتوي دلائل ماركات
    $("a").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      const text = ($(el).text() || "").trim();
      if (!href) return;

      // نماذج دلائل قد تشير لصفحات ماركات/تصنيفات
      const patterns = ["/brand", "/brands", "/category", "/tag", "/tag/", "/category/"];
      const low = href.toLowerCase();

      // تأكد أن الرابط داخلي لموقع telfonak
      try {
        const u = new URL(href, baseUrl);
        if (u.hostname !== new URL(baseUrl).hostname) return;
      } catch {
        return;
      }

      // قبول الرابط إن تحمّل أحد الأنماط أو النص قصير (اسم ماركة غالبًا قصير)
      if (patterns.some(p => low.includes(p)) || (text && text.length < 30 && text.length > 1)) {
        const key = href;
        candidates.set(key, text || href);
      }
    });

    const brands = Array.from(candidates.entries()).map(([href, text]) => {
      // نريد تسمية قصيرة للاستخدام كـ query (نستخدم النص الموجود أو جزء من المسار)
      let label = text;
      if (!label) {
        try {
          const u = new URL(href, baseUrl);
          const parts = u.pathname.split("/").filter(Boolean);
          label = parts[parts.length - 1] || href;
        } catch {
          label = href;
        }
      }
      return { label: label.trim(), href: new URL(href, baseUrl).toString() };
    });

    // إرجاع قائمة موحدة (قد تكون فارغة)
    return brands;
  } catch (err) {
    console.warn("extractBrandsFromHome error:", err);
    return [];
  }
}

/* ==== مساعدة: جلب كل روابط الهواتف لبحث معين (كلمة بحث أو صفحة ماركة) ==== */
async function fetchAllPhoneLinksForSearch(queryOrUrl, isFullUrl = false) {
  // إذا isFullUrl = true، سنستخدم queryOrUrl كما هو (رابط صفحة ماركة أو رابط بحث كامل)
  // وإلا نعتبره نص بحث ونستخدم baseUrl/?s=...
  const firstUrl = isFullUrl ? queryOrUrl : `${baseUrl}/?s=${encodeURIComponent(queryOrUrl)}`;

  // جلب أول صفحة لمعرفة عدد الصفحات أو لاكتشاف بنية الموقع
  try {
    const firstRes = await fetch(firstUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!firstRes.ok) {
      console.warn("fetchAllPhoneLinksForSearch: first page failed", firstUrl);
      return [];
    }
    const firstHtml = await firstRes.text();
    const $ = cheerio.load(firstHtml);

    // حدد عدد الصفحات إن وُجد (الطريق القياسي)
    const pagination = $(".page-numbers, .nav-links a.page-numbers")
      .map((_, el) => parseInt($(el).text().trim()))
      .get()
      .filter(n => !isNaN(n));
    const totalPages = pagination.length ? Math.max(...pagination) : 1;

    // جهّز روابط الصفحات تبعًا لبنية الرابط
    const pageUrls = [];
    for (let i = 1; i <= totalPages; i++) {
      if (i === 1) pageUrls.push(firstUrl);
      else {
        // حاول بناء الرابط وفق شكل شائع: /page/{i}/?s=...
        // إذا كان firstUrl يحتوي على ?s=... نُدخل /page/N/ قبل الاستعلام، وإلا نحاول إضافة /page/N/
        try {
          const u = new URL(firstUrl);
          if (u.search) {
            // example: https://telfonak.com/?s=samsung  -> https://telfonak.com/page/2/?s=samsung
            const basePath = `${u.origin}/`;
            pageUrls.push(`${basePath}page/${i}/${u.search}`);
          } else {
            // example: https://telfonak.com/brand/x -> https://telfonak.com/brand/x/page/2/
            const basePath = firstUrl.endsWith("/") ? firstUrl : firstUrl + "/";
            pageUrls.push(`${basePath}page/${i}/`);
          }
        } catch {
          // fallback بسيط
          pageUrls.push(`${firstUrl}/page/${i}/`);
        }
      }
    }

    // في بعض الأحيان لا يوجد ترقيم لكن توجد صفحات "التالي" — سنجلب على أي حال الصفحة الأولى ثم نحاول الزيادة حتى نصل لصفحة بلا نتائج
    // لذا سنجلب كل pageUrls ثم سنقوم بمسح أي صفحات إضافية لاحقًا إن احتجنا

    // جلب الصفحات بالتوازي على دفعات
    const results = [];
    for (let i = 0; i < pageUrls.length; i += CONCURRENCY_LIMIT) {
      const chunk = pageUrls.slice(i, i + CONCURRENCY_LIMIT);
      const settled = await Promise.allSettled(
        chunk.map(async (url) => {
          try {
            const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!r.ok) return [];
            const html = await r.text();
            const $p = cheerio.load(html);
            const phones = [];
            $p(".media, .post, article").each((_, el) => {
              const link = $p(el).find("a.image-link").attr("href") || $p(el).find("a").attr("href");
              const title = $p(el).find("a.image-link").attr("title") || $p(el).find("a").text().trim();
              const img = $p(el).find("span.img").attr("data-bgsrc") || $p(el).find("img").attr("src") || "";
              if (link && title) phones.push({ title: title.trim(), link: link.trim(), img: img.trim() });
            });
            return phones;
          } catch (err) {
            console.warn("fetch page error", url, err);
            return [];
          }
        })
      );

      for (const s of settled) {
        if (s.status === "fulfilled" && Array.isArray(s.value)) results.push(...s.value);
      }

      await delay(DELAY_BETWEEN_BATCHES);
    }

    // نظف نتائج مكررة
    const unique = Array.from(new Map(results.map(p => [p.link, p])).values());
    return unique;
  } catch (err) {
    console.warn("fetchAllPhoneLinksForSearch error", err);
    return [];
  }
}

/* ==== مساعدة: جلب تفاصيل هاتف مفرد ==== */
async function fetchPhoneDetails(item) {
  try {
    if (!item || !item.link) return null;
    const res = await fetch(item.link, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    // الأسعار
    const prices = [];
    $(".bs-shortcode-list li, .telfon-price tr").each((_, el) => {
      const country = $(el).find("strong").text().trim() || $(el).find("td:first-child").text().trim();
      const price = $(el).find("span").text().trim() || $(el).find("td:last-child").text().trim();
      if (country && price) prices.push({ country, price });
    });

    // المعالج
    let fullChipset = $("tr:contains('المعالج') td.aps-attr-value span").text().trim() ||
      $("tr:contains('المعالج') td.aps-attr-value").text().trim() || "";
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

    // الموديل/الإصدار
    const modelRow =
      $("tr:contains('الموديل / الطراز') td.aps-attr-value span").text().trim() ||
      $("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
      $("tr:contains('الموديل') td.aps-attr-value").text().trim() ||
      "";
    const modelArray = modelRow ? modelRow.split(",").map(m => m.trim()) : [];

    return {
      title: item.title,
      link: item.link,
      img: item.img || "",
      chipset: shortChipset || "غير محدد",
      model: modelArray.join(", "),
      modelArray,
      prices,
      source: "telfonak.com"
    };
  } catch (err) {
    console.warn("fetchPhoneDetails error", item && item.link, err);
    return null;
  }
}

/* ==== الدالة الأساسية للـ API ==== */
export default async function handler(req, res) {
  const { phone, refresh } = req.query;
  const searchKey = phone ? phone.toLowerCase().trim() : null;
  const cacheKey = searchKey || "__ALL_BRANDS__";

  // إعادة استخدام الكاش إن متاح (إلا إذا طلب refresh=true)
  if (!refresh) {
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log("⚡ استخدام الكاش:", cacheKey);
      return res.status(200).json({ cached: true, total: cached.data.length, results: cached.data });
    }
  }

  const startTime = Date.now();

  try {
    // 1) تحديد قائمة الماركات (أو استخدام استعلام واحد)
    let brandQueries = [];

    if (searchKey) {
      brandQueries = [searchKey];
      console.log(`🔎 وضع بحث منفرد عن: ${searchKey}`);
    } else {
      console.log("🔍 استخراج الماركات من الصفحة الرئيسية...");
      const extracted = await extractBrandsFromHome();
      if (extracted && extracted.length > 0) {
        // استخدام نصوص الماركات المستخرجة كاستعلامات بحث
        brandQueries = extracted.map(b => b.label).filter(Boolean);
        console.log(`✅ تم استخراج ${brandQueries.length} ماركات من الموقع.`);
      } else {
        // fallback: قائمة إفتراضية شاملة
        brandQueries = [
          "samsung","apple","xiaomi","oppo","huawei","realme","infinix",
          "vivo","honor","tecno","nokia","oneplus","google","lenovo","sony"
        ];
        console.log(`⚙️ لم يُعثر على ماركات في الصفحة — استخدام القائمة الاحتياطية (${brandQueries.length})`);
      }
    }

    // 2) لكل ماركة: جلب كل روابط الهواتف (كل الصفحات)
    let aggregatedLinks = [];
    let brandIndex = 0;

    for (const q of brandQueries) {
      brandIndex++;
      console.log(`\n➡️ معالجة ماركة ${brandIndex}/${brandQueries.length}: "${q}"`);
      const links = await fetchAllPhoneLinksForSearch(q, false);
      console.log(`   → تم جمع ${links.length} روابط لهواتف الماركة "${q}"`);
      aggregatedLinks.push(...links);

      // طباعة تقدّم مبدئي
      const overallProgress = Math.round((brandIndex / brandQueries.length) * 100);
      console.log(`📊 تقدم جمع الروابط: ${overallProgress}%`);
      await delay(120);
    }

    // 3) إزالة التكرارات حسب الرابط
    const uniqueByLink = Array.from(new Map(aggregatedLinks.map(p => [p.link, p])).values());
    console.log(`\n🧩 روابط فريدة بعد الدمج: ${uniqueByLink.length}`);

    // 4) جلب التفاصيل لكل رابط (بتقسيم إلى دفعات متوازية)
    const details = [];
    let processed = 0;
    for (let i = 0; i < uniqueByLink.length; i += CONCURRENCY_LIMIT) {
      const batch = uniqueByLink.slice(i, i + CONCURRENCY_LIMIT);
      const settled = await Promise.allSettled(batch.map(item => fetchPhoneDetails(item)));
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) details.push(s.value);
      }
      processed += batch.length;
      const percent = Math.round((processed / uniqueByLink.length) * 100);
      console.log(`⚙️ تقدم جلب التفاصيل: ${percent}% (${processed}/${uniqueByLink.length})`);
      await delay(DELAY_BETWEEN_BATCHES);
    }

    // 5) حفظ في الكاش
    cache.set(cacheKey, { data: details, timestamp: Date.now() });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ انتهى: ${details.length} أجهزة جُمعت في ${timeTaken} ثانية`);

    return res.status(200).json({ total: details.length, timeTaken, results: details, cached: false });
  } catch (err) {
    console.error("❌ خطأ عام في handler:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب بيانات الموقع." });
  }
}
