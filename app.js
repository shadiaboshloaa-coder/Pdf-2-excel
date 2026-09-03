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

function looksLikeBrokenArabicItem(text) {
  if (!text) return false;
  const value = text.trim();
  if (value.length < 3) return false;
  const suspicious = countMatches(value, SUSPICIOUS_ENCODING_RE);
  const arabic = countMatches(value, ARABIC_GLOBAL_RE);
  return suspicious >= 2 && arabic === 0;
}

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
    items,
    table: itemsToTable(items, rtl),
    totalLen,
    rawText,
    rtl,
    brokenEncoding: looksLikeBrokenArabicEncoding(rawText),
  };
}

// ---------------------------------------------------------------------------
// OCR — لا نعمل OCR للصفحة كلها عندما يكون الـPDF نصيًا لكن العربي مكسور.
// بدل ذلك نحافظ على إحداثيات PDF الأصلية ونصحح فقط العناصر العربية المكسورة.
// هذا مهم جدًا للجداول: الأرقام والتواريخ والأعمدة تظل في أماكنها الأصلية.
// ---------------------------------------------------------------------------
async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;

  ocrWorker = await Tesseract.createWorker("ara+eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        setStatus(Math.round(m.progress * 100), "جاري تصحيح النص العربي...");
      }
    },
  });

  try {
    await ocrWorker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
  } catch (e) {
    console.warn("OCR parameters warning:", e);
  }

  return ocrWorker;
}

function cleanOcrText(text) {
  return (text || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUsefulArabic(text) {
  const n = countMatches(text || "", ARABIC_GLOBAL_RE);
  return n >= 2;
}

// OCR لعنصر/سطر واحد من الصفحة. لا نلمس بقية عناصر الـPDF.
async function ocrBrokenItem(pageCanvas, item, scale) {
  const pad = 14 * scale;
  const x = Math.max(0, Math.floor(item.x0 * scale - pad));
  const y = Math.max(0, Math.floor(item.top * scale - pad));
  const right = Math.min(pageCanvas.width, Math.ceil(item.x1 * scale + pad));
  const bottom = Math.min(pageCanvas.height, Math.ceil((item.top + item.height) * scale + pad));

  const width = Math.max(20, right - x);
  const height = Math.max(20, bottom - y);

  const crop = document.createElement("canvas");
  crop.width = width;
  crop.height = height;
  const ctx = crop.getContext("2d", { willReadFrequently: false });

  // أبيض نظيف خلف النص يقلل تأثير خلفية الصفحة/الخطوط.
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(pageCanvas, x, y, width, height, 0, 0, width, height);

  const worker = await ensureOcrWorker();
  try {
    // كل عنصر هنا عبارة عن سطر/خلية قصيرة، وPSM 7 أنسب من OCR صفحة كاملة.
    await worker.setParameters({ tessedit_pageseg_mode: "7" });
  } catch (_) {}

  const result = await worker.recognize(crop);
  const text = cleanOcrText(result?.data?.text || "");

  // لا نستبدل النص إلا إذا كان OCR أعاد عربيًا حقيقيًا.
  return hasUsefulArabic(text) ? text : null;
}

async function repairBrokenArabicItems(page, extracted, statusPrefix) {
  const brokenItems = extracted.items.filter(it => looksLikeBrokenArabicItem(it.text));
  if (!brokenItems.length) return extracted;

  if (!ocrToggle.checked) return extracted;

  const scale = 3.5;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: false });

  await page.render({
    canvasContext: ctx,
    viewport,
    intent: "print",
  }).promise;

  setStatus(0, `${statusPrefix} تصحيح ${brokenItems.length} جزء عربي...`);

  const replacements = new Map();
  for (let i = 0; i < brokenItems.length; i++) {
    const item = brokenItems[i];
    const fixed = await ocrBrokenItem(canvas, item, scale);
    if (fixed) replacements.set(item, fixed);
    setStatus(
      Math.round(((i + 1) / brokenItems.length) * 100),
      `${statusPrefix} تصحيح العربي ${i + 1} من ${brokenItems.length}...`
    );
  }

  const repairedItems = extracted.items.map(item => ({
    ...item,
    text: replacements.get(item) || item.text,
  }));

  const rawText = repairedItems.map(x => x.text).join(" ");
  const rtl = isRtlText(rawText);

  return {
    ...extracted,
    items: repairedItems,
    rawText,
    rtl,
    table: itemsToTable(repairedItems, rtl),
    brokenEncoding: false,
    repairedArabic: replacements.size,
  };
}

