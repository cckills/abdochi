import * as cheerio from "cheerio";

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "يرجى إدخال رابط الهاتف." });

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept-Language": "ar,en;q=0.9",
      },
    });

    if (!response.ok)
      return res.status(404).json({ error: "❌ الرابط غير صالح أو لا يعمل." });

    const html = await response.text();
    const $ = cheerio.load(html);

    const title = $("h1.entry-title").text().trim() || "غير محدد";
    const img =
      $(".entry-content img").first().attr("src") ||
      $(".post-thumbnail img").attr("src") ||
      "";

    const specs = {};

    // 🟢 جلب المواصفات من الجداول
    $("table tr").each((_, tr) => {
      const key = $(tr).find("td:first-child").text().trim();
      const val = $(tr).find("td:last-child").text().trim();
      if (key && val) specs[key] = val;
    });

    // 🟢 جلب المواصفات من القوائم (ul/li)
    $("li.list-group-item").each((_, li) => {
      const key = $(li).find("strong").text().trim();
      const val = $(li).find("span").text().trim();
      if (key && val && !specs[key]) specs[key] = val;
    });

    // 🟢 دمج تفاصيل الشاشة (نوع + حجم + دقة + معدل التحديث إن وجد)
    if (
      specs["نوع الشاشة"] ||
      specs["حجم الشاشة"] ||
      specs["دقة الشاشة"] ||
      specs["معدل التحديث"]
    ) {
      const type = specs["نوع الشاشة"] ? specs["نوع الشاشة"].trim() : "";
      const size = specs["حجم الشاشة"] ? specs["حجم الشاشة"].trim() : "";
      const resolution = specs["دقة الشاشة"] ? specs["دقة الشاشة"].trim() : "";
      const refresh = specs["معدل التحديث"] ? specs["معدل التحديث"].trim() : "";

      // 🧩 إنشاء نص منسق
      let screenText = `${type}${type && size ? " بحجم " : ""}${size}${(type || size) && resolution ? " بدقة " : ""}${resolution}`;
      if (refresh) screenText += ` بمعدل ${refresh}`;

      specs["الشاشة"] = screenText.trim();
    }

    // 🔹 إعادة البيانات للواجهة
    res.status(200).json({
      title,
      img,
      specs,
      source: url,
    });
  } catch (err) {
    console.error("⚠️ خطأ أثناء جلب التفاصيل:", err);
    res.status(500).json({ error: "حدث خطأ أثناء جلب بيانات الهاتف." });
  }
}
