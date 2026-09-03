// -*- coding: utf-8 -*-
// app.js — محرك PDF → Excel: استخراج نص عادي + كشف تلقائي للترميز المكسور + OCR عربي/إنجليزي عند الحاجة

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const MIN_TEXT_LEN_FOR_TEXT_PAGE = 15;
const ROW_CLUSTER_TOLERANCE = 4;
const COLUMN_GAP_MULTIPLIER = 2.2;
const MAX_COL_WIDTH = 60;
const MIN_COL_WIDTH = 8;

let selectedFiles = [];
let ocrWorker = null;

const fileInput = document.getElementById("fileInput");
const pickBtn = document.getElementById("pickBtn");
const convertBtn = document.getElementById("convertBtn");
const fileList = document.getElementById("fileList");
const progressWrap = document.getElementById("progressWrap");
const progressFill = document.getElementById("progressFill");
const statusText = document.getElementById("statusText");
const ocrToggle = document.getElementById("ocrToggle");

pickBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  selectedFiles = Array.from(fileInput.files);
  if (selectedFiles.length) {
    fileList.textContent = "تم اختيار: " + selectedFiles.map(f => f.name).join("، ");
    convertBtn.disabled = false;
  } else {
    fileList.textContent = "";
    convertBtn.disabled = true;
  }
});

convertBtn.addEventListener("click", async () => {
  convertBtn.disabled = true;
  pickBtn.disabled = true;
  progressWrap.style.display = "block";

  try {
    for (const file of selectedFiles) {
      await convertOneFile(file);
    }
    setStatus(100, "تم التحويل بنجاح ✅ الملفات اتحملت في مجلد التنزيلات");
  } catch (err) {
    console.error(err);
    setStatus(0, "حصل خطأ: " + (err?.message || err));
  } finally {
    if (ocrWorker) {
      await ocrWorker.terminate();
      ocrWorker = null;
    }
    convertBtn.disabled = false;
    pickBtn.disabled = false;
  }
});

