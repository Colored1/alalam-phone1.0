const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const BACKUP_DIR = path.join(ROOT, "backups");
const DB_PATH = path.join(DATA_DIR, "alalam.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ============ تسجيل الدخول والحماية ============
const AUTH_USER = process.env.ALALAM_USER || "العالم";
const AUTH_PASS = process.env.ALALAM_PASS || "7777";
const COOKIE_NAME = "alalam_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 يومًا
const SECRET_FILE = path.join(DATA_DIR, ".session-secret");
let SECRET = "";
try { SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) { /* سيُنشأ سر جديد */ }
if (SECRET.length < 32) {
  SECRET = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (payload) => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
function makeToken() { const exp = String(Date.now() + SESSION_MS); return exp + "." + sign(exp); }
function validToken(token) {
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
const isAuthed = (req) => validToken(readCookie(req, COOKIE_NAME));

// حماية من تخمين كلمة السر: 5 محاولات خاطئة = إيقاف 10 دقائق
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const isBlocked = (ip) => { const a = attempts.get(ip); return !!a && a.count >= 5 && Date.now() - a.first < WINDOW_MS; };
function recordFail(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first >= WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else a.count += 1;
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

app.post("/api/login", (req, res) => {
  const ip = req.ip || "unknown";
  if (isBlocked(ip)) return res.status(429).json({ error: "محاولات كثيرة خاطئة. حاول بعد 10 دقائق" });
  const user = String(req.body.username || "").trim(), pass = String(req.body.password || "");
  // تُنفَّذ المقارنتان دائمًا لتجنب كشف أيّهما الخطأ
  const okUser = safeEqual(user, AUTH_USER), okPass = safeEqual(pass, AUTH_PASS);
  if (!(okUser && okPass)) {
    recordFail(ip);
    return res.status(401).json({ error: "اسم المستخدم أو كلمة السر غير صحيحة" });
  }
  attempts.delete(ip);
  res.cookie(COOKIE_NAME, makeToken(), { httpOnly: true, sameSite: "lax", maxAge: SESSION_MS, path: "/" });
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});
app.get("/api/session", (req, res) => res.json({ ok: isAuthed(req) }));

// بوابة الحماية: كل شيء مغلق عدا صفحة الدخول وملفات التثبيت
const PUBLIC_PATHS = new Set(["/login.html", "/manifest.json", "/icon.svg"]);
app.use((req, res, next) => {
  if (isAuthed(req) || PUBLIC_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "سجّل الدخول أولًا" });
  if (req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
    return res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  }
  res.status(401).type("text/plain; charset=utf-8").send("يلزم تسجيل الدخول");
});

app.use(express.static(PUBLIC_DIR));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS card_types (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, face_value INTEGER NOT NULL,
    default_price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS customer_card_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, card_type_id INTEGER NOT NULL,
    price INTEGER NOT NULL CHECK(price >= 0), UNIQUE(customer_id, card_type_id),
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
    FOREIGN KEY(card_type_id) REFERENCES card_types(id)
  );
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_no TEXT NOT NULL UNIQUE, customer_id INTEGER,
    sale_type TEXT NOT NULL DEFAULT 'cards', total INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), notes TEXT,
    FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, card_type_id INTEGER,
    item_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity > 0),
    unit_price INTEGER NOT NULL CHECK(unit_price >= 0), line_total INTEGER NOT NULL,
    FOREIGN KEY(sale_id) REFERENCES sales(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sku TEXT UNIQUE,
    cost_price INTEGER NOT NULL DEFAULT 0, sell_price INTEGER NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, person_name TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('receivable','payable')), reason TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0), paid_amount INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), notes TEXT
  );
  CREATE TABLE IF NOT EXISTS debt_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, debt_id INTEGER NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), notes TEXT,
    FOREIGN KEY(debt_id) REFERENCES debts(id)
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0),
    category TEXT NOT NULL DEFAULT 'other', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), notes TEXT
  );
  CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT, payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), synced INTEGER NOT NULL DEFAULT 0
  );
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("sale_items", "item_type", "TEXT NOT NULL DEFAULT 'card'");
ensureColumn("sale_items", "item_ref", "INTEGER");
ensureColumn("sale_items", "unit_cost", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("sales", "customer_name", "TEXT");

// فئات الكروت الأساسية بدون أسعار افتراضية (تحدد السعر من الإعدادات إن أردت)
const insertCard = db.prepare(
  "INSERT OR IGNORE INTO card_types (id, name, face_value, default_price) VALUES (?, ?, ?, 0)"
);
[[100, "أبو 100", 100], [200, "أبو 200", 200], [250, "أبو 250", 250], [500, "أبو 500", 500]]
  .forEach((c) => insertCard.run(...c));

const auditStmt = db.prepare(
  "INSERT INTO audit_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)"
);
function logAction(action, entityType, entityId, details) {
  auditStmt.run(action, entityType, entityId == null ? null : String(entityId),
    details ? JSON.stringify(details) : null);
}

const validId = (v) => Number.isSafeInteger(v) && v > 0;
const validMoney = (v) => Number.isSafeInteger(v) && v >= 0;
function errorMessage(error) { console.error(error); return error.message || "حدث خطأ داخلي في الخادم"; }

function dateFilter(req, column, sql, params) {
  if (req.query.from) { sql += ` AND date(${column}) >= date(?)`; params.push(req.query.from); }
  if (req.query.to) { sql += ` AND date(${column}) <= date(?)`; params.push(req.query.to); }
  return sql;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, app: "Alalam Phone", database: "SQLite", time: new Date().toISOString() });
});

