// ============================================================
// ✏️ عدّل هذين السطرين فقط ليظهر اسمك وحسابك في أسفل الصفحة وفي الطباعة
// ============================================================
const DEV = { name: " احمد الارحبي", instagram: "اكتب_حسابك_هنا" };

const $ = (id) => document.getElementById(id);
const money = (n) => Number(n || 0).toLocaleString("en-US") + " ر.ي";
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cart = new Map();
let cards = [], products = [], salesList = [], psList = [], debtsList = [], expList = [], lastReport = null;
let mode = "cards", currentPage = "sale", currentInvoice = null, toastTimer;

const TITLES = { sale: "نقطة البيع", history: "سجل الفواتير", psales: "مبيعات المنتجات", products: "المنتجات والمخزون", debts: "الديون", expenses: "المصروفات", reports: "التقارير", settings: "الإعدادات" };
const TYPE_LABEL = { cards: ["كروت", "t-blue"], products: ["منتجات", "t-mint"], mixed: ["مختلط", "t-amber"] };
const CATS = { electricity: "كهرباء", salary: "أجور", purchase: "مشتريات", other: "أخرى" };

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = "/"; throw new Error("انتهت الجلسة، سجّل الدخول من جديد"); }
  if (!res.ok) throw new Error(data.error || "تعذر تنفيذ الطلب");
  return data;
}
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body || {}) });

function notify(message, error = false) {
  const t = $("toast");
  t.textContent = message;
  t.className = "toast show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { notify(e.message, true); } };

// ---------- التواريخ والفترات ----------
function dateString(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
const FIELDS = { sales: ["salesFrom", "salesTo"], ps: ["psFrom", "psTo"], debts: ["debtFrom", "debtTo"], exp: ["expFrom", "expTo"], rep: ["repFrom", "repTo"] };
const LOADERS = { sales: () => loadSales(), ps: () => loadProductSales(), debts: () => loadDebts(), exp: () => loadExpenses(), rep: () => loadReport() };

function setRange(p, kind) {
  const now = new Date(); let from = "", to = dateString(now);
  if (kind === "today") from = to;
  else if (kind === "week") from = dateString(new Date(now.getTime() - 6 * 864e5));
  else if (kind === "month") from = dateString(new Date(now.getFullYear(), now.getMonth(), 1));
  else if (kind === "lastmonth") { from = dateString(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = dateString(new Date(now.getFullYear(), now.getMonth(), 0)); }
  else if (kind === "year") from = dateString(new Date(now.getFullYear(), 0, 1));
  else if (kind === "all") to = "";
  $(FIELDS[p][0]).value = from; $(FIELDS[p][1]).value = to;
  LOADERS[p]();
}
function buildPresets() {
  const items = [["today", "اليوم"], ["week", "آخر 7 أيام"], ["month", "هذا الشهر"], ["lastmonth", "الشهر الماضي"], ["year", "هذه السنة"], ["all", "الكل"]];
  document.querySelectorAll(".presets").forEach((el) => {
    el.innerHTML = items.map(([k, l]) => `<button class="chip" onclick="setRange('${el.dataset.p}','${k}')">${l}</button>`).join("");
  });
}
const periodText = (f, t) => (f || t ? `الفترة: ${f || "البداية"} إلى ${t || "اليوم"}` : "كل الفترات");
const qs = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v))).toString();

// ---------- النوافذ ----------
function openModal(html, wide) { const m = $("modal"); m.innerHTML = `<div class="dialog ${wide ? "wide" : ""}">${html}</div>`; m.hidden = false; }
function closeModal() { $("modal").hidden = true; $("modal").innerHTML = ""; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function formModal(title, fields, okText = "حفظ") {
  return new Promise((resolve) => {
    const input = (f) => f.type === "select"
      ? `<select name="${f.name}">${f.options.map(([v, l]) => `<option value="${v}" ${String(v) === String(f.value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
      : `<input name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" ${f.required ? "required" : ""} ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} placeholder="${esc(f.placeholder || "")}">`;
    openModal(`<h3>${esc(title)}</h3><form id="mf"><div class="fields">${fields.map((f) => `<label class="${f.full ? "full" : ""}">${esc(f.label)}${input(f)}</label>`).join("")}</div>
      <div class="btns"><button type="button" class="ghost" id="mc">إلغاء</button><button class="primary">${okText}</button></div></form>`);
    $("mf").onsubmit = (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData($("mf"))); closeModal(); resolve(v); };
    $("mc").onclick = () => { closeModal(); resolve(null); };
    $("mf").querySelector("input,select")?.focus();
  });
}
function confirmBox(message, okText = "حذف") {
  return new Promise((resolve) => {
    openModal(`<h3>تأكيد</h3><p style="line-height:2">${esc(message)}</p><div class="btns"><button class="ghost" id="cn">إلغاء</button><button class="danger" id="cy">${okText}</button></div>`);
    $("cn").onclick = () => { closeModal(); resolve(false); };
    $("cy").onclick = () => { closeModal(); resolve(true); };
  });
}

// ---------- الطباعة والتصدير ----------
const ptable = (heads, rows) => `<table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${heads.length}" style="text-align:center">لا توجد بيانات</td></tr>`}</tbody></table>`;
const psum = (pairs) => `<div class="sum">${pairs.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>`;

function printDoc(title, body) {
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  document.body.appendChild(f);
  const d = f.contentWindow.document;
  d.open();
  d.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page{margin:14mm}body{font-family:Tahoma,Arial,sans-serif;color:#111;font-size:13px}
    .head{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #2f5bff;padding-bottom:10px;margin-bottom:14px}
    .head h1{margin:0;font-size:22px}.head small{color:#555}h2{font-size:17px;margin:0 0 4px}.sub{color:#555;margin:0 0 12px}
    table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #d5dbe8;padding:7px 9px;text-align:right}th{background:#eef2fb}
    .sum{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0}.sum div{border:1px solid #d5dbe8;border-radius:8px;padding:8px 14px}.sum span{display:block;color:#555;font-size:11px}.sum b{font-size:15px}
    .foot{margin-top:24px;border-top:1px solid #ccc;padding-top:8px;color:#555;font-size:11px;display:flex;justify-content:space-between}
  </style></head><body>
    <div class="head"><h1>العالم فون</h1><small>تاريخ الطباعة: ${esc(new Date().toLocaleString("ar"))}</small></div>
    ${body}
    <div class="foot"><span>العالم فون — نظام إدارة المحل</span><span>تطوير ${esc(DEV.name)} · إنستغرام @${esc(DEV.instagram)}</span></div>
  </body></html>`);
  d.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2500); }, 350);
}

