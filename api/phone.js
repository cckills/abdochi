// phone.js
import * as cheerio from "cheerio";

/**
 * phone.js
 * - يجلب كل الماركات من telfonak.com (أوتوماتيكياً)
 * - لكل ماركة: يجلب كل الصفحات المتاحة حتى لا توجد نتائج جديدة
 * - لكل رابط هاتف: يجلب التفاصيل (المعالج + الموديل + الأسعار)
 * - يدعم /api/phone  -> جلب كل الماركات بالكامل (الأول تشغيل غالباً يستغرق بعض الوقت)
 * - يدعم /api/phone?phone=samsung  -> جلب فقط نتائج البحث للعلامة / الكلمة
 * - يستخدم كاش in-memory لمدة ساعة لتسريع الطلبات اللاحقة
 * - مُحسَّن للتوازي (CONCURRENCY_LIMIT) مع delays بين الدفعات لتقليل خطر الحظر
 */

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // ساعة
const CONCURRENCY_LIMIT = 40; // عدد الطلبات المتوازية — عدل إذا لاحظت حظر أو أداء سيئ
const DELAY_BETWEEN_BATCHES = 80; // مللي ثانية
const baseUrl = "https://telfonak.com";
const MAX_PAGES_PER_QUERY = 1000; // حارس ضد الحلقات اللا نهائية

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------- مساعدات استخراج ------------------- */

/**
 * حاول استخراج روابط صفحات الماركات / تسميات من الصفحة الرئيسية
 * يعيد مصفوفة من سلاسل (روابط أو أسماء للبحث)
 */
async function extractBrandQueries() {
  try {
    const res = await fetch(baseUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.warn("extractBrandQueries: failed fetching homepage", res.status);
      return [];
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    const candidates = new Map();

    // 1) استخدم عناصر قائمة / sidebar المحتملة
    $("a").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      const text = ($(el).text() || "").trim();
      if (!href && !text) return;

      // تجاهل روابط خارجية معروفة
      try {
        const u = new URL(href, baseUrl);
        if (u.hostname && u.hostname !== new URL(baseUrl).hostname) return;
      } catch (e) {
        // href ليس URL كامل — قد يكون داخلي
      }

      // إذا href يحتوي أنماط تدل على تصنيف/ماركة/وسم أو النص قصير (اسم ماركة محتمل)
      const hrefLower = href.toLowerCase();
      const textShort = text.length > 0 && text.length <= 30;
      if (
        hrefLower.includes("/brand") ||
        hrefLower.includes("/brands") ||
        hrefLower.includes("/category") ||
        hrefLower.includes("/tag/") ||
        textShort
      ) {
        // لو href يحتوي ?s= خذ قيمة البحث
        if (href.includes("?s=")) {
          try {
            const u = new URL(href, baseUrl);
            const s = u.searchParams.get("s");
            if (s) candidates.set(s.toLowerCase(), s);
            continue;
          } catch {}
        }

        // استخدم النص إن وجد وإلا استخدم slug من href
        if (textShort) candidates.set(text.toLowerCase(), text);
        else {
          try {
            const u = new URL(href, baseUrl);
            const parts = u.pathname.split("/").filter(Boolean);
            if (parts.length) {
              const slug = parts[parts.length - 1].replace(/[-_]/g, " ").trim();
              if (slug) candidates.set(slug.toLowerCase(), slug);
            }
          } catch {
            // لا شيء
          }
        }
      }
    });

    // تحويل إلى مصفوفة
    const out = Array.from(candidates.values()).map((v) => v.trim()).filter(Boolean);
    return out;
  } catch (err) {
    console.error("extractBrandQueries error:", err);
    return [];
  }
}

/**
 * جلب كل الروابط من صفحات نتائج البحث/التصنيف لكلمة بحث واحدة (query)
 * - يحاول متابعة الصفحات حتى لا توجد نتائج جديدة أو حتى حد MAX_PAGES_PER_QUERY
 * - يعيد قائمة عناصر { title, link, img }
 */