// ============ الكروت ============
app.get("/api/cards", (req, res) => {
  res.json(db.prepare(
    "SELECT id, name, face_value, default_price, active FROM card_types WHERE active = 1 ORDER BY face_value"
  ).all());
});

app.post("/api/cards", (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const face = Number(req.body.face_value);
    const price = req.body.default_price === "" || req.body.default_price == null ? 0 : Number(req.body.default_price);
    if (!name || !validId(face) || !validMoney(price)) {
      return res.status(400).json({ error: "تحقق من اسم الفئة وقيمتها وسعرها" });
    }
    const r = db.prepare("INSERT INTO card_types (name, face_value, default_price) VALUES (?, ?, ?)")
      .run(name, face, price);
    logAction("create", "card_type", r.lastInsertRowid, { name });
    res.status(201).json(db.prepare("SELECT * FROM card_types WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.patch("/api/cards/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, default_price, active } = req.body;
    if (!validId(id)) return res.status(400).json({ error: "معرف الفئة غير صالح" });
    if (default_price !== undefined && !validMoney(default_price)) return res.status(400).json({ error: "السعر غير صالح" });
    if (name !== undefined && (typeof name !== "string" || !name.trim())) return res.status(400).json({ error: "اسم الفئة غير صالح" });
    if (active !== undefined && ![0, 1, true, false].includes(active)) return res.status(400).json({ error: "حالة الفئة غير صالحة" });
    const existing = db.prepare("SELECT * FROM card_types WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "الفئة غير موجودة" });
    db.prepare("UPDATE card_types SET name = ?, default_price = ?, active = ? WHERE id = ?").run(
      name === undefined ? existing.name : name.trim(),
      default_price === undefined ? existing.default_price : default_price,
      active === undefined ? existing.active : Number(Boolean(active)), id);
    logAction("update", "card_type", id, req.body);
    res.json({ ok: true, card: db.prepare("SELECT * FROM card_types WHERE id = ?").get(id) });
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

// ============ الزبائن والأسعار الخاصة ============
app.get("/api/customers", (req, res) => {
  res.json(db.prepare("SELECT id, name, phone, notes, created_at FROM customers ORDER BY name").all());
});

app.post("/api/customers", (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "اسم الزبون مطلوب" });
    const r = db.prepare("INSERT INTO customers (name, phone, notes) VALUES (?, ?, ?)")
      .run(name, req.body.phone || null, req.body.notes || null);
    logAction("create", "customer", r.lastInsertRowid, { name });
    res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.put("/api/customers/:customerId/card-prices/:cardId", (req, res) => {
  try {
    const customerId = Number(req.params.customerId), cardId = Number(req.params.cardId), price = req.body.price;
    if (!validId(customerId) || !validId(cardId) || !validMoney(price)) return res.status(400).json({ error: "تحقق من الزبون والفئة والسعر" });
    if (!db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId) ||
        !db.prepare("SELECT id FROM card_types WHERE id = ?").get(cardId)) {
      return res.status(404).json({ error: "الزبون أو فئة الكروت غير موجودة" });
    }
    db.prepare(`INSERT INTO customer_card_prices (customer_id, card_type_id, price) VALUES (?, ?, ?)
      ON CONFLICT(customer_id, card_type_id) DO UPDATE SET price = excluded.price`).run(customerId, cardId, price);
    logAction("set_special_price", "customer", customerId, { cardId, price });
    res.json({ ok: true, customerId, cardId, price });
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.get("/api/customers/:customerId/card-prices", (req, res) => {
  const customerId = Number(req.params.customerId);
  if (!validId(customerId)) return res.status(400).json({ error: "معرف الزبون غير صالح" });
  if (!db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId)) return res.status(404).json({ error: "الزبون غير موجود" });
  res.json(db.prepare(`
    SELECT c.id AS card_id, c.name, c.face_value, c.default_price, p.price AS special_price,
           COALESCE(p.price, c.default_price) AS effective_price
    FROM card_types c LEFT JOIN customer_card_prices p ON p.card_type_id = c.id AND p.customer_id = ?
    WHERE c.active = 1 ORDER BY c.face_value`).all(customerId));
});

app.delete("/api/customers/:customerId/card-prices/:cardId", (req, res) => {
  const r = db.prepare("DELETE FROM customer_card_prices WHERE customer_id = ? AND card_type_id = ?")
    .run(Number(req.params.customerId), Number(req.params.cardId));
  res.json({ ok: true, removed: r.changes > 0 });
});

// ============ المبيعات ============
app.get("/api/sales", (req, res) => {
  const params = [];
  let sql = dateFilter(req, "created_at", "SELECT * FROM sales WHERE 1=1", params);
  if (["cards", "products", "mixed"].includes(req.query.type)) { sql += " AND sale_type = ?"; params.push(req.query.type); }
  if (req.query.q) {
    sql += " AND (invoice_no LIKE ? OR COALESCE(customer_name,'') LIKE ? OR COALESCE(notes,'') LIKE ?)";
    const like = `%${req.query.q}%`; params.push(like, like, like);
  }
  res.json(db.prepare(sql + " ORDER BY id DESC").all(...params));
});

app.get("/api/product-sales", (req, res) => {
  const params = [];
  const sql = dateFilter(req, "s.created_at", `
    SELECT i.id, i.sale_id, s.invoice_no, s.created_at, s.customer_name, i.item_name, i.quantity,
           i.unit_price, i.unit_cost, i.line_total, (i.unit_price - i.unit_cost) * i.quantity AS profit
    FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE i.item_type = 'product'`, params);
  res.json(db.prepare(sql + " ORDER BY s.id DESC, i.id").all(...params));
});

function loadSale(id) {
  const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
  if (!sale) return null;
  sale.items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id").all(id);
  sale.remaining = sale.total - sale.paid;
  return sale;
}

app.get("/api/sales/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!validId(id)) return res.status(400).json({ error: "رقم الفاتورة غير صالح" });
  const sale = loadSale(id);
  if (!sale) return res.status(404).json({ error: "الفاتورة غير موجودة" });
  res.json(sale);
});

app.put("/api/sales/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const sale = validId(id) && db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "الفاتورة غير موجودة" });
    const paid = req.body.paid === undefined || req.body.paid === "" ? sale.paid : Number(req.body.paid);
    if (!validMoney(paid) || paid > sale.total) return res.status(400).json({ error: "المبلغ المدفوع لا يمكن أن يتجاوز إجمالي الفاتورة" });
    db.prepare("UPDATE sales SET paid = ?, notes = ?, customer_name = ? WHERE id = ?").run(
      paid,
      req.body.notes === undefined ? sale.notes : (String(req.body.notes).trim() || null),
      req.body.customer_name === undefined ? sale.customer_name : (String(req.body.customer_name).trim() || null), id);
    logAction("update", "sale", id, { paid });
    res.json(loadSale(id));
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.delete("/api/sales/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const sale = validId(id) && db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
    if (!sale) return res.status(404).json({ error: "الفاتورة غير موجودة" });
    db.transaction(() => {
      const items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(id);
      for (const it of items) {
        if (it.item_type === "product" && it.item_ref) {
          db.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").run(it.quantity, it.item_ref);
        }
      }
      db.prepare("DELETE FROM sales WHERE id = ?").run(id);
      logAction("delete", "sale", id, { invoice_no: sale.invoice_no, total: sale.total });
    })();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

app.post("/api/sales", (req, res) => {
  try {
    const items = req.body.items;
    const paid = Number(req.body.paid || 0);
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "أضف أصنافًا إلى الفاتورة أولًا" });
    if (!validMoney(paid)) return res.status(400).json({ error: "المبلغ المدفوع غير صالح" });

    const wanted = new Map(); // لمنع تجاوز المخزون عند تكرار نفس المنتج
    const normalized = items.map((item) => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      const type = item.item_type === "product" ? "product" : "card";
      const ref = Number(item.item_ref);
      if (!validId(ref) || !Number.isSafeInteger(quantity) || quantity <= 0 || !validMoney(unitPrice)) {
        throw new Error("بيانات أحد الأصناف غير صالحة");
      }
      const source = type === "product"
        ? db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(ref)
        : db.prepare("SELECT * FROM card_types WHERE id = ? AND active = 1").get(ref);
      if (!source) throw new Error("أحد الأصناف غير موجود أو غير نشط");
      if (type === "product") {
        const total = (wanted.get(ref) || 0) + quantity;
        wanted.set(ref, total);
        if (source.stock < total) throw new Error(`الكمية المتوفرة من ${source.name} غير كافية`);
      }
      const lineTotal = quantity * unitPrice;
      if (!Number.isSafeInteger(lineTotal)) throw new Error("إجمالي أحد الأصناف كبير جدًا");
      return {
        item_type: type, item_ref: ref, card_type_id: type === "card" ? ref : null,
        item_name: source.name, quantity, unit_price: unitPrice,
        unit_cost: type === "product" ? source.cost_price : 0, line_total: lineTotal
      };
    });

    const total = normalized.reduce((s, i) => s + i.line_total, 0);
    if (!Number.isSafeInteger(total) || paid > total) {
      return res.status(400).json({ error: "المبلغ المدفوع لا يمكن أن يتجاوز إجمالي الفاتورة" });
    }

    const createSale = db.transaction(() => {
      const invoiceNo = `AF-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const saleType = normalized.every((i) => i.item_type === "card") ? "cards"
        : normalized.every((i) => i.item_type === "product") ? "products" : "mixed";
      const r = db.prepare(
        "INSERT INTO sales (invoice_no, sale_type, total, paid, notes, customer_name) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(invoiceNo, saleType, total, paid, String(req.body.notes || "").trim() || null,
        String(req.body.customer_name || "").trim() || null);
      const saleId = Number(r.lastInsertRowid);
      const insertItem = db.prepare(`INSERT INTO sale_items
        (sale_id, card_type_id, item_name, quantity, unit_price, line_total, item_type, item_ref, unit_cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const i of normalized) {
        insertItem.run(saleId, i.card_type_id, i.item_name, i.quantity, i.unit_price, i.line_total, i.item_type, i.item_ref, i.unit_cost);
        if (i.item_type === "product") db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(i.quantity, i.item_ref);
      }
      logAction("create", "sale", saleId, { invoiceNo, total, paid });
      return saleId;
    });

    res.status(201).json(loadSale(createSale()));
  } catch (e) {
    console.error("خطأ حفظ البيع:", e);
    res.status(400).json({ error: errorMessage(e) });
  }
});

// ============ المنتجات ============
app.get("/api/products", (req, res) => {
  res.json(db.prepare("SELECT * FROM products WHERE active = 1 ORDER BY id DESC").all());
});

function readProduct(body) {
  const name = String(body.name || "").trim();
  const sku = String(body.sku || "").trim() || null;
  const cost = Number(body.cost_price), price = Number(body.sell_price), stock = Number(body.stock);
  if (!name || !validMoney(cost) || !validMoney(price) || !Number.isSafeInteger(stock) || stock < 0) {
    throw new Error("تحقق من اسم المنتج وأسعاره وكميته");
  }
  return { name, sku, cost, price, stock };
}

app.post("/api/products", (req, res) => {
  try {
    const p = readProduct(req.body);
    const r = db.prepare("INSERT INTO products (name, sku, cost_price, sell_price, stock) VALUES (?, ?, ?, ?, ?)")
      .run(p.name, p.sku, p.cost, p.price, p.stock);
    logAction("create", "product", r.lastInsertRowid, { name: p.name });
    res.status(201).json(db.prepare("SELECT * FROM products WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? "رمز المنتج مكرر" : e.message });
  }
});

app.put("/api/products/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!validId(id) || !db.prepare("SELECT id FROM products WHERE id = ? AND active = 1").get(id)) {
      return res.status(404).json({ error: "المنتج غير موجود" });
    }
    const p = readProduct(req.body);
    db.prepare("UPDATE products SET name = ?, sku = ?, cost_price = ?, sell_price = ?, stock = ? WHERE id = ?")
      .run(p.name, p.sku, p.cost, p.price, p.stock, id);
    logAction("update", "product", id, { name: p.name });
    res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(id));
  } catch (e) {
    res.status(400).json({ error: /UNIQUE/.test(e.message) ? "رمز المنتج مكرر" : e.message });
  }
});

app.delete("/api/products/:id", (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("UPDATE products SET active = 0, sku = NULL WHERE id = ? AND active = 1").run(id);
  if (!r.changes) return res.status(404).json({ error: "المنتج غير موجود" });
  logAction("delete", "product", id, {});
  res.json({ ok: true });
});

// ============ الديون ============
app.get("/api/debts", (req, res) => {
  const params = [];
  let sql = dateFilter(req, "created_at", "SELECT *, amount - paid_amount AS remaining FROM debts WHERE 1=1", params);
  if (["receivable", "payable"].includes(req.query.direction)) { sql += " AND direction = ?"; params.push(req.query.direction); }
  if (req.query.status === "open") sql += " AND amount > paid_amount";
  if (req.query.status === "closed") sql += " AND amount = paid_amount";
  res.json(db.prepare(sql + " ORDER BY id DESC").all(...params));
});

app.get("/api/debts/:id/payments", (req, res) => {
  res.json(db.prepare("SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY id").all(Number(req.params.id)));
});

function readDebt(body) {
  const person = String(body.person_name || "").trim();
  const reason = String(body.reason || "").trim();
  const amount = Number(body.amount);
  if (!person || !reason || !["receivable", "payable"].includes(body.direction) ||
      !Number.isSafeInteger(amount) || amount <= 0) throw new Error("تحقق من بيانات الدين والمبلغ");
  return { person, reason, amount, direction: body.direction, notes: String(body.notes || "").trim() || null };
}

app.post("/api/debts", (req, res) => {
  try {
    const d = readDebt(req.body);
    const paid = req.body.paid_amount === "" || req.body.paid_amount == null ? 0 : Number(req.body.paid_amount);
    if (!validMoney(paid) || paid > d.amount) return res.status(400).json({ error: "المبلغ المسدّد غير صالح" });
    const id = db.transaction(() => {
      const r = db.prepare("INSERT INTO debts (person_name, direction, reason, amount, paid_amount, notes) VALUES (?, ?, ?, ?, ?, ?)")
        .run(d.person, d.direction, d.reason, d.amount, paid, d.notes);
      if (paid > 0) db.prepare("INSERT INTO debt_payments (debt_id, amount, notes) VALUES (?, ?, 'دفعة عند التسجيل')").run(r.lastInsertRowid, paid);
      logAction("create", "debt", r.lastInsertRowid, { person: d.person, amount: d.amount });
      return r.lastInsertRowid;
    })();
    res.status(201).json(db.prepare("SELECT *, amount - paid_amount AS remaining FROM debts WHERE id = ?").get(id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put("/api/debts/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const debt = validId(id) && db.prepare("SELECT * FROM debts WHERE id = ?").get(id);
    if (!debt) return res.status(404).json({ error: "الدين غير موجود" });
    const d = readDebt(req.body);
    if (d.amount < debt.paid_amount) return res.status(400).json({ error: "المبلغ أقل من المسدّد سابقًا" });
    db.prepare("UPDATE debts SET person_name = ?, direction = ?, reason = ?, amount = ?, notes = ? WHERE id = ?")
      .run(d.person, d.direction, d.reason, d.amount, d.notes, id);
    logAction("update", "debt", id, d);
    res.json(db.prepare("SELECT *, amount - paid_amount AS remaining FROM debts WHERE id = ?").get(id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/debts/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT id FROM debts WHERE id = ?").get(id)) return res.status(404).json({ error: "الدين غير موجود" });
  db.transaction(() => {
    db.prepare("DELETE FROM debt_payments WHERE debt_id = ?").run(id);
    db.prepare("DELETE FROM debts WHERE id = ?").run(id);
    logAction("delete", "debt", id, {});
  })();
  res.json({ ok: true });
});

app.post("/api/debts/:id/payments", (req, res) => {
  try {
    const id = Number(req.params.id), amount = Number(req.body.amount);
    const debt = db.prepare("SELECT * FROM debts WHERE id = ?").get(id);
    if (!debt) return res.status(404).json({ error: "الدين غير موجود" });
    const remaining = debt.amount - debt.paid_amount;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) return res.status(400).json({ error: "مبلغ التسديد غير صالح" });
    db.transaction(() => {
      db.prepare("INSERT INTO debt_payments (debt_id, amount, notes) VALUES (?, ?, ?)").run(id, amount, req.body.notes || null);
      db.prepare("UPDATE debts SET paid_amount = paid_amount + ? WHERE id = ?").run(amount, id);
      logAction("payment", "debt", id, { amount });
    })();
    res.json(db.prepare("SELECT *, amount - paid_amount AS remaining FROM debts WHERE id = ?").get(id));
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

// ============ المصروفات ============
app.get("/api/expenses", (req, res) => {
  const params = [];
  let sql = dateFilter(req, "created_at", "SELECT * FROM expenses WHERE 1=1", params);
  if (req.query.category) { sql += " AND category = ?"; params.push(req.query.category); }
  res.json(db.prepare(sql + " ORDER BY id DESC").all(...params));
});

function readExpense(body) {
  const description = String(body.description || "").trim();
  const amount = Number(body.amount);
  if (!description || !Number.isSafeInteger(amount) || amount <= 0) throw new Error("تحقق من وصف المصروف ومبلغه");
  return { description, amount, category: String(body.category || "other"), notes: String(body.notes || "").trim() || null };
}

app.post("/api/expenses", (req, res) => {
  try {
    const e = readExpense(req.body);
    const r = db.prepare("INSERT INTO expenses (description, amount, category, notes) VALUES (?, ?, ?, ?)")
      .run(e.description, e.amount, e.category, e.notes);
    logAction("create", "expense", r.lastInsertRowid, { description: e.description, amount: e.amount });
    res.status(201).json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(r.lastInsertRowid));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put("/api/expenses/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!db.prepare("SELECT id FROM expenses WHERE id = ?").get(id)) return res.status(404).json({ error: "المصروف غير موجود" });
    const e = readExpense(req.body);
    db.prepare("UPDATE expenses SET description = ?, amount = ?, category = ?, notes = ? WHERE id = ?")
      .run(e.description, e.amount, e.category, e.notes, id);
    logAction("update", "expense", id, e);
    res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(id));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/expenses/:id", (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
  if (!r.changes) return res.status(404).json({ error: "المصروف غير موجود" });
  logAction("delete", "expense", id, {});
  res.json({ ok: true });
});

// ============ التقارير ============
app.get("/api/reports/summary", (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-CA");
    const from = req.query.from || today, to = req.query.to || today;
    const sales = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total, COALESCE(SUM(paid),0) AS paid
      FROM sales WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)`).get(from, to);
    const split = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN i.item_type='card' THEN i.line_total END),0) AS cards_total,
             COALESCE(SUM(CASE WHEN i.item_type='product' THEN i.line_total END),0) AS products_total,
             COALESCE(SUM(CASE WHEN i.item_type='product' THEN (i.unit_price - i.unit_cost) * i.quantity END),0) AS products_profit
      FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE date(s.created_at) >= date(?) AND date(s.created_at) <= date(?)`).get(from, to);
    const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM expenses
      WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)`).get(from, to);
    const debts = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='receivable' THEN amount - paid_amount ELSE 0 END),0) AS receivable,
      COALESCE(SUM(CASE WHEN direction='payable' THEN amount - paid_amount ELSE 0 END),0) AS payable FROM debts`).get();
    res.json({ sales: { ...sales, ...split }, expenses, debts });
  } catch (e) { res.status(500).json({ error: errorMessage(e) }); }
});

// ============ النسخ الاحتياطي ============
app.post("/api/backup", async (req, res) => {
  try {
    const file = `alalam-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
    await db.backup(path.join(BACKUP_DIR, file));
    logAction("backup", "database", file, {});
    res.json({ ok: true, file, filename: file, message: "تم إنشاء النسخة الاحتياطية" });
  } catch (e) {
    console.error("خطأ النسخ الاحتياطي:", e);
    res.status(500).json({ error: "تعذر إنشاء النسخة الاحتياطية" });
  }
});

app.get("/api/backups", (req, res) => {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^alalam-backup-[\w.-]+\.db$/.test(f))
    .map((f) => ({ file: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.time - a.time);
  res.json(files);
});

app.get("/api/backups/:file", (req, res) => {
  const f = req.params.file;
  if (!/^alalam-backup-[\w.-]+\.db$/.test(f) || !fs.existsSync(path.join(BACKUP_DIR, f))) {
    return res.status(404).json({ error: "النسخة غير موجودة" });
  }
  res.download(path.join(BACKUP_DIR, f));
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use((req, res) => res.status(404).json({ error: "المسار غير موجود", path: req.originalUrl }));
app.use((error, req, res, next) => {
  console.error("خطأ في الطلب:", error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "حدث خطأ في الخادم" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Alalam Phone server: http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Backups: ${BACKUP_DIR}`);
});