function exportCSV(name, heads, rows) {
  const cell = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const csv = "\uFEFF" + [heads, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `${name}-${dateString()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const totalsHtml = (pairs) => pairs.map(([k, v]) => `<div>${esc(k)}<b>${esc(v)}</b></div>`).join("");
const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`;

// ---------- التنقل ----------
function switchPage(name) {
  currentPage = name;
  document.querySelectorAll(".page").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((el) => el.classList.remove("active"));
  $("page-" + name).classList.add("active");
  document.querySelector(`.tab[data-page="${name}"]`).classList.add("active");
  $("pageTitle").textContent = TITLES[name];
  scrollTo({ top: 0 });
  const run = { history: loadSales, psales: loadProductSales, products: loadProducts, debts: loadDebts, expenses: loadExpenses, reports: loadReport, settings: loadSettings, sale: refreshPicker }[name];
  if (run) guard(run)();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => switchPage(b.dataset.page)));
const reloadCurrent = () => switchPage(currentPage);

// ============================================================
// نقطة البيع
// ============================================================
document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
  mode = b.dataset.mode;
  document.querySelectorAll("#modeSeg button").forEach((x) => x.classList.toggle("on", x === b));
  renderPicker();
}));

async function loadCards() { cards = await api("/api/cards"); renderPicker(); }
async function fetchProducts() { products = await api("/api/products"); }
async function refreshPicker() { await Promise.all([loadCards(), fetchProducts()]); renderPicker(); }

function tile(type, id, name, sub, hint, stock) {
  const out = stock === 0, dis = out ? "disabled" : "";
  const isCard = type === "card";
  return `<article class="tile ${out ? "out" : ""}">
    <div><h3>${esc(name)}</h3><small>${esc(sub)}${out ? " — نفد المخزون" : ""}</small></div>
    ${hint > 0 ? `<button class="chip" ${dis} onclick="fillPrice('${type}',${id},${hint})">${isCard ? "سعرك المحفوظ" : "سعر البيع"}: ${money(hint)}</button>` : ""}
    <div class="two">
      <label>الكمية<input id="q-${type}-${id}" type="number" min="1" placeholder="الكمية" ${dis} ${isCard ? `oninput="clearAmount(${id})"` : ""}></label>
      <label>سعر الوحدة<input id="p-${type}-${id}" type="number" min="0" placeholder="السعر" value="${isCard && hint > 0 ? hint : ""}" ${dis} ${isCard ? `oninput="onAmount(${id})"` : ""}></label>
    </div>
    ${isCard ? `<label>أو اكتب المبلغ ويُحسب عدد الكروت<input id="a-card-${id}" type="number" min="1" placeholder="مثال: 3000" ${dis} oninput="onAmount(${id})"><small id="an-card-${id}" class="amt-note"></small></label>` : ""}
    <button class="primary" ${dis} onclick="addItem('${type}',${id})">إضافة للفاتورة</button>
  </article>`;
}
function renderPicker() {
  const q = $("pickerSearch").value.trim().toLowerCase();
  let html;
  if (mode === "cards") {
    html = cards.filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.face_value).includes(q))
      .map((c) => tile("card", c.id, c.name, "القيمة الاسمية " + c.face_value, c.default_price, null)).join("");
    $("picker").innerHTML = html || `<p class="hint">لا توجد فئات. أضفها من الإعدادات.</p>`;
  } else {
    html = products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q))
      .map((p) => tile("product", p.id, p.name, "المخزون: " + p.stock, p.sell_price, p.stock)).join("");
    $("picker").innerHTML = html || `<p class="hint">لا توجد منتجات. أضفها من صفحة المنتجات.</p>`;
  }
}
$("picker").addEventListener("keydown", (e) => {
  const m = /^[qpa]-(card|product)-(\d+)$/.exec(e.target.id || "");
  if (e.key === "Enter" && m) addItem(m[1], Number(m[2]));
});
function fillPrice(type, id, price) {
  $(`p-${type}-${id}`).value = price;
  if (type === "card") onAmount(id);
  $(`q-${type}-${id}`).focus();
}
// حساب عدد الكروت من المبلغ: الكمية = المبلغ ÷ سعر الوحدة (بدون كسور)
function onAmount(id) {
  const a = $(`a-card-${id}`), note = $(`an-card-${id}`), q = $(`q-card-${id}`);
  if (!a || a.value.trim() === "") { if (note) note.textContent = ""; return; }
  const amount = Number(a.value), price = Number($(`p-card-${id}`).value);
  if (!(price > 0)) { q.value = ""; note.textContent = "حدد سعر الوحدة أولًا"; return; }
  if (!Number.isSafeInteger(amount) || amount < 1) { q.value = ""; note.textContent = "المبلغ غير صحيح"; return; }
  const qty = Math.floor(amount / price), rest = amount - qty * price;
  if (qty < 1) { q.value = ""; note.textContent = "المبلغ أقل من سعر كرت واحد"; return; }
  q.value = qty;
  note.textContent = `${qty} كرت = ${money(qty * price)}` + (rest ? ` — الباقي ${money(rest)}` : "");
}
function clearAmount(id) {
  const a = $(`a-card-${id}`), note = $(`an-card-${id}`);
  if (a) a.value = "";
  if (note) note.textContent = "";
}