// OCR كامل فقط للـPDFs التي لا تحتوي على طبقة نص مفيدة (سكان/صور).
async function extractOcrPage(page, statusPrefix) {
  const viewport = page.getViewport({ scale: 3.0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);

  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  await page.render({
    canvasContext: ctx,
    viewport,
    intent: "print",
  }).promise;

  const worker = await ensureOcrWorker();
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
  } catch (_) {}

  setStatus(0, statusPrefix + " OCR عربي + إنجليزي للصفحة...");
  const { data } = await worker.recognize(canvas);
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

  return { table: itemsToTable(items, rtl), text: ocrText, rtl };
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

  // كل PDF = شيت واحد فقط.
  // صفحات الـPDF تُضاف تحت بعضها بالترتيب داخل نفس الشيت.
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet("البيانات", {
    views: [
      {
        rightToLeft: true,
        state: "frozen",
        ySplit: 1,
      },
    ],
  });

  let currentRow = 1;
  let firstTableHeader = null;
  let sheetRtl = true;

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    setStatus(
      Math.round(((pageNum - 1) / totalPages) * 100),
      `${file.name}: تحليل صفحة ${pageNum} من ${totalPages}...`
    );

    const page = await pdf.getPage(pageNum);
    const extracted = await extractTextPage(page);

    // قرار OCR يتم لكل صفحة على حدة.
    const needsFullOcr = extracted.totalLen < MIN_TEXT_LEN_FOR_TEXT_PAGE;
    let repaired = extracted;
    let table = extracted.table;
    let sourceNote = "نص PDF";

    if (needsFullOcr) {
      if (ocrToggle.checked) {
        const ocr = await extractOcrPage(
          page,
          `${file.name} - صفحة ${pageNum}:`
        );
        table = ocr.table;
        repaired = { ...extracted, rtl: ocr.rtl };
        sourceNote = "OCR تلقائي (صفحة صورة/بدون نص)";
      } else {
        sourceNote = "صفحة صورة/بدون نص — OCR متوقف";
      }
    } else if (extracted.brokenEncoding) {
      repaired = await repairBrokenArabicItems(
        page,
        extracted,
        `${file.name} - صفحة ${pageNum}:`
      );
      table = repaired.table;
      sourceNote = repaired.repairedArabic
        ? `تم تصحيح العربي تلقائيًا (${repaired.repairedArabic} جزء)`
        : "نص PDF — لم يتم العثور على OCR عربي موثوق";
    }

    if (!table.length) {
      continue;
    }

    // نستخدم اتجاه أول صفحة للشيت كله.
    if (pageNum === 1) {
      sheetRtl = !!repaired.rtl;
      ws.views[0].rightToLeft = sheetRtl;
      firstTableHeader = table[0].map(normalizeCellValue);
    }

    // لو الصفحة التالية فيها نفس رأس الجدول الموجود في أول صفحة،
    // نتجاهله حتى تكون كل البيانات متصلة تحت بعضها بدون تكرار رؤوس الصفحات.
    let rowsToWrite = table;
    if (pageNum > 1 && firstTableHeader && table.length) {
      const candidate = table[0].map(normalizeCellValue);
      if (sameHeader(candidate, firstTableHeader)) {
        rowsToWrite = table.slice(1);
      }
    }

    if (!rowsToWrite.length) continue;

    // سطر فاصل بسيط بين الصفحات، بدون إنشاء Sheet جديد.
    if (pageNum > 1 && currentRow > 1) {
      currentRow++;
    }

    const maxCols = Math.max(...rowsToWrite.map(r => r.length));
    const colWidths = [];
    for (let c = 0; c < maxCols; c++) {
      colWidths[c] = ws.getColumn(c + 1).width || MIN_COL_WIDTH;
    }

    rowsToWrite.forEach((row, rIdx) => {
      const isHeader = pageNum === 1 && rIdx === 0;

      for (let c = 0; c < maxCols; c++) {
        const raw = normalizeCellValue(row[c]);
        const cell = ws.getCell(currentRow + rIdx, c + 1);

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
            horizontal: sheetRtl ? "right" : "left",
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

    currentRow += rowsToWrite.length;
  }

  if (currentRow === 1) {
    ws.getCell("A1").value =
      "⚠️ لم يتم العثور على محتوى قابل للاستخراج في هذا الملف";
  }

  ws.autoFilter = {
    from: "A1",
    to: `${ws.getColumn(ws.columnCount).letter}1`,
  };

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

// مقارنة بسيطة لرؤوس الجداول لمنع تكرار Header كل صفحة.
function sameHeader(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  const norm = v => normalizeCellValue(v).replace(/\s+/g, "").toLowerCase();
  return a.every((v, i) => norm(v) === norm(b[i]));
}