async function fetchAllPagesForQuery(query) {
  const firstUrl = query ? `${baseUrl}/?s=${encodeURIComponent(query)}` : baseUrl;
  const collected = [];
  const seenLinks = new Set();

  let page = 1;
  let consecutiveEmptyPages = 0;

  while (true) {
    if (page > MAX_PAGES_PER_QUERY) {
      console.warn(`Reached MAX_PAGES_PER_QUERY (${MAX_PAGES_PER_QUERY}) for query=${query}`);
      break;
    }

    const url = page === 1 ? firstUrl : firstUrl.replace(/\/?$/, "/") + `page/${page}/?s=${encodeURIComponent(query)}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) {
        // لو الصفحة غير موجودة، نوقف
        console.warn(`fetchAllPagesForQuery: non-ok status ${r.status} for ${url}`);
        break;
      }
      const html = await r.text();
      const $ = cheerio.load(html);

      const pageItems = [];
      $(".media, .post, article").each((_, el) => {
        const link = ($(el).find("a.image-link").attr("href") || "").trim();
        const title = ($(el).find("a.image-link").attr("title") || $(el).find("a").text() || "").trim();
        const img =
          ($(el).find("span.img").attr("data-bgsrc") || $(el).find("img").attr("src") || "").trim();
        if (link && title && !seenLinks.has(link)) {
          seenLinks.add(link);
          pageItems.push({ title, link, img });
        }
      });

      if (pageItems.length === 0) {
        consecutiveEmptyPages++;
      } else {
        consecutiveEmptyPages = 0;
      }

      // جمع الصفحة
      collected.push(...pageItems);

      // شرط توقف ذكي:
      // إذا الصفحة فارغة مرتين متتاليًا/الثانية أو الصفحة لا تحتوي روابط جديدة، توقف.
      if (consecutiveEmptyPages >= 2) {
        // عادة هذا يعني انتهت الصفحات الحقيقية
        break;
      }

      // بعض المواقع تعرض ترقيم — يمكن التحقق منه لتقصير العمل
      if (page === 1) {
        const pages = $(".page-numbers, .nav-links a.page-numbers")
          .map((_, el) => parseInt($(el).text().trim()))
          .get()
          .filter((n) => !isNaN(n));
        const totalPages = pages.length ? Math.max(...pages) : 1;
        if (totalPages && totalPages <= 1) {
          // لا صفحات إضافية على الأغلب
          if (pageItems.length === 0) break;
        } else if (totalPages && totalPages < MAX_PAGES_PER_QUERY) {
          // إذا نعرف عدد الصفحات مسبقًا، نستخدمه
          if (page >= totalPages) break;
        }
      }

      page++;
      // قدرة خفيفة لمنع الضغط الشديد
      await delay(60);
    } catch (err) {
      console.warn("fetchAllPagesForQuery error for", url, err);
      break;
    }
  }

  return collected;
}

/**
 * جلب تفاصيل هاتف واحد: المعالج + الموديل + الأسعار
 * يرجع null لو فشل
 */
async function fetchPhoneDetails(item) {
  try {
    const r = await fetch(item.link, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null;
    const html = await r.text();
    const $ = cheerio.load(html);

    // الأسعار
    const prices = [];
    $(".bs-shortcode-list li, .telfon-price tr").each((_, el) => {
      const country = ($(el).find("strong").text() || $(el).find("td:first-child").text() || "").trim();
      const price = ($(el).find("span").text() || $(el).find("td:last-child").text() || "").trim();
      if (country && price) prices.push({ country, price });
    });

    // المعالج
    let fullChipset =
      ($("tr:contains('المعالج') td.aps-attr-value span").text() ||
        $("tr:contains('المعالج') td.aps-attr-value").text() ||
        ""
      ).trim();
    fullChipset = fullChipset.replace(/\s+/g, " ").trim();

    let shortChipset = fullChipset;
    if (fullChipset) {
      const cleaned = fullChipset
        .replace(/ثماني النواة|سداسي النواة|رباعي النواة|ثنائي النواة/gi, "")
        .replace(/[\(\)\-\–\,]/g, " ")
        .replace(/\b\d+(\.\d+)?\s*GHz\b/gi, "")
        .replace(/\b\d+\s*nm\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      const match = cleaned.match(/[A-Za-z\u0600-\u06FF]+\s*[A-Za-z0-9\-]+/);
      shortChipset = match ? match[0].trim() : cleaned;
    }

    // الموديل
    const modelRow =
      ($("tr:contains('الموديل / الطراز') td.aps-attr-value span").text() ||
        $("tr:contains('الإصدار') td.aps-attr-value").text() ||
        $("tr:contains('الموديل') td.aps-attr-value").text() ||
        ""
      ).trim();
    const modelArray = modelRow ? modelRow.split(",").map((m) => m.trim()) : [];

    return {
      title: item.title,
      link: item.link,
      img: item.img || "",
      chipset: shortChipset || "غير محدد",
      model: modelArray.join(", "),
      modelArray,
      prices,
      source: "telfonak.com",
    };
  } catch (err) {
    console.warn("fetchPhoneDetails error:", item.link, err);
    return null;
  }
}

/* ------------------- دالة المعالج (API) ------------------- */

export default async function handler(req, res) {
  const { phone, refresh } = req.query;
  const searchKey = phone ? phone.toLowerCase().trim() : null;
  const cacheKey = searchKey ? `q:${searchKey}` : "ALL_BRANDS_FULL";
  const start = Date.now();

  // استخدم الكاش إذا لم يطلب التحديث
  const cached = cache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`⚡ إعادة استخدام الكاش: ${cacheKey} (${cached.data.length} items)`);
    return res.status(200).json({ cached: true, total: cached.data.length, results: cached.data });
  }

  try {
    /* ========== 1) استخراج قائمة الماركات أو استخدام استعلام واحد ========== */
    let brandQueries = [];
    if (searchKey) {
      brandQueries = [searchKey];
    } else {
      console.log("🔎 استخراج الماركات تلقائياً من الصفحة الرئيسية...");
      const extracted = await extractBrandQueries();
      if (extracted.length > 0) {
        brandQueries = extracted;
        console.log(`✅ تم استخراج ${brandQueries.length} ماركات من الصفحة الرئيسية.`);
      } else {
        // fallback: قائمة احتياطية واسعة
        brandQueries = [
          "samsung",
          "apple",
          "xiaomi",
          "oppo",
          "huawei",
          "realme",
          "infinix",
          "vivo",
          "honor",
          "tecno",
          "nokia",
          "oneplus",
          "google",
          "lenovo",
          "sony",
        ];
        console.log(`⚙️ لم يتم استخراج ماركات — استخدام القائمة الاحتياطية (${brandQueries.length})`);
      }
    }

    /* ========== 2) جلب كل الروابط لكل ماركة (كل الصفحات) ========== */
    console.log(`🚀 بدء جمع روابط الهواتف لكل الماركات (${brandQueries.length})...`);
    let aggregatedLinks = [];
    for (let i = 0; i < brandQueries.length; i++) {
      const q = brandQueries[i];
      console.log(`\n➡️ (${i + 1}/${brandQueries.length}) معالجة: "${q}"`);
      const items = await fetchAllPagesForQuery(q);
      console.log(`   → تم جمع ${items.length} روابط ل "${q}"`);
      aggregatedLinks.push(...items);
      // تأخير بسيط بين الماركات لتقليل ضغط الشبكة
      await delay(DELAY_BETWEEN_BATCHES);
    }

    /* ========== 3) إزالة التكرار بحسب الرابط ========== */
    const uniqueLinks = Array.from(new Map(aggregatedLinks.map((p) => [p.link, p])).values());
    console.log(`\n🧩 روابط فريدة بعد الدمج: ${uniqueLinks.length}`);

    /* ========== 4) جلب التفاصيل لكل رابط بتقسيم إلى دفعات متوازية ========== */
    console.log(`⚙️ بدء جلب التفاصيل لكل رابط (تفاصيل: المعالج، الموديل، الأسعار)...`);
    const details = [];
    // إن كانت القائمة فارغة، نرجع سريعاً
    if (uniqueLinks.length === 0) {
      cache.set(cacheKey, { data: [], timestamp: Date.now() });
      return res.status(200).json({ total: 0, timeTaken: 0, results: [] });
    }

    // تقسيم إلى دفعات
    for (let i = 0; i < uniqueLinks.length; i += CONCURRENCY_LIMIT) {
      const batch = uniqueLinks.slice(i, i + CONCURRENCY_LIMIT);
      // جلب كل الدفعة متوازياً
      const settled = await Promise.allSettled(batch.map((it) => fetchPhoneDetails(it)));

      // اجمع النتائج الصحيحة
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) details.push(s.value);
      }

      const processed = Math.min(i + CONCURRENCY_LIMIT, uniqueLinks.length);
      const percent = Math.round((processed / uniqueLinks.length) * 100);
      console.log(`🔁 تمت معالجة ${processed}/${uniqueLinks.length} — ${percent}%`);
      await delay(DELAY_BETWEEN_BATCHES);
    }

    /* ========== 5) تخزين في الكاش وإرجاع الاستجابة ========== */
    cache.set(cacheKey, { data: details, timestamp: Date.now() });
    const timeTaken = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`✅ انتهى: جلب ${details.length} عناصر في ${timeTaken} ثانية — cacheKey=${cacheKey}`);

    return res.status(200).json({
      total: details.length,
      timeTaken,
      results: details,
      cached: false,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "حدث خطأ أثناء جلب البيانات." });
  }
}