function addItem(type, id) {
  const src = (type === "card" ? cards : products).find((x) => x.id === id);
  const qText = $(`q-${type}-${id}`).value.trim(), pText = $(`p-${type}-${id}`).value.trim();
  const quantity = Number(qText), price = Number(pText);
  if (qText === "" || pText === "" || !Number.isSafeInteger(quantity) || quantity < 1 || !Number.isSafeInteger(price) || price < 0) {
    return notify("اكتب الكمية والسعر", true);
  }
  const key = type + "-" + id, old = cart.get(key);
  const qty = old && old.unit_price === price ? old.quantity + quantity : quantity;
  if (type === "product" && qty > src.stock) return notify(`المتوفر من ${src.name} هو ${src.stock} فقط`, true);
  cart.set(key, { key, item_type: type, item_ref: id, item_name: src.name, quantity: qty, unit_price: price });
  $(`q-${type}-${id}`).value = "";
  $(`p-${type}-${id}`).value = type === "card" && src.default_price > 0 ? src.default_price : "";
  if (type === "card") clearAmount(id);
  renderCart();
  notify("أُضيف إلى الفاتورة");
}
function renderCart() {
  const items = [...cart.values()];
  $("cartRows").innerHTML = items.map((i) => `<tr>
    <td>${esc(i.item_name)} <span class="tag ${i.item_type === "card" ? "t-blue" : "t-mint"}">${i.item_type === "card" ? "كرت" : "منتج"}</span></td>
    <td><input type="number" min="1" value="${i.quantity}" onchange="editCart('${i.key}','quantity',this.value)"></td>
    <td><input type="number" min="0" value="${i.unit_price}" onchange="editCart('${i.key}','unit_price',this.value)"></td>
    <td>${money(i.quantity * i.unit_price)}</td>
    <td><button class="btn-sm del" onclick="removeCart('${i.key}')">حذف</button></td></tr>`).join("") || emptyRow(5, "الفاتورة فارغة. اختر كرتًا أو منتجًا من الأعلى.");
  const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  $("cartTotal").textContent = money(total);
  $("cartCount").textContent = items.length + " صنف";
  $("cartTotal").classList.add("bump"); setTimeout(() => $("cartTotal").classList.remove("bump"), 180);
}
function editCart(key, field, value) {
  const item = cart.get(key), n = Number(value);
  if (value === "" || !Number.isSafeInteger(n) || (field === "quantity" ? n < 1 : n < 0)) { notify("القيمة غير صحيحة", true); return renderCart(); }
  if (field === "quantity" && item.item_type === "product") {
    const p = products.find((x) => x.id === item.item_ref);
    if (p && n > p.stock) { notify(`المتوفر من ${p.name} هو ${p.stock} فقط`, true); return renderCart(); }
  }
  item[field] = n; renderCart();
}
function removeCart(key) { cart.delete(key); renderCart(); }
function resetSaleForm() { cart.clear(); ["salePaid", "saleNotes", "customerName"].forEach((i) => ($(i).value = "")); renderCart(); }
async function clearCart() {
  if (!cart.size) return;
  if (await confirmBox("تفريغ الفاتورة الحالية؟", "تفريغ")) resetSaleForm();
}
const completeSale = guard(async () => {
  const items = [...cart.values()];
  if (!items.length) return notify("أضف أصنافًا إلى الفاتورة أولًا", true);
  const total = items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const paidText = $("salePaid").value.trim();
  const paid = paidText === "" ? total : Number(paidText);
  if (!Number.isSafeInteger(paid) || paid < 0 || paid > total) return notify("المبلغ المدفوع غير صحيح", true);
  const sale = await send("/api/sales", "POST", { items, paid, notes: $("saleNotes").value.trim(), customer_name: $("customerName").value.trim() });
  resetSaleForm();
  await refreshAll(false);
  notify("تم حفظ الفاتورة " + sale.invoice_no);
  showInvoice(sale);
});