function setStatus(pct, text) {
  progressFill.style.width = pct + "%";
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// كشف اتجاه الصفحة/النص
// ---------------------------------------------------------------------------
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_GLOBAL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

// الحروف التالية تظهر كثيرًا عندما يكون Arabic font في الـPDF بدون ToUnicode.
// لا نعتمد عليها وحدها؛ نستخدمها مع كثافة النص وحجم النص لتقليل OCR الكاذب.
const SUSPICIOUS_ENCODING_RE = /[\u0370-\u03FF\u1F00-\u1FFF\u2C80-\u2CFF\u2200-\u22FF\uFFFD]/g;

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function isRtlText(text) {
  const arabic = countMatches(text, ARABIC_GLOBAL_RE);
  const latin = countMatches(text, /[A-Za-z]/g);
  return arabic >= 2 && arabic >= latin * 0.25;
}

// ---------------------------------------------------------------------------
// اكتشاف النص العربي المكسور.
// مثال الملف الحالي: النص الحقيقي عربي بصريًا، لكن pdf.js يرجع رموزًا مثل ϝϳ...
// لا نحاول "فك" الرموز؛ لأنها Glyph IDs وليست حروفًا عربية مشوهة.
// الحل الصحيح هو إعادة قراءة الصفحة كصورة باستخدام OCR.
// ---------------------------------------------------------------------------
function looksLikeBrokenArabicEncoding(text) {
  if (!text || text.length < 20) return false;

  const meaningfulLen = text.replace(/\s/g, "").length;
  if (meaningfulLen < 15) return false;

  const suspicious = countMatches(text, SUSPICIOUS_ENCODING_RE);
  const arabic = countMatches(text, ARABIC_GLOBAL_RE);
  const replacement = countMatches(text, /�/g);

  if (replacement >= 1) return true;

  const suspiciousRatio = suspicious / meaningfulLen;

  // حالة شائعة جدًا في ملفات Reporting Services:
  // رموز Greek/Coptic كثيرة + لا يوجد عربي حقيقي.
  if (suspicious >= 6 && arabic === 0 && suspiciousRatio >= 0.08) {
    return true;
  }

  // لو جزء صغير من الصفحة فقط مكسور، نلتقطه أيضًا.
  if (suspicious >= 10 && arabic <= 2 && suspiciousRatio >= 0.06) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// تجميع العناصر في صفوف وأعمدة.
// rtl=true يجعل ترتيب الأعمدة من اليمين لليسار، وهو الأنسب للصفحات العربية.
// ---------------------------------------------------------------------------
function clusterRows(items, rtl = false) {
  if (!items.length) return [];

  const sorted = [...items].sort((a, b) => a.top - b.top);
  const rows = [];
  let current = [sorted[0]];
  let currentTop = sorted[0].top;

  for (let i = 1; i < sorted.length; i++) {
    const it = sorted[i];

    if (Math.abs(it.top - currentTop) <= ROW_CLUSTER_TOLERANCE) {
      current.push(it);
    } else {
      rows.push(current);
      current = [it];
      currentTop = it.top;
    }
  }

  rows.push(current);

  rows.forEach(r => {
    r.sort((a, b) => rtl ? b.x0 - a.x0 : a.x0 - b.x0);
  });

  return rows;
}

function medianHeight(rows) {
  const heights = [];

  rows.forEach(r => r.forEach(w => {
    if (w.height > 0) heights.push(w.height);
  }));

  if (!heights.length) return 12;

  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

function itemsToTable(items, rtl = false) {
  const rows = clusterRows(items, rtl);
  if (!rows.length) return [];

  const gapThreshold = medianHeight(rows) * COLUMN_GAP_MULTIPLIER;
  const table = [];

  for (const row of rows) {
    if (!row.length) continue;

    const cells = [];
    let currentWords = [row[0].text];
    let lastX1 = row[0].x1;

    for (let i = 1; i < row.length; i++) {
      const w = row[i];

      // المسافة بين الكلمات في الاتجاه المرئي.
      const gap = rtl ? lastX1 - w.x1 : w.x0 - lastX1;

      if (gap > gapThreshold) {
        cells.push(currentWords.join(" "));
        currentWords = [w.text];
      } else {
        currentWords.push(w.text);
      }

      // نحتفظ بالحد الخارجي الصحيح للعنصر التالي.
      lastX1 = rtl ? w.x0 : w.x1;
    }

    cells.push(currentWords.join(" "));
    table.push(cells);
  }

  return table;
}

// ---------------------------------------------------------------------------
// استخراج الصفحة كنص عن طريق pdf.js
// ---------------------------------------------------------------------------
async function extractTextPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items = [];
  let rawText = "";

  for (const it of content.items) {
    const str = (it.str || "").trim();
    if (!str) continue;

    rawText += str + " ";

    const tx = pdfjsLib.Util.transform(viewport.transform, it.transform);
    const height = Math.abs(it.height) || Math.abs(tx[3]) || 10;

    items.push({
      text: str,
      top: tx[5],
      x0: tx[4],
      x1: tx[4] + (it.width || str.length * height * 0.5),
      height,
    });
  }

  const totalLen = rawText.trim().length;
  const rtl = isRtlText(rawText);

  return {
    table: itemsToTable(items, rtl),
    totalLen,
    rawText,
    rtl,
    brokenEncoding: looksLikeBrokenArabicEncoding(rawText),
  };
}

// ---------------------------------------------------------------------------
// OCR — يتم تشغيله فقط عندما تحتاج الصفحة لذلك.
// ara+eng أفضل للملفات المختلطة عربي + إنجليزي + أرقام.
// ---------------------------------------------------------------------------
async function extractOcrPage(page, statusPrefix) {
  const viewport = page.getViewport({ scale: 2.4 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  await page.render({
    canvasContext: ctx,
    viewport,
    intent: "print",
  }).promise;

  if (!ocrWorker) {
    setStatus(0, statusPrefix + " جاري تحميل محرك القراءة العربية...");

    ocrWorker = await Tesseract.createWorker("ara+eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setStatus(
            Math.round(m.progress * 100),
            statusPrefix + " قراءة الصفحة OCR جارية..."
          );
        }
      },
    });

    // تحسين عام للصفحات التي تحتوي على كتلة نصية/جدول.
    try {
      await ocrWorker.setParameters({
        preserve_interword_spaces: "1",
        user_defined_dpi: "300",
      });
    } catch (e) {
      // بعض إصدارات Tesseract قد لا تدعم كل الإعدادات؛ لا نوقف التحويل.
      console.warn("OCR parameters warning:", e);
    }
  }

  const { data } = await ocrWorker.recognize(canvas);
  const ocrText = data.text || "";
  const rtl = isRtlText(ocrText);

  const items = [];

  for (const w of data.words || []) {
    const t = (w.text || "").trim();
    if (!t) continue;

    items.push({
      text: t,
      top: w.bbox.y0,
      x0: w.bbox.x0,
      x1: w.bbox.x1,
      height: w.bbox.y1 - w.bbox.y0,
    });
  }

  return {
    table: itemsToTable(items, rtl),
    text: ocrText,
    rtl,
  };
}

