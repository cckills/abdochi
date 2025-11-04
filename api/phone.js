// phone.js
import * as cheerio from "cheerio";

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة واحدة
const CONCURRENCY_LIMIT = 12; // عدد الطلبات المتوازية — قلل إذا واجهت حظر
const baseUrl = "https://telfonak.com";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * مساعدة: استخراج روابط/نصوص الماركات من الصفحة الأولى
 * نحاول البحث في عدة مناطق محتملة لتغطية أكثر مواقع WordPress شيوعاً
 */
async function fetchBrandCandidates() {
  try {
    const res = await fetch(baseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);

    const anchors = $("a")
      .map((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        return { href, text };
      })
      .get();

    // علامات مميزة في href تشير إلى صفحة ماركة/وسم/تصنيف
    const brandHrefPatterns = ["/brand", "/brands", "/tag/", "/category/", "/categories/", "?s="];

    // عناصر محتملة تحتوي أسماء الماركات (widgets, list, sidebar)
    const containerSelectors = [
      ".widget--brands",
      ".widget_brands",
      ".widget_tag_cloud",
      ".widget_categories",
      ".widget_pages",
      ".tags-list",
      ".brands-list",
      ".product-brands",
      ".widget",
      ".sidebar"
    ];

    const candidates = new Map();

    // أولًا: استخرج من الحاويات المعروفة (لو وُجدت)
    for (const sel of containerSelectors) {
      $(sel).find("a").each((_, a) => {
        const href = $(a).attr("href") || "";
        const text = $(a).text().trim();
        if (text && href) {
          candidates.set(href, text);
        }
      });
    }

    // ثانياً: استخرج أي رابط يبدو كماركة اعتماداً على النمط في href أو نص قصير
    for (const { href, text } of anchors) {
      if (!href || !text) continue;
      const hrefLower = href.toLowerCase();
      const textShort = text.length <= 40; // أسماء الماركات عادة قصيرة
      if (brandHrefPatterns.some(p => hrefLower.includes(p)) || textShort) {
        // تجاهل روابط خارجية واضحة (غير الموقع أو روابط شبكات اجتماعية)
        try {
          const url = new URL(href, baseUrl);
          if (url.hostname && url.hostname !== new URL(baseUrl).hostname) continue;
        } catch { /* تجاهل if invalid */ }

        // استخدم href كسطر مميز، مع اسم واضح إن وُجد
        candidates.set(href, text);
      }
    }

    // حوّل النتائج إلى مصفوفة من سلاگز/إستعلامات بحث (نريد نص الماركة أو الجزء المفيد من href)
    const brandList = [];
    for (const [href, text] of candidates.entries()) {
      // إذا href يحتوي استعلام بحث ?s=... استخرج القيمة
      if (href.includes("?s=")) {
        try {
          const u = new URL(href, baseUrl);
          const s = u.searchParams.get("s");
          if (s) {
            brandList.push({ label: decodeURIComponent(s).trim(), href: u.toString() });
            continue;
          }
        } catch {}
      }

      // حاول استخراج slug من href كجزء بعد آخر '/'
      try {
        const u = new URL(href, baseUrl);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length) {
          const slug = parts[parts.length - 1].replace(/[-_]/g, " ").trim();
          brandList.push({ label: text || slug, href: u.toString() });
          continue;
        }
      } catch {
        // لو href ليس رابط كامل، خذ النص
        brandList.push({ label: text, href });
      }
    }

    // تنظيف وتوحيد الأسماء (حذف تكرارات)
    const unique = [];
    const seen = new Set();
    for (const b of brandList) {
      const key = (b.label || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (!key) continue;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ label: b.label.trim(), href: b.href });
      }
    }

    return unique;
  } catch (err) {
    console.error("❌ fetchBrandCandidates error:", err);
    return [];
  }
}

/**
 * جلب روابط نتائج البحث/التصنيف لكل كلمة بحث (ماركة أو استعلام)
 * يعيد قائمة روابط الهواتف (title, link, img)
 */
async function fetchAllPagesForQuery(query) {
  const firstUrl = query ? `${baseUrl}/?s=${encodeURIComponent(query)}` : baseUrl;

  // جلب أول صفحة لمعرفة ترقيم الصفحات
  const firstRes = await fetch(firstUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!firstRes.ok) {
    console.warn("فشل تحميل:", firstUrl);
    return [];
  }
  const firstHtml = await firstRes.text();
  const $ = cheerio.load(firstHtml);

  const pagination = $(".page-numbers, .nav-links a.page-numbers")
    .map((_, el) => parseInt($(el).text().trim()))
    .get()
    .filter(n => !isNaN(n));
  const totalPages = pagination.length ? Math.max(...pagination) : 1;

  const pageUrls = Array.from({ length: totalPages }, (_, i) =>
    i === 0 ? firstUrl : `${baseUrl}/page/${i + 1}/?s=${encodeURIComponent(query)}`
  );

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
            const link = $p(el).find("a.image-link").attr("href");
            const title = $p(el).find("a.image-link").attr("title") || $p(el).find("a").text().trim();
            const img =
              $p(el).find("span.img").attr("data-bgsrc") ||
              $p(el).find("img").attr("src") ||
              "";
            if (link && title) phones.push({ title: title.trim(), link: link.trim(), img: img.trim() });
          });
          console.log(`📃 [${query||"index"}] صفحة ${url} ➜ ${phones.length}`);
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

    await delay(250);
  }

  // إزالة التكرارات حسب الرابط
  const unique = Array.from(new Map(results.map(p => [p.link, p])).values());
  return unique;
}