// ---------- الفاتورة ----------
function invoiceBody(s) {
  const rows = (s.items || []).map((i) => [i.item_name, i.quantity, money(i.unit_price), money(i.line_total)]);
  return `<h2>فاتورة مبيعات</h2><p class="sub">رقم: ${esc(s.invoice_no)} — ${esc(s.created_at || "")}${s.customer_name ? " — الزبون: " + esc(s.customer_name) : ""}</p>
    ${ptable(["الصنف", "الكمية", "سعر الوحدة", "الإجمالي"], rows)}
    ${psum([["الإجمالي", money(s.total)], ["المدفوع", money(s.paid)], ["المتبقي", money(s.total - s.paid)]])}
    ${s.notes ? `<p class="sub">ملاحظات: ${esc(s.notes)}</p>` : ""}`;
}
function showInvoice(sale) {
  currentInvoice = sale;
  openModal(`<div class="invoice-view">${invoiceBody(sale)}</div>
    <div class="btns"><button class="ghost" onclick="closeModal()">إغلاق</button><button class="primary" onclick="printDoc('فاتورة '+currentInvoice.invoice_no, invoiceBody(currentInvoice))">طباعة / PDF</button></div>`, true);
}
const viewInvoice = guard(async (id) => showInvoice(await api("/api/sales/" + id)));
const printSale = guard(async (id) => { const s = await api("/api/sales/" + id); printDoc("فاتورة " + s.invoice_no, invoiceBody(s)); });
const editSale = guard(async (id) => {
  const s = await api("/api/sales/" + id);
  const v = await formModal("تعديل الفاتورة " + s.invoice_no, [
    { name: "customer_name", label: "اسم الزبون", value: s.customer_name || "", full: true },
    { name: "paid", label: `المدفوع (الإجمالي ${s.total})`, type: "number", min: 0, max: s.total, value: s.paid, required: true },
    { name: "notes", label: "ملاحظات", value: s.notes || "" }]);
  if (!v) return;
  await send("/api/sales/" + id, "PUT", v);
  notify("تم تعديل الفاتورة"); reloadCurrent(); refreshSummary();
});
const deleteSale = guard(async (id) => {
  if (!(await confirmBox("سيتم حذف الفاتورة نهائيًا، وتُعاد كميات المنتجات فيها إلى المخزون. هل تريد المتابعة؟"))) return;
  await send("/api/sales/" + id, "DELETE");
  notify("تم حذف الفاتورة"); reloadCurrent(); refreshSummary(); fetchProducts();
});

// ============================================================
// سجل الفواتير
// ============================================================
const loadSales = guard(async () => {
  const p = { from: $("salesFrom").value, to: $("salesTo").value, type: $("salesType").value, q: $("salesQ").value.trim() };
  salesList = await api("/api/sales?" + qs(p));
  $("salesRows").innerHTML = salesList.map((s) => {
    const [label, cls] = TYPE_LABEL[s.sale_type] || ["—", ""], rem = s.total - s.paid;
    return `<tr><td>${esc(s.invoice_no)}</td><td>${esc(s.created_at)}</td><td><span class="tag ${cls}">${label}</span></td><td>${esc(s.customer_name || "—")}</td>
      <td>${money(s.total)}</td><td>${money(s.paid)}</td><td class="${rem > 0 ? "neg" : ""}">${money(rem)}</td>
      <td><div class="row-actions"><button class="btn-sm" onclick="viewInvoice(${s.id})">عرض</button><button class="btn-sm" onclick="printSale(${s.id})">طباعة</button>
      <button class="btn-sm" onclick="editSale(${s.id})">تعديل</button><button class="btn-sm del" onclick="deleteSale(${s.id})">حذف</button></div></td></tr>`;
  }).join("") || emptyRow(8, "لا توجد فواتير لهذه الفترة");
  const t = salesList.reduce((a, s) => ({ total: a.total + s.total, paid: a.paid + s.paid }), { total: 0, paid: 0 });
  $("salesTotals").innerHTML = totalsHtml([["عدد الفواتير", salesList.length], ["الإجمالي", money(t.total)], ["المدفوع", money(t.paid)], ["المتبقي", money(t.total - t.paid)]]);
});
const salesRowsData = () => salesList.map((s) => [s.invoice_no, s.created_at, (TYPE_LABEL[s.sale_type] || ["—"])[0], s.customer_name || "", s.total, s.paid, s.total - s.paid]);
const SALES_HEADS = ["الفاتورة", "التاريخ", "النوع", "الزبون", "الإجمالي", "المدفوع", "المتبقي"];
function printSalesList() {
  const t = salesList.reduce((a, s) => ({ total: a.total + s.total, paid: a.paid + s.paid }), { total: 0, paid: 0 });
  printDoc("سجل الفواتير", `<h2>سجل الفواتير</h2><p class="sub">${periodText($("salesFrom").value, $("salesTo").value)}</p>
    ${psum([["عدد الفواتير", salesList.length], ["الإجمالي", money(t.total)], ["المدفوع", money(t.paid)], ["المتبقي", money(t.total - t.paid)]])}
    ${ptable(SALES_HEADS, salesRowsData().map((r) => r.map((c, i) => (i >= 4 ? money(c) : c))))}`);
}
const exportSalesCSV = () => exportCSV("alalam-sales", SALES_HEADS, salesRowsData());