// ---------------------------------------------------------------------------
// تنسيق Excel
// ---------------------------------------------------------------------------
function normalizeCellValue(value) {
  return (value || "")
    .toString()
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNumber(value) {
  return /^[\d,\s.-]+$/.test(value) && /\d/.test(value);
}

function looksLikeDate(value) {
  return /^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}$/.test(value);
}

async function convertOneFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;

  const workbook = new ExcelJS.Workbook();

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    setStatus(
      Math.round(((pageNum - 1) / totalPages) * 100),
      `${file.name}: تحليل صفحة ${pageNum} من ${totalPages}...`
    );

    const page = await pdf.getPage(pageNum);
    const extracted = await extractTextPage(page);

    // قرار OCR يتم لكل صفحة على حدة.
    const needsOcr =
      extracted.totalLen < MIN_TEXT_LEN_FOR_TEXT_PAGE ||
      extracted.brokenEncoding;

    let table = extracted.table;
    let sourceNote = "نص PDF";

    if (needsOcr) {
      if (ocrToggle.checked) {
        setStatus(
          Math.round(((pageNum - 1) / totalPages) * 100),
          `${file.name}: الصفحة ${pageNum} تحتاج OCR — جاري القراءة...`
        );

        const ocr = await extractOcrPage(
          page,
          `${file.name} - صفحة ${pageNum}:`
        );

        table = ocr.table;
        sourceNote =
          extracted.totalLen < MIN_TEXT_LEN_FOR_TEXT_PAGE
            ? "OCR تلقائي (صفحة صورة/بدون نص)"
            : "OCR تلقائي (تم اكتشاف ترميز نص مكسور)";
      } else {
        sourceNote = "نص مكسور/صورة — OCR متوقف";
      }
    }

    const sheetName = `صفحة ${pageNum}`.slice(0, 31);

    const ws = workbook.addWorksheet(sheetName, {
      views: [
        {
          rightToLeft: extracted.rtl,
          state: "frozen",
          ySplit: 1,
        },
      ],
    });

    if (!table.length) {
      ws.getCell("A1").value =
        "⚠️ لم يتم العثور على محتوى قابل للاستخراج في هذه الصفحة";
      continue;
    }

    const maxCols = Math.max(...table.map(r => r.length));
    const colWidths = new Array(maxCols).fill(MIN_COL_WIDTH);

    table.forEach((row, rIdx) => {
      const isHeader = rIdx === 0;

      for (let c = 0; c < maxCols; c++) {
        const raw = normalizeCellValue(row[c]);
        const cell = ws.getCell(rIdx + 1, c + 1);

        // نخلي الأرقام والتواريخ أرقام/تواريخ Excel بدل تحويلها لنص كلما أمكن.
        if (looksLikeNumber(raw) && !looksLikeDate(raw)) {
          const numeric = Number(raw.replace(/,/g, ""));
          cell.value = Number.isFinite(numeric) ? numeric : raw;
        } else if (looksLikeDate(raw)) {
          const [y, m, d] = raw.split(/[\/-]/).map(Number);
          cell.value = new Date(y, m - 1, d);
          cell.numFmt = "yyyy/mm/dd";
        } else {
          cell.value = raw;
        }

        cell.border = {
          top: { style: "thin", color: { argb: "FFB7B7B7" } },
          bottom: { style: "thin", color: { argb: "FFB7B7B7" } },
          left: { style: "thin", color: { argb: "FFB7B7B7" } },
          right: { style: "thin", color: { argb: "FFB7B7B7" } },
        };

        if (isHeader) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF1F4E78" },
          };
          cell.font = {
            name: "Arial",
            bold: true,
            color: { argb: "FFFFFFFF" },
            size: 11,
          };
          cell.alignment = {
            horizontal: "center",
            vertical: "middle",
            wrapText: true,
          };
        } else {
          cell.font = { name: "Arial", size: 11 };
          cell.alignment = {
            horizontal: extracted.rtl ? "right" : "left",
            vertical: "middle",
            wrapText: true,
          };
        }

        colWidths[c] = Math.min(
          MAX_COL_WIDTH,
          Math.max(colWidths[c], raw.length + 4)
        );
      }
    });

    colWidths.forEach((w, idx) => {
      ws.getColumn(idx + 1).width = w;
    });

    const noteRow = table.length + 3;
    ws.getCell(noteRow, 1).value = `(مصدر الاستخراج: ${sourceNote})`;
    ws.getCell(noteRow, 1).font = {
      name: "Arial",
      size: 8,
      italic: true,
      color: { argb: "FF888888" },
    };
  }

  setStatus(95, `${file.name}: جاري حفظ ملف الإكسل...`);

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = file.name.replace(/\.pdf$/i, "") + ".xlsx";

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
