// -*- coding: utf-8 -*-
// app.js — محرك التحويل الكامل، شغال بالكامل جوه المتصفح (مفيش سيرفر، مفيش رفع ملفات)

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
    setStatus(0, "حصل خطأ: " + err.message);
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
// تجميع الكلمات/العناصر في صفوف وأعمدة (نفس منطق النسخة المكتبية)
// ---------------------------------------------------------------------------
function clusterRows(items) {
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
  rows.forEach(r => r.sort((a, b) => a.x0 - b.x0));
  return rows;
}

function medianHeight(rows) {
  const heights = [];
  rows.forEach(r => r.forEach(w => { if (w.height > 0) heights.push(w.height); }));
  if (!heights.length) return 12;
  heights.sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)];
}

function itemsToTable(items) {
  const rows = clusterRows(items);
  if (!rows.length) return [];
  const gapThreshold = medianHeight(rows) * COLUMN_GAP_MULTIPLIER;
  const table = [];
  for (const row of rows) {
    const cells = [];
    let currentWords = [row[0].text];
    let lastX1 = row[0].x1;
    for (let i = 1; i < row.length; i++) {
      const w = row[i];
      if (w.x0 - lastX1 > gapThreshold) {
        cells.push(currentWords.join(" "));
        currentWords = [w.text];
      } else {
        currentWords.push(w.text);
      }
      lastX1 = w.x1;
    }
    cells.push(currentWords.join(" "));
    table.push(cells);
  }
  return table;
}

// ---------------------------------------------------------------------------
// نسبة الحروف "المقروءة فعليًا" (عربي أو لاتيني أو أرقام أو علامات ترقيم شائعة)
// من إجمالي الحروف المستخرجة. لو النسبة واطية، يبقى ده مؤشر إن الخط المستخدم
// في الـ PDF مكسور الترميز (مفيهوش جدول ربط Unicode صحيح)، والاستخراج
// النصي هيطلع رموز غريبة مش عربي حقيقي — في الحالة دي لازم OCR إجباري
// حتى لو الصفحة "نص" تقنيًا مش صورة.
// ---------------------------------------------------------------------------
const READABLE_CHAR_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFFa-zA-Z0-9\s.,\-\/:%()]/;

function readableRatio(text) {
  if (!text.length) return 1;
  let good = 0;
  for (const ch of text) {
    if (READABLE_CHAR_RE.test(ch)) good++;
  }
  return good / text.length;
}

// ---------------------------------------------------------------------------
// استخراج صفحة نصية عن طريق pdf.js
// ---------------------------------------------------------------------------
async function extractTextPage(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = [];
  let rawText = "";
  for (const it of content.items) {
    const str = (it.str || "").trim();
    if (!str) continue;
    rawText += str;
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
  const totalLen = rawText.length;
  const ratio = readableRatio(rawText);
  return { table: itemsToTable(items), totalLen, ratio };
}

// ---------------------------------------------------------------------------
// استخراج صفحة مصورة (سكانر) عن طريق Tesseract.js OCR عربي
// ---------------------------------------------------------------------------
async function extractOcrPage(page, statusPrefix) {
  const viewport = page.getViewport({ scale: 2.2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  if (!ocrWorker) {
    setStatus(0, statusPrefix + " جاري تحميل محرك القراءة العربية (أول مرة بس)...");
    ocrWorker = await Tesseract.createWorker("ara", 1, {
      logger: (m) => {
        if (m.status === "recognizing text") {
          setStatus(Math.round(m.progress * 100), statusPrefix + " قراءة عربية جارية...");
        }
      },
    });
  }

  const { data } = await ocrWorker.recognize(canvas);
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
  return itemsToTable(items);
}

// ---------------------------------------------------------------------------
// بناء ملف Excel منسّق تلقائيًا (نفس تنسيق النسخة المكتبية)
// ---------------------------------------------------------------------------
async function convertOneFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;

  const workbook = new ExcelJS.Workbook();

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    setStatus(Math.round(((pageNum - 1) / totalPages) * 100), `${file.name}: تحليل صفحة ${pageNum} من ${totalPages}...`);
    const page = await pdf.getPage(pageNum);
    const { table: textTable, totalLen, ratio } = await extractTextPage(page);

    // الصفحة محتاجة OCR لو: (أ) مفيهاش نص كفاية (يبقى صورة أصلًا)،
    // أو (ب) فيها نص كتير لكن نسبة كبيرة منه رموز غير مقروءة (خط مكسور الترميز)
    const needsOcr = totalLen < MIN_TEXT_LEN_FOR_TEXT_PAGE || ratio < 0.55;

    let table = textTable;
    let sourceNote = "نص";
    if (needsOcr) {
      if (ocrToggle.checked) {
        table = await extractOcrPage(page, `${file.name} - صفحة ${pageNum}:`);
        sourceNote = totalLen < MIN_TEXT_LEN_FOR_TEXT_PAGE ? "OCR" : "OCR (تم تجاوز نص مكسور الترميز)";
      } else {
        table = [];
        sourceNote = "فارغة أو نص مكسور الترميز (فعّل خيار OCR)";
      }
    }

    const sheetName = `صفحة ${pageNum}`.slice(0, 31);
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
    });

    if (!table.length) {
      ws.getCell("A1").value = "⚠️ لم يتم العثور على محتوى قابل للاستخراج في هذه الصفحة";
      continue;
    }

    const maxCols = Math.max(...table.map(r => r.length));
    const colWidths = new Array(maxCols).fill(MIN_COL_WIDTH);

    table.forEach((row, rIdx) => {
      const isHeader = rIdx === 0;
      for (let c = 0; c < maxCols; c++) {
        const raw = (row[c] || "").toString().replace(/\s+/g, " ").trim();
        const cell = ws.getCell(rIdx + 1, c + 1);
        cell.value = raw;
        cell.border = {
          top: { style: "thin", color: { argb: "FFB7B7B7" } },
          bottom: { style: "thin", color: { argb: "FFB7B7B7" } },
          left: { style: "thin", color: { argb: "FFB7B7B7" } },
          right: { style: "thin", color: { argb: "FFB7B7B7" } },
        };
        if (isHeader) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
          cell.font = { name: "Arial", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
          cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        } else {
          cell.font = { name: "Arial", size: 11 };
          cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
        }
        colWidths[c] = Math.min(MAX_COL_WIDTH, Math.max(colWidths[c], raw.length + 4));
      }
    });

    colWidths.forEach((w, idx) => { ws.getColumn(idx + 1).width = w; });

    const noteRow = table.length + 3;
    ws.getCell(noteRow, 1).value = `(مصدر الاستخراج: ${sourceNote})`;
    ws.getCell(noteRow, 1).font = { name: "Arial", size: 8, italic: true, color: { argb: "FF888888" } };
  }

  setStatus(95, `${file.name}: جاري حفظ ملف الإكسل...`);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name.replace(/\.pdf$/i, "") + ".xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