// ============================================================
// مبيعات المنتجات
// ============================================================
const loadProductSales = guard(async () => {
  psList = await api("/api/product-sales?" + qs({ from: $("psFrom").value, to: $("psTo").value }));
  $("psRows").innerHTML = psList.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.invoice_no)}</td><td>${esc(r.item_name)}</td><td>${r.quantity}</td>
    <td>${money(r.unit_price)}</td><td>${money(r.line_total)}</td><td class="${r.profit >= 0 ? "pos" : "neg"}">${money(r.profit)}</td>
    <td><div class="row-actions"><button class="btn-sm" onclick="viewInvoice(${r.sale_id})">الفاتورة</button><button class="btn-sm" onclick="editSale(${r.sale_id})">تعديل</button>
    <button class="btn-sm del" onclick="deleteSale(${r.sale_id})">حذف</button></div></td></tr>`).join("") || emptyRow(8, "لا توجد مبيعات منتجات لهذه الفترة");
  const t = psTotals();
  $("psTotals").innerHTML = totalsHtml([["عدد البنود", psList.length], ["الكمية", t.qty], ["إجمالي المبيعات", money(t.total)], ["الربح", money(t.profit)]]);
});
const psTotals = () => psList.reduce((a, r) => ({ qty: a.qty + r.quantity, total: a.total + r.line_total, profit: a.profit + r.profit }), { qty: 0, total: 0, profit: 0 });
const PS_HEADS = ["التاريخ", "الفاتورة", "المنتج", "الكمية", "سعر البيع", "الإجمالي", "الربح"];
function printProductSales() {
  const t = psTotals();
  printDoc("مبيعات المنتجات", `<h2>تقرير مبيعات المنتجات</h2><p class="sub">${periodText($("psFrom").value, $("psTo").value)}</p>
    ${psum([["عدد البنود", psList.length], ["الكمية", t.qty], ["إجمالي المبيعات", money(t.total)], ["الربح", money(t.profit)]])}
    ${ptable(PS_HEADS, psList.map((r) => [r.created_at, r.invoice_no, r.item_name, r.quantity, money(r.unit_price), money(r.line_total), money(r.profit)]))}`);
}
const exportProductSales = () => exportCSV("alalam-product-sales", PS_HEADS, psList.map((r) => [r.created_at, r.invoice_no, r.item_name, r.quantity, r.unit_price, r.line_total, r.profit]));

// ============================================================
// المنتجات
// ============================================================
const loadProducts = guard(async () => { await fetchProducts(); renderProducts(); });
function filteredProducts() {
  const q = $("prodQ").value.trim().toLowerCase();
  return products.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.sku || "").toLowerCase().includes(q));
}
function renderProducts() {
  const list = filteredProducts();
  $("productRows").innerHTML = list.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.sku || "—")}</td><td>${money(p.cost_price)}</td><td>${money(p.sell_price)}</td>
    <td>${p.stock > 0 ? p.stock : `<span class="tag t-coral">نفد</span>`}</td>
    <td><div class="row-actions"><button class="btn-sm" onclick="editProduct(${p.id})">تعديل</button><button class="btn-sm del" onclick="deleteProduct(${p.id})">حذف</button></div></td></tr>`).join("") || emptyRow(6, "لا توجد منتجات");
  const cost = list.reduce((s, p) => s + p.cost_price * p.stock, 0), sell = list.reduce((s, p) => s + p.sell_price * p.stock, 0);
  $("prodTotals").innerHTML = totalsHtml([["عدد المنتجات", list.length], ["قطع المخزون", list.reduce((s, p) => s + p.stock, 0)], ["قيمة المخزون بالتكلفة", money(cost)], ["قيمته بسعر البيع", money(sell)]]);
}
$("productForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  await send("/api/products", "POST", Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await loadProducts(); notify("تمت إضافة المنتج");
}));
const editProduct = guard(async (id) => {
  const p = products.find((x) => x.id === id);
  const v = await formModal("تعديل المنتج", [
    { name: "name", label: "الاسم", value: p.name, required: true, full: true },
    { name: "sku", label: "الرمز", value: p.sku || "" },
    { name: "stock", label: "الكمية", type: "number", min: 0, value: p.stock, required: true },
    { name: "cost_price", label: "التكلفة", type: "number", min: 0, value: p.cost_price, required: true },
    { name: "sell_price", label: "سعر البيع", type: "number", min: 0, value: p.sell_price, required: true }]);
  if (!v) return;
  await send("/api/products/" + id, "PUT", v);
  notify("تم تعديل المنتج"); loadProducts();
});
const deleteProduct = guard(async (id) => {
  const p = products.find((x) => x.id === id);
  if (!(await confirmBox(`حذف المنتج «${p.name}»؟ تبقى فواتيره القديمة محفوظة.`))) return;
  await send("/api/products/" + id, "DELETE");
  notify("تم حذف المنتج"); loadProducts();
});
const PROD_HEADS = ["المنتج", "الرمز", "التكلفة", "سعر البيع", "المخزون"];
function printProducts() {
  const l = filteredProducts();
  printDoc("جرد المنتجات", `<h2>جرد المنتجات والمخزون</h2>${psum([["عدد المنتجات", l.length], ["قيمة المخزون بالتكلفة", money(l.reduce((s, p) => s + p.cost_price * p.stock, 0))]])}
    ${ptable(PROD_HEADS, l.map((p) => [p.name, p.sku || "", money(p.cost_price), money(p.sell_price), p.stock]))}`);
}
const exportProducts = () => exportCSV("alalam-products", PROD_HEADS, filteredProducts().map((p) => [p.name, p.sku || "", p.cost_price, p.sell_price, p.stock]));

