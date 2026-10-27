require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const nodemailer = require("nodemailer");

const app = express();
const production = process.env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "3mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });
const cartLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const jwtSecret = process.env.JWT_SECRET;
if (production && (!jwtSecret || jwtSecret.length < 32)) {
  console.error("JWT_SECRET must be set to a random value of at least 32 characters in production.");
  process.exit(1);
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '', price_kobo BIGINT NOT NULL CHECK (price_kobo >= 0),
      sale_price_kobo BIGINT CHECK (sale_price_kobo IS NULL OR sale_price_kobo >= 0),
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      sizes TEXT[] NOT NULL DEFAULT '{}', active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cart_events (
      id BIGSERIAL PRIMARY KEY, product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),
      size TEXT NOT NULL DEFAULT '', visitor_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notified_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY, reference TEXT UNIQUE NOT NULL, customer_email TEXT NOT NULL,
      items JSONB NOT NULL, total_kobo BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT UNIQUE;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS city_state TEXT NOT NULL DEFAULT '';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS landmark TEXT NOT NULL DEFAULT '';
  `);
  if (adminEmail && process.env.ADMIN_PASSWORD) {
    const existing = await pool.query("SELECT id FROM admins WHERE email=$1", [adminEmail]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [adminEmail, hash]);
      console.log("Initial admin created for", adminEmail);
    }
  }
}
function customerAuth(req, res, next) {
  const token = req.cookies.sync_customer;
  if (!token) return res.status(401).json({ error: "Please sign in to view your account." });
  try {
    const data = jwt.verify(token, jwtSecret);
    if (data.role !== "customer" || !data.id) throw new Error("Invalid customer session");
    req.customer = { id: Number(data.id), email: data.email };
    next();
  } catch {
    res.clearCookie("sync_customer", { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
    return res.status(401).json({ error: "Your session expired. Please sign in again." });
  }
}
function optionalCustomerAuth(req, res, next) {
  const token = req.cookies.sync_customer;
  if (token) {
    try {
      const data = jwt.verify(token, jwtSecret);
      if (data.role === "customer" && data.id) req.customer = { id: Number(data.id), email: data.email };
    } catch {}
  }
  next();
}
function adminAuth(req, res, next) {
  const token = req.cookies.sync_admin;
  if (!token) return res.status(401).json({ error: "Admin login required." });
  try {
    const data = jwt.verify(token, jwtSecret);
    if (data.role !== "admin" || data.email !== adminEmail) throw new Error("Invalid role");
    req.admin = data;
    next();
  } catch {
    res.clearCookie("sync_admin");
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}
const moneyToKobo = n => Math.round(Number(n) * 100);
const productView = p => ({
  id: p.id, name: p.name, description: p.description, imageUrl: p.image_url,
  price: Number(p.price_kobo) / 100,
  salePrice: p.sale_price_kobo == null ? null : Number(p.sale_price_kobo) / 100,
  stock: p.stock, sizes: p.sizes || [], active: p.active,
  createdAt: p.created_at, updatedAt: p.updated_at
});
function validateProduct(b) {
  if (!b || typeof b.name !== "string" || !b.name.trim()) return "Product name is required.";
  if (!Number.isFinite(Number(b.price)) || Number(b.price) < 0) return "Price must be zero or more.";
  if (!Number.isInteger(Number(b.stock)) || Number(b.stock) < 0) return "Stock must be a whole number of zero or more.";
  if (b.salePrice !== null && b.salePrice !== undefined && b.salePrice !== "" &&
      (!Number.isFinite(Number(b.salePrice)) || Number(b.salePrice) < 0 || Number(b.salePrice) > Number(b.price))) {
    return "Sale price must be between zero and the original price.";
  }
  if (b.imageUrl) {
    const remoteImage = /^https?:\/\//i.test(b.imageUrl);
    const uploadedImage = /^data:image\/(jpeg|png|webp|gif);base64,[a-z0-9+/=]+$/i.test(b.imageUrl);
    if (!remoteImage && !uploadedImage) return "Choose a valid image file or use an HTTPS image URL.";
    if (b.imageUrl.length > 2_000_000) return "Image is too large after optimization. Choose a smaller image.";
  }
  return null;
}
async function sendCartEmail(event) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, ADMIN_NOTIFICATION_EMAIL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ADMIN_NOTIFICATION_EMAIL) return false;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  await transporter.sendMail({
    from: SMTP_USER, to: ADMIN_NOTIFICATION_EMAIL,
    subject: `SYNCOUTFITS cart activity: ${event.product_name}`,
    text: `A customer added an item to their cart.\nProduct: ${event.product_name}\nQuantity: ${event.quantity}\nSize: ${event.size || "Not selected"}\nTime: ${new Date(event.created_at).toISOString()}\nVisitor reference: ${event.visitor_id}\n\nThis is cart activity, not a confirmed order.`
  });
  return true;
}
app.get("/api/health", async (req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, database: "connected" }); }
  catch { res.status(503).json({ ok: false, database: "unavailable" }); }
});
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products WHERE active=TRUE ORDER BY created_at DESC");
    res.json(result.rows.map(productView));
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not load products." }); }
});
app.post("/api/customer/signup", loginLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 120);
    const email = String(req.body.email || "").trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || "");
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: "Enter your name, a valid email, and a password of at least 10 characters." });
    }
    const hash = await bcrypt.hash(password, 12);
    const saved = await pool.query(
      "INSERT INTO customers(full_name,email,password_hash) VALUES($1,$2,$3) RETURNING id,full_name,email",
      [name, email, hash]
    );
    const customer = saved.rows[0];
    const token = jwt.sign({ role: "customer", id: customer.id, email: customer.email }, jwtSecret, { expiresIn: "14d" });
    res.cookie("sync_customer", token, { httpOnly: true, secure: production, sameSite: "lax", maxAge: 14 * 24 * 60 * 60 * 1000, path: "/" });
    res.status(201).json({ ok: true, customer: { id: customer.id, name: customer.full_name, email: customer.email } });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    console.error("Customer signup failed:", e.message);
    res.status(500).json({ error: "Could not create your account. Please try again." });
  }
});
app.post("/api/customer/login", loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const found = await pool.query("SELECT id,full_name,email,password_hash FROM customers WHERE email=$1", [email]);
    if (!found.rowCount || !(await bcrypt.compare(password, found.rows[0].password_hash))) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    const customer = found.rows[0];
    const token = jwt.sign({ role: "customer", id: customer.id, email: customer.email }, jwtSecret, { expiresIn: "14d" });
    res.cookie("sync_customer", token, { httpOnly: true, secure: production, sameSite: "lax", maxAge: 14 * 24 * 60 * 60 * 1000, path: "/" });
    res.json({ ok: true, customer: { id: customer.id, name: customer.full_name, email: customer.email } });
  } catch (e) { console.error("Customer login failed:", e.message); res.status(500).json({ error: "Could not sign in. Please try again." }); }
});
app.post("/api/customer/logout", (req, res) => {
  res.clearCookie("sync_customer", { httpOnly: true, secure: production, sameSite: "lax", path: "/" });
  res.json({ ok: true });
});
app.get("/api/customer/me", customerAuth, async (req, res) => {
  const r = await pool.query("SELECT id,full_name,email,created_at FROM customers WHERE id=$1", [req.customer.id]);
  if (!r.rowCount) return res.status(401).json({ error: "Account not found. Please sign in again." });
  res.json({ customer: { id: r.rows[0].id, name: r.rows[0].full_name, email: r.rows[0].email, createdAt: r.rows[0].created_at } });
});
app.get("/api/customer/orders", customerAuth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT order_number,customer_name,items,total_kobo,status,created_at FROM orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.customer.id]
    );
    res.json(r.rows.map(o => ({ orderNumber: o.order_number, customerName: o.customer_name,
      items: typeof o.items === "string" ? JSON.parse(o.items) : o.items,
      total: Number(o.total_kobo) / 100, status: o.status, createdAt: o.created_at })));
  } catch (e) { console.error("Customer order history failed:", e.message); res.status(500).json({ error: "Could not load your order history." }); }
});
app.post("/api/admin/login", loginLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!adminEmail || !process.env.ADMIN_PASSWORD && !(await pool.query("SELECT id FROM admins WHERE email=$1", [email])).rowCount) {
      // Admin account may already exist after the initial bootstrap.
    }
    const found = await pool.query("SELECT * FROM admins WHERE email=$1", [email]);
    if (!found.rowCount || email !== adminEmail || !(await bcrypt.compare(password, found.rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid admin email or password." });
    }
    const token = jwt.sign({ role: "admin", email }, jwtSecret, { expiresIn: "8h" });
    res.cookie("sync_admin", token, { httpOnly: true, secure: production, sameSite: "strict", maxAge: 8 * 60 * 60 * 1000, path: "/" });
    res.json({ ok: true, email });
  } catch (e) { console.error(e); res.status(500).json({ error: "Login failed." }); }
});
app.post("/api/admin/logout", (req, res) => {
  res.clearCookie("sync_admin", { httpOnly: true, secure: production, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});
app.get("/api/admin/me", adminAuth, (req, res) => res.json({ email: req.admin.email }));
app.get("/api/admin/products", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT * FROM products ORDER BY created_at DESC");
  res.json(r.rows.map(productView));
});
app.post("/api/admin/products", adminAuth, async (req, res) => {
  const b = req.body, error = validateProduct(b);
  if (error) return res.status(400).json({ error });
  try {
    const r = await pool.query(
      `INSERT INTO products(name,description,image_url,price_kobo,sale_price_kobo,stock,sizes,active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.name.trim(), String(b.description || ""), String(b.imageUrl || ""), moneyToKobo(b.price),
       b.salePrice === "" || b.salePrice == null ? null : moneyToKobo(b.salePrice),
       Number(b.stock), Array.isArray(b.sizes) ? b.sizes.map(String).slice(0,20) : [],
       b.active !== false]
    );
    res.status(201).json(productView(r.rows[0]));
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not save product." }); }
});
app.put("/api/admin/products/:id", adminAuth, async (req, res) => {
  const b = req.body, error = validateProduct(b);
  if (error) return res.status(400).json({ error });
  try {
    const r = await pool.query(
      `UPDATE products SET name=$1,description=$2,image_url=$3,price_kobo=$4,sale_price_kobo=$5,
       stock=$6,sizes=$7,active=$8,updated_at=NOW() WHERE id=$9 RETURNING *`,
      [b.name.trim(), String(b.description || ""), String(b.imageUrl || ""), moneyToKobo(b.price),
       b.salePrice === "" || b.salePrice == null ? null : moneyToKobo(b.salePrice),
       Number(b.stock), Array.isArray(b.sizes) ? b.sizes.map(String).slice(0,20) : [],
       b.active !== false, Number(req.params.id)]
    );
    if (!r.rowCount) return res.status(404).json({ error: "Product not found." });
    res.json(productView(r.rows[0]));
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not update product." }); }
});
app.delete("/api/admin/products/:id", adminAuth, async (req, res) => {
  const r = await pool.query("UPDATE products SET active=FALSE,updated_at=NOW() WHERE id=$1 RETURNING id", [Number(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: "Product not found." });
  res.json({ ok: true });
});
app.post("/api/orders", cartLimiter, optionalCustomerAuth, async (req, res) => {
  const b = req.body || {};
  const customer = {
    name: String(b.name || "").trim().slice(0,120),
    phone: String(b.phone || "").trim().slice(0,40),
    email: String(b.email || "").trim().toLowerCase().slice(0,160),
    address: String(b.address || "").trim().slice(0,300),
    cityState: String(b.cityState || "").trim().slice(0,120),
    landmark: String(b.landmark || "").trim().slice(0,200)
  };
  if (!customer.name || !customer.phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) ||
      !customer.address || !customer.cityState || !customer.landmark) {
    return res.status(400).json({ error: "Please complete all customer and delivery fields with a valid email." });
  }
  if (req.customer && req.customer.email !== customer.email) {
    return res.status(400).json({ error: "Use the email address connected to your signed-in account." });
  }
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) {
    return res.status(400).json({ error: "Your bag is empty or contains too many items." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderItems = [];
    let totalKobo = 0;
    for (const item of b.items) {
      const id = Number(item.id), qty = Number(item.qty), size = String(item.size || "").trim().slice(0,30);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        throw Object.assign(new Error("One of the item quantities is invalid."), { status: 400 });
      }
      const pr = await client.query("SELECT * FROM products WHERE id=$1 AND active=TRUE FOR UPDATE", [id]);
      if (!pr.rowCount) throw Object.assign(new Error("A product in your bag is no longer available."), { status: 409 });
      const p = pr.rows[0];
      if (qty > p.stock) throw Object.assign(new Error(p.name + " does not have enough stock for that quantity."), { status: 409 });
      if (size && p.sizes?.length && !p.sizes.includes(size)) throw Object.assign(new Error("Please select a valid size for " + p.name + "."), { status: 400 });
      const unitKobo = p.sale_price_kobo == null ? Number(p.price_kobo) : Number(p.sale_price_kobo);
      totalKobo += unitKobo * qty;
      orderItems.push({ id:p.id, name:p.name, size, qty, unitPrice:Number(unitKobo)/100, lineTotal:Number(unitKobo*qty)/100 });
      await client.query("UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2", [qty,id]);
    }
    const orderNumber = String(crypto.randomInt(10000000000000, 99999999999999));
    const saved = await client.query(
      `INSERT INTO orders(order_number,reference,customer_id,customer_email,customer_name,customer_phone,delivery_address,city_state,landmark,items,total_kobo,status)
       VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received') RETURNING id,order_number,status,created_at`,
      [orderNumber,req.customer ? req.customer.id : null,customer.email,customer.name,customer.phone,customer.address,customer.cityState,customer.landmark,JSON.stringify(orderItems),totalKobo]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok:true, orderNumber:saved.rows[0].order_number, status:saved.rows[0].status, total:totalKobo/100, customerName:customer.name });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Order creation failed:", e.message);
    res.status(e.status || (e.code === "23505" ? 409 : 500)).json({ error: e.status ? e.message : e.code === "23505" ? "Please submit again to generate a new order number." : "Could not submit your order. Please try again." });
  } finally { client.release(); }
});
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT id,order_number,customer_name,customer_phone,customer_email,delivery_address,city_state,landmark,items,total_kobo,status,created_at FROM orders ORDER BY created_at DESC LIMIT 200");
    res.json(r.rows.map(o => ({ ...o, total:Number(o.total_kobo)/100, items:typeof o.items === "string" ? JSON.parse(o.items) : o.items })));
  } catch (e) { console.error(e); res.status(500).json({ error:"Could not load orders." }); }
});
app.get("/api/admin/cart-events", adminAuth, async (req, res) => {
  const r = await pool.query("SELECT id,product_id,product_name,quantity,size,visitor_id,created_at,notified_at FROM cart_events ORDER BY created_at DESC LIMIT 100");
  res.json(r.rows);
});
app.post("/api/cart-events", cartLimiter, async (req, res) => {
  const productId = Number(req.body.productId), quantity = Number(req.body.quantity);
  if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return res.status(400).json({ error: "Invalid product or quantity." });
  }
  const visitorId = String(req.body.visitorId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0,80);
  if (!visitorId) return res.status(400).json({ error: "Missing visitor reference." });
  try {
    const p = await pool.query("SELECT id,name,stock FROM products WHERE id=$1 AND active=TRUE", [productId]);
    if (!p.rowCount) return res.status(404).json({ error: "Product not found." });
    if (p.rows[0].stock < quantity) return res.status(409).json({ error: "Not enough stock available." });
    const r = await pool.query(
      "INSERT INTO cart_events(product_id,product_name,quantity,size,visitor_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [productId, p.rows[0].name, quantity, String(req.body.size || "").slice(0,30), visitorId]
    );
    let emailSent = false;
    try { emailSent = await sendCartEmail(r.rows[0]); if (emailSent) await pool.query("UPDATE cart_events SET notified_at=NOW() WHERE id=$1", [r.rows[0].id]); }
    catch (mailErr) { console.error("Cart email failed:", mailErr.message); }
    res.status(201).json({ ok: true, emailNotificationConfigured: emailSent });
  } catch (e) { console.error(e); res.status(500).json({ error: "Could not record cart activity." }); }
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = Number(process.env.PORT || 3000);
initDb().then(() => app.listen(port, () => console.log(`SYNCOUTFITS listening on ${port}`)))
  .catch(err => { console.error("Startup failed:", err.message); process.exit(1); });
