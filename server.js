require("dotenv").config();
const express = require("express");
const path = require("path");
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
    CREATE TABLE IF NOT EXISTS store_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1), bank_name TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '', account_number TEXT NOT NULL DEFAULT '',
      delivery_fee_kobo BIGINT NOT NULL DEFAULT 0 CHECK (delivery_fee_kobo >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS customer_phone TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS delivery_city TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS delivery_state TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS delivery_landmark TEXT NOT NULL DEFAULT '', ADD COLUMN IF NOT EXISTS subtotal_kobo BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS delivery_fee_kobo BIGINT NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'bank_transfer', ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await pool.query("INSERT INTO store_settings(id) VALUES(1) ON CONFLICT (id) DO NOTHING");

  if (adminEmail && process.env.ADMIN_PASSWORD) {
    const existing = await pool.query("SELECT id FROM admins WHERE email=$1", [adminEmail]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await pool.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [adminEmail, hash]);
      console.log("Initial admin created for", adminEmail);
    }
  }
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
async function sendOrderEmail(order) {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, ADMIN_NOTIFICATION_EMAIL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !ADMIN_NOTIFICATION_EMAIL) return false;
  const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: SMTP_SECURE === "true", auth: { user: SMTP_USER, pass: SMTP_PASS } });
  await transporter.sendMail({
    from: SMTP_USER, to: ADMIN_NOTIFICATION_EMAIL,
    subject: "SYNCOUTFITS order received: " + order.reference,
    text: "A new order is awaiting bank-transfer payment verification.\nOrder: " + order.reference + "\nCustomer: " + order.customer_name + "\nEmail: " + order.customer_email + "\nPhone: " + order.customer_phone + "\nAddress: " + order.delivery_address + ", " + order.delivery_city + ", " + order.delivery_state + "\nLandmark: " + order.delivery_landmark + "\nTotal: NGN " + (Number(order.total_kobo)/100).toFixed(2) + "\nStatus: " + order.status + "\n\nVerify the credit in your own bank account before marking this order paid."
  });
  return true;
}
app.get("/api/store-settings", async (req, res) => {
  try {
    const r = await pool.query("SELECT bank_name,account_name,account_number,delivery_fee_kobo FROM store_settings WHERE id=1");
    const x = r.rows[0] || {};
    res.json({ bankName:x.bank_name||"", accountName:x.account_name||"", accountNumber:x.account_number||"", deliveryFee:Number(x.delivery_fee_kobo||0)/100 });
  } catch (e) { console.error(e); res.status(500).json({error:"Could not load checkout settings."}); }
});
app.post("/api/orders", cartLimiter, async (req, res) => {
  const b=req.body||{};
  const customer={name:String(b.name||"").trim().slice(0,120),email:String(b.email||"").trim().toLowerCase().slice(0,254),phone:String(b.phone||"").trim().slice(0,40),address:String(b.address||"").trim().slice(0,500),city:String(b.city||"").trim().slice(0,100),state:String(b.state||"").trim().slice(0,100),landmark:String(b.landmark||"").trim().slice(0,300)};
  if (!customer.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email) || !customer.phone || !customer.address || !customer.city || !customer.state || !customer.landmark) return res.status(400).json({error:"Complete all customer and delivery fields with a valid email."});
  if (!Array.isArray(b.items) || !b.items.length || b.items.length>30) return res.status(400).json({error:"Your bag is empty or contains too many different items."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const normalized=[]; let subtotal=0;
    for (const item of b.items) {
      const id=Number(item.id), qty=Number(item.qty), size=String(item.size||"").slice(0,30);
      if (!Number.isInteger(id)||id<1||!Number.isInteger(qty)||qty<1||qty>20) throw Object.assign(new Error("Invalid product quantity."),{status:400});
      const p=await client.query("SELECT * FROM products WHERE id=$1 AND active=TRUE FOR UPDATE",[id]);
      if (!p.rowCount) throw Object.assign(new Error("A product in your bag is no longer available. Refresh the store and try again."),{status:409});
      const product=p.rows[0];
      if (product.stock<qty) throw Object.assign(new Error("Not enough stock for "+product.name+". Available: "+product.stock+"."),{status:409});
      if (product.sizes && product.sizes.length && !product.sizes.includes(size)) throw Object.assign(new Error("Choose a valid size for "+product.name+"."),{status:400});
      const unit=Number(product.sale_price_kobo==null?product.price_kobo:product.sale_price_kobo);
      await client.query("UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2",[qty,id]);
      subtotal+=unit*qty;
      normalized.push({id:product.id,name:product.name,imageUrl:product.image_url,size,quantity:qty,unitPriceKobo:unit,lineTotalKobo:unit*qty});
    }
    const setting=await client.query("SELECT bank_name,account_name,account_number,delivery_fee_kobo FROM store_settings WHERE id=1");
    const cfg=setting.rows[0]||{};
    if (!cfg.bank_name||!cfg.account_name||! /^\d{10}$/.test(cfg.account_number||"")) throw Object.assign(new Error("The store's bank-transfer details are not configured yet. Please contact the store owner."),{status:503});
    const fee=Number(cfg.delivery_fee_kobo||0), total=subtotal+fee;
    const reference="SYNC-"+Date.now().toString(36).toUpperCase()+"-"+require("crypto").randomBytes(3).toString("hex").toUpperCase();
    const saved=await client.query("INSERT INTO orders(reference,customer_email,items,total_kobo,status,customer_name,customer_phone,delivery_address,delivery_city,delivery_state,delivery_landmark,subtotal_kobo,delivery_fee_kobo) VALUES($1,$2,$3,$4,'awaiting_payment',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",[reference,customer.email,JSON.stringify(normalized),total,customer.name,customer.phone,customer.address,customer.city,customer.state,customer.landmark,subtotal,fee]);
    await client.query("COMMIT");
    let emailSent=false; try { emailSent=await sendOrderEmail(saved.rows[0]); } catch (mailErr) { console.error("Order email failed:",mailErr.message); }
    res.status(201).json({ok:true,reference,status:"awaiting_payment",subtotal:subtotal/100,deliveryFee:fee/100,total:total/100,bank:{bankName:cfg.bank_name,accountName:cfg.account_name,accountNumber:cfg.account_number},emailNotificationConfigured:emailSent});
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(e.status||500).json({error:e.status?e.message:"Could not create your order. Please try again."});
    if (!e.status) console.error("Order creation failed:",e);
  } finally { client.release(); }
});
app.get("/api/admin/settings", adminAuth, async (req,res) => {
  const r=await pool.query("SELECT bank_name,account_name,account_number,delivery_fee_kobo FROM store_settings WHERE id=1"), x=r.rows[0]||{};
  res.json({bankName:x.bank_name||"",accountName:x.account_name||"",accountNumber:x.account_number||"",deliveryFee:Number(x.delivery_fee_kobo||0)/100});
});
app.put("/api/admin/settings", adminAuth, async (req,res) => {
  const b=req.body||{}, bankName=String(b.bankName||"").trim().slice(0,100), accountName=String(b.accountName||"").trim().slice(0,120), accountNumber=String(b.accountNumber||"").replace(/\s/g,""), fee=Number(b.deliveryFee);
  if (!bankName||!accountName||! /^\d{10}$/.test(accountNumber)) return res.status(400).json({error:"Enter bank name, account name, and a valid 10-digit Nigerian account number."});
  if (!Number.isFinite(fee)||fee<0||fee>1000000) return res.status(400).json({error:"Delivery fee must be between ₦0 and ₦1,000,000."});
  await pool.query("UPDATE store_settings SET bank_name=$1,account_name=$2,account_number=$3,delivery_fee_kobo=$4,updated_at=NOW() WHERE id=1",[bankName,accountName,accountNumber,moneyToKobo(fee)]);
  res.json({ok:true});
});
app.get("/api/admin/orders", adminAuth, async (req,res) => {
  const r=await pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200");
  res.json(r.rows.map(o=>({id:o.id,reference:o.reference,customerEmail:o.customer_email,customerName:o.customer_name,customerPhone:o.customer_phone,address:o.delivery_address,city:o.delivery_city,state:o.delivery_state,landmark:o.delivery_landmark,items:o.items,subtotal:Number(o.subtotal_kobo)/100,deliveryFee:Number(o.delivery_fee_kobo)/100,total:Number(o.total_kobo)/100,status:o.status,createdAt:o.created_at})));
});
app.put("/api/admin/orders/:id/status", adminAuth, async (req,res) => {
  const allowed=["awaiting_payment","payment_review","paid","processing","dispatched","delivered","cancelled"], status=String(req.body.status||"");
  if (!allowed.includes(status)) return res.status(400).json({error:"Invalid order status."});
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const current=await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE",[Number(req.params.id)]);
    if (!current.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({error:"Order not found."}); }
    const oldStatus=current.rows[0].status;
    if (["awaiting_payment","payment_review"].includes(status)&&["paid","processing","dispatched","delivered"].includes(oldStatus)) throw Object.assign(new Error("A paid or fulfilled order cannot be moved back to unpaid."),{status:409});
    if (["processing","dispatched","delivered"].includes(status)&&["awaiting_payment","payment_review"].includes(oldStatus)) throw Object.assign(new Error("Confirm payment first by setting status to Paid."),{status:409});
    if (oldStatus==="cancelled" && status!=="cancelled") throw Object.assign(new Error("A cancelled order cannot be reopened. Create a new order instead."),{status:409});
    if (status==="cancelled" && ["paid","processing","dispatched","delivered"].includes(oldStatus)) throw Object.assign(new Error("This order has been paid or fulfilled. Handle any refund or cancellation separately."),{status:409});
    if (status==="cancelled" && oldStatus!=="cancelled") {
      const lines=Array.isArray(current.rows[0].items)?current.rows[0].items:[];
      for (const line of lines) await client.query("UPDATE products SET stock=stock+$1,updated_at=NOW() WHERE id=$2",[Number(line.quantity)||0,Number(line.id)]);
    }
    const r=await client.query("UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status",[status,Number(req.params.id)]);
    await client.query("COMMIT");
    res.json({ok:true,id:r.rows[0].id,status:r.rows[0].status});
  } catch(e) {
    await client.query("ROLLBACK");
    res.status(e.status||500).json({error:e.status?e.message:"Could not update order status."});
    if (!e.status) console.error("Order status update failed:",e);
  } finally { client.release(); }
});
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