// ============================================================
// الديون
// ============================================================
const dirText = (d) => (d === "receivable" ? "لنا عنده" : "علينا له");
const loadDebts = guard(async () => {
  debtsList = await api("/api/debts?" + qs({ from: $("debtFrom").value, to: $("debtTo").value, direction: $("debtDir").value, status: $("debtStatus").value }));
  $("debtRows").innerHTML = debtsList.map((d) => `<tr><td>${esc(d.created_at.slice(0, 10))}</td><td>${esc(d.person_name)}</td>
    <td><span class="tag ${d.direction === "receivable" ? "t-mint" : "t-coral"}">${dirText(d.direction)}</span></td><td>${esc(d.reason)}</td>
    <td>${money(d.amount)}</td><td>${money(d.paid_amount)}</td><td>${d.remaining > 0 ? `<b class="neg">${money(d.remaining)}</b>` : `<span class="tag t-mint">مكتمل</span>`}</td>
    <td><div class="row-actions">${d.remaining > 0 ? `<button class="btn-sm pay" onclick="payDebt(${d.id})">تسديد</button>` : ""}
    <button class="btn-sm" onclick="printDebt(${d.id})">طباعة</button><button class="btn-sm" onclick="editDebt(${d.id})">تعديل</button>
    <button class="btn-sm del" onclick="deleteDebt(${d.id})">حذف</button></div></td></tr>`).join("") || emptyRow(8, "لا توجد ديون مطابقة");
  const sum = (dir) => debtsList.filter((d) => d.direction === dir).reduce((s, d) => s + d.remaining, 0);
  $("debtTotals").innerHTML = totalsHtml([["عدد السجلات", debtsList.length], ["المتبقي لنا", money(sum("receivable"))], ["المتبقي علينا", money(sum("payable"))]]);
});
$("debtForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  await send("/api/debts", "POST", Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await loadDebts(); refreshSummary(); notify("تم حفظ الدين");
}));
const payDebt = guard(async (id) => {
  const d = debtsList.find((x) => x.id === id);
  const v = await formModal(`تسديد دين ${d.person_name}`, [
    { name: "amount", label: `المبلغ (المتبقي ${d.remaining})`, type: "number", min: 1, max: d.remaining, required: true, placeholder: "المبلغ المسدّد", full: true },
    { name: "notes", label: "ملاحظات", full: true }], "تسجيل التسديد");
  if (!v) return;
  await send(`/api/debts/${id}/payments`, "POST", v);
  notify("تم تسجيل التسديد"); loadDebts(); refreshSummary();
});
const editDebt = guard(async (id) => {
  const d = debtsList.find((x) => x.id === id);
  const v = await formModal("تعديل الدين", [
    { name: "person_name", label: "الشخص", value: d.person_name, required: true },
    { name: "direction", label: "النوع", type: "select", value: d.direction, options: [["receivable", "لنا عنده"], ["payable", "علينا له"]] },
    { name: "reason", label: "السبب", value: d.reason, required: true },
    { name: "amount", label: `المبلغ (المسدّد ${d.paid_amount})`, type: "number", min: Math.max(1, d.paid_amount), value: d.amount, required: true },
    { name: "notes", label: "ملاحظات", value: d.notes || "", full: true }]);
  if (!v) return;
  await send("/api/debts/" + id, "PUT", v);
  notify("تم تعديل الدين"); loadDebts(); refreshSummary();
});
const deleteDebt = guard(async (id) => {
  const d = debtsList.find((x) => x.id === id);
  if (!(await confirmBox(`حذف دين ${d.person_name} (${money(d.amount)}) وكل تسديداته؟`))) return;
  await send("/api/debts/" + id, "DELETE");
  notify("تم حذف الدين"); loadDebts(); refreshSummary();
});
const printDebt = guard(async (id) => {
  const d = debtsList.find((x) => x.id === id), pays = await api(`/api/debts/${id}/payments`);
  printDoc("كشف دين " + d.person_name, `<h2>كشف دين</h2><p class="sub">${esc(d.person_name)} — ${dirText(d.direction)} — ${esc(d.reason)} — بتاريخ ${esc(d.created_at)}</p>
    ${psum([["المبلغ", money(d.amount)], ["المسدّد", money(d.paid_amount)], ["المتبقي", money(d.remaining)]])}
    ${d.notes ? `<p class="sub">ملاحظات: ${esc(d.notes)}</p>` : ""}
    <h2>سجل التسديدات</h2>${ptable(["التاريخ", "المبلغ", "ملاحظات"], pays.map((p) => [p.created_at, money(p.amount), p.notes || ""]))}`);
});
const DEBT_HEADS = ["التاريخ", "الشخص", "النوع", "السبب", "المبلغ", "المسدّد", "المتبقي"];
const debtRowsData = () => debtsList.map((d) => [d.created_at.slice(0, 10), d.person_name, dirText(d.direction), d.reason, d.amount, d.paid_amount, d.remaining]);
function printDebts() {
  const sum = (dir) => debtsList.filter((d) => d.direction === dir).reduce((s, d) => s + d.remaining, 0);
  printDoc("كشف الديون", `<h2>كشف الديون</h2><p class="sub">${periodText($("debtFrom").value, $("debtTo").value)}</p>
    ${psum([["المتبقي لنا", money(sum("receivable"))], ["المتبقي علينا", money(sum("payable"))]])}
    ${ptable(DEBT_HEADS, debtRowsData().map((r) => r.map((c, i) => (i >= 4 ? money(c) : c))))}`);
}
const exportDebts = () => exportCSV("alalam-debts", DEBT_HEADS, debtRowsData());