/**
 * جلب تفاصيل صفحة هاتف مفردة (المعالج، الموديل، الأسعار)
 */
async function fetchPhoneDetails(item) {
  try {
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

    // الموديل
    const modelRow =
      $("tr:contains('الموديل / الطراز') td.aps-attr-value span").text().trim() ||
      $("tr:contains('الإصدار') td.aps-attr-value").text().trim() ||
      $("tr:contains('الموديل') td.aps-attr-value").text().trim() || "";
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
    console.warn("fetchPhoneDetails error", item.link, err);
    return null;
  }
}

/**
 * الدالة الأساسية للـ API
 */
export default async function handler(req, res) {
  const { phone, refresh } = req.query;
  const searchKey = (phone || "").toLowerCase().trim();

  // استخدم مفتاح كاش موحد: إذا طلبنا كل الهواتف نستخدم "__ALL__" وإلا نستخدم searchKey
  const cacheKey = searchKey || "__ALL__BRANDS__";
  const cached = cache.get(cacheKey);
  if (!refresh && cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log("⚡ إعادة استخدام الكاش:", cacheKey);
    return res.status(200).json({ cached: true, total: cached.data.length, results: cached.data });
  }

  const startTime = Date.now();
  try {
    // 1) إذا نريد تجميع كل الموقع: استخراج الماركات أولاً
    let brandQueries = [];
    if (!searchKey) {
      console.log("🔎 استخراج الماركات تلقائياً من الصفحة الرئيسية...");
      const brands = await fetchBrandCandidates();
      // إذا لم نجد شيء، نستخدم مجموعة افتراضية بسيطة كاحتياط
      if (!brands || brands.length === 0) {
        brandQueries = ["samsung", "apple", "xiaomi", "oppo", "huawei", "realme", "vivo", "honor", "infinix"];
      } else {
        // استخدم النص كاستعلام؛ نحتفظ بعدد محدود (لكن عادة القائمة ستكون مناسبة)
        brandQueries = brands.map(b => b.label).filter(Boolean);
      }
      console.log(`✅ عدد الماركات المستخرجة/المستخدمة: ${brandQueries.length}`);
    } else {
      // لو يوجد searchKey نبحث عن تلك الكلمة فقط (لكن عبر كل صفحات نتائج البحث)
      brandQueries = [searchKey];
    }

    // 2) لكل ماركة -> جلب كل صفحات النتائج وجمع روابط الهواتف
    let aggregatedLinks = [];
    for (const q of brandQueries) {
      console.log(`➡️ معالجة ماركة/استعلام: "${q}"`);
      const links = await fetchAllPagesForQuery(q);
      console.log(`   → ${links.length} روابط تم جمعها لـ "${q}"`);
      aggregatedLinks.push(...links);
      // تأخير خفيف بين ماركة وأخرى لتقليل الضغط
      await delay(300);
    }

    // 3) تجميع وإزالة التكرار حسب الرابط
    const uniqueByLink = Array.from(new Map(aggregatedLinks.map(p => [p.link, p])).values());
    console.log(`🧩 روابط فريدة بعد الدمج: ${uniqueByLink.length}`);

    // 4) جلب التفاصيل لكل رابط (بتقسيم إلى دفعات)
    const details = [];
    for (let i = 0; i < uniqueByLink.length; i += CONCURRENCY_LIMIT) {
      const batch = uniqueByLink.slice(i, i + CONCURRENCY_LIMIT);
      const settled = await Promise.allSettled(batch.map(item => fetchPhoneDetails(item)));
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) details.push(s.value);
      }
      console.log(`🔁 تم جلب تفاصيل ${Math.min(i + CONCURRENCY_LIMIT, uniqueByLink.length)} / ${uniqueByLink.length}`);
      await delay(350);
    }

    // 5) حفظ في الكاش
    cache.set(cacheKey, { data: details, timestamp: Date.now() });

    const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ انتهى التجميع: ${details.length} أجهزة تم جلبها في ${timeTaken} ثانية`);

    return res.status(200).json({ total: details.length, timeTaken, results: details, cached: false });
  } catch (err) {
    console.error("❌ خطأ عام في handler:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب بيانات الموقع." });
  }
}