// ============================================================
// المصروفات
// ============================================================
const loadExpenses = guard(async () => {
  expList = await api("/api/expenses?" + qs({ from: $("expFrom").value, to: $("expTo").value, category: $("expCat").value }));
  $("expenseRows").innerHTML = expList.map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc(e.description)}${e.notes ? `<br><small style="color:var(--muted)">${esc(e.notes)}</small>` : ""}</td>
    <td><span class="tag t-amber">${esc(CATS[e.category] || e.category)}</span></td><td>${money(e.amount)}</td>
    <td><div class="row-actions"><button class="btn-sm" onclick="printExpense(${e.id})">طباعة</button><button class="btn-sm" onclick="editExpense(${e.id})">تعديل</button>
    <button class="btn-sm del" onclick="deleteExpense(${e.id})">حذف</button></div></td></tr>`).join("") || emptyRow(5, "لا توجد مصروفات لهذه الفترة");
  $("expTotals").innerHTML = totalsHtml([["عدد المصروفات", expList.length], ["الإجمالي", money(expList.reduce((s, e) => s + e.amount, 0))]]);
});
$("expenseForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  await send("/api/expenses", "POST", Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await loadExpenses(); refreshSummary(); notify("تم حفظ المصروف");
}));
const editExpense = guard(async (id) => {
  const x = expList.find((e) => e.id === id);
  const v = await formModal("تعديل المصروف", [
    { name: "description", label: "الوصف", value: x.description, required: true, full: true },
    { name: "amount", label: "المبلغ", type: "number", min: 1, value: x.amount, required: true },
    { name: "category", label: "التصنيف", type: "select", value: x.category, options: Object.entries(CATS) },
    { name: "notes", label: "ملاحظات", value: x.notes || "", full: true }]);
  if (!v) return;
  await send("/api/expenses/" + id, "PUT", v);
  notify("تم تعديل المصروف"); loadExpenses(); refreshSummary();
});
const deleteExpense = guard(async (id) => {
  const x = expList.find((e) => e.id === id);
  if (!(await confirmBox(`حذف المصروف «${x.description}» (${money(x.amount)})؟`))) return;
  await send("/api/expenses/" + id, "DELETE");
  notify("تم حذف المصروف"); loadExpenses(); refreshSummary();
});
function printExpense(id) {
  const x = expList.find((e) => e.id === id);
  printDoc("سند مصروف", `<h2>سند مصروف</h2>${ptable(["التاريخ", "الوصف", "التصنيف", "المبلغ"], [[x.created_at, x.description, CATS[x.category] || x.category, money(x.amount)]])}${x.notes ? `<p class="sub">ملاحظات: ${esc(x.notes)}</p>` : ""}`);
}
const EXP_HEADS = ["التاريخ", "الوصف", "التصنيف", "المبلغ", "ملاحظات"];
const expRowsData = () => expList.map((e) => [e.created_at, e.description, CATS[e.category] || e.category, e.amount, e.notes || ""]);
function printExpenses() {
  printDoc("كشف المصروفات", `<h2>كشف المصروفات</h2><p class="sub">${periodText($("expFrom").value, $("expTo").value)}</p>
    ${psum([["العدد", expList.length], ["الإجمالي", money(expList.reduce((s, e) => s + e.amount, 0))]])}
    ${ptable(EXP_HEADS, expRowsData().map((r) => [r[0], r[1], r[2], money(r[3]), r[4]]))}`);
}
const exportExpenses = () => exportCSV("alalam-expenses", EXP_HEADS, expRowsData());

// ============================================================
// التقارير
// ============================================================
const reportRows = () => {
  const r = lastReport, s = r.sales;
  return [["عدد الفواتير", s.count], ["إجمالي المبيعات", s.total], ["مبيعات الكروت", s.cards_total], ["مبيعات المنتجات", s.products_total],
    ["ربح المنتجات", s.products_profit], ["المبالغ المدفوعة", s.paid], ["المتبقي على الزبائن", s.total - s.paid], ["المصروفات", r.expenses.total],
    ["ديون لنا", r.debts.receivable], ["ديون علينا", r.debts.payable], ["صافي المبيعات بعد المصروفات", s.total - r.expenses.total]];
};
const loadReport = guard(async () => {
  let from = $("repFrom").value || "2000-01-01", to = $("repTo").value || dateString();
  if (from > to) return notify("حدد فترة صحيحة", true);
  lastReport = await api("/api/reports/summary?" + qs({ from, to }));
  lastReport.range = periodText($("repFrom").value, $("repTo").value);
  const rows = reportRows(), net = rows[rows.length - 1][1];
  $("reportContent").innerHTML = `<div class="panel-head"><h3>تقرير العالم فون</h3><span class="badge">${esc(lastReport.range)}</span></div>
    <div class="report-grid">${rows.slice(0, -1).map(([k, v], i) => `<div>${k}<strong>${i === 0 ? v : money(v)}</strong></div>`).join("")}</div>
    <div class="net"><span>صافي المبيعات بعد المصروفات</span><strong>${money(net)}</strong></div>`;
});
function printReport() {
  if (!lastReport) return notify("أنشئ التقرير أولًا", true);
  printDoc("تقرير العالم فون", `<h2>تقرير العالم فون</h2><p class="sub">${esc(lastReport.range)}</p>${ptable(["البند", "القيمة"], reportRows().map(([k, v], i) => [k, i === 0 ? v : money(v)]))}`);
}
function exportReport() {
  if (!lastReport) return notify("أنشئ التقرير أولًا", true);
  exportCSV("alalam-report", ["البند", "القيمة"], reportRows());
}

// ============================================================
// الإعدادات والنسخ الاحتياطي
// ============================================================
const loadSettings = guard(async () => {
  cards = await api("/api/cards");
  $("settingsRows").innerHTML = cards.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.face_value}</td><td>${c.default_price > 0 ? money(c.default_price) : "—"}</td>
    <td><div class="row-actions"><button class="btn-sm" onclick="editCard(${c.id})">تعديل</button><button class="btn-sm del" onclick="removeCard(${c.id})">إيقاف</button></div></td></tr>`).join("") || emptyRow(4, "لا توجد فئات");
  await loadBackups();
});
$("cardForm").addEventListener("submit", guard(async (e) => {
  e.preventDefault();
  await send("/api/cards", "POST", Object.fromEntries(new FormData(e.target)));
  e.target.reset(); await loadSettings(); notify("تمت إضافة الفئة");
}));
const editCard = guard(async (id) => {
  const c = cards.find((x) => x.id === id);
  const v = await formModal("تعديل الفئة", [
    { name: "name", label: "الاسم", value: c.name, required: true },
    { name: "default_price", label: "السعر المحفوظ (0 = بدون)", type: "number", min: 0, value: c.default_price, required: true }]);
  if (!v) return;
  await send("/api/cards/" + id, "PATCH", { name: v.name, default_price: Number(v.default_price) });
  notify("تم التحديث"); loadSettings();
});
const removeCard = guard(async (id) => {
  const c = cards.find((x) => x.id === id);
  if (!(await confirmBox(`إيقاف الفئة «${c.name}»؟ تبقى الفواتير القديمة كما هي.`, "إيقاف"))) return;
  await send("/api/cards/" + id, "PATCH", { active: 0 });
  notify("تم إيقاف الفئة"); loadSettings();
});
async function loadBackups() {
  const list = await api("/api/backups");
  $("backupRows").innerHTML = list.map((b) => `<tr><td>${esc(b.file)}</td><td>${(b.size / 1024).toFixed(0)} KB</td><td>${esc(new Date(b.time).toLocaleString("ar"))}</td>
    <td><a class="btn-sm" href="/api/backups/${encodeURIComponent(b.file)}" style="text-decoration:none">تنزيل</a></td></tr>`).join("") || emptyRow(4, "لا توجد نسخ بعد");
}
const makeBackup = guard(async () => {
  const r = await send("/api/backup", "POST");
  $("backupResult").textContent = "تم إنشاء النسخة: " + r.file;
  notify("تم إنشاء النسخة الاحتياطية"); loadBackups();
});

// ============================================================
// الملخص والتحديث
// ============================================================
function animateNumber(el, to, isMoney) {
  const from = Number(el.dataset.v || 0), show = (v) => (el.textContent = isMoney ? money(v) : v);
  el.dataset.v = to;
  if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) return show(to);
  const t0 = performance.now();
  (function step(t) {
    const k = Math.min(1, (t - t0) / 700);
    show(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}
async function refreshSummary() {
  const r = await api("/api/reports/summary");
  animateNumber($("statSales"), r.sales.total, true);
  animateNumber($("statCount"), r.sales.count, false);
  animateNumber($("statExpenses"), r.expenses.total, true);
  animateNumber($("statReceivable"), r.debts.receivable, true);
}
function setConn(ok, text) { $("connection").textContent = text; $("dot").className = "dot " + (ok ? "ok" : "bad"); }
async function refreshAll(manual) {
  try {
    await api("/api/health");
    setConn(true, "متصل بالخادم");
    await Promise.all([refreshPicker(), refreshSummary()]);
    if (currentPage !== "sale") reloadCurrent();
    if (manual) notify("تم تحديث البيانات");
  } catch (e) {
    setConn(false, "لا يوجد اتصال بالخادم");
    notify("تعذر تحميل البيانات: " + e.message, true);
  }
}
async function logout() {
  try { await fetch("/api/logout", { method: "POST" }); } catch (e) { /* تجاهل */ }
  location.href = "/";
}
addEventListener("offline", () => setConn(false, "غير متصل بالإنترنت"));
addEventListener("online", () => refreshAll(false));

// ---------- التهيئة ----------
["sales", "ps", "exp", "rep"].forEach((p) => FIELDS[p].forEach((id) => ($(id).value = dateString())));
buildPresets();
$("todayLabel").textContent = new Date().toLocaleDateString("ar", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
$("year").textContent = new Date().getFullYear();
$("devName").textContent = DEV.name;
$("devInsta").href = "https://instagram.com/axh.d/" + encodeURIComponent(DEV.instagram);
renderCart();
refreshAll(false);

if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(console.error));
}
