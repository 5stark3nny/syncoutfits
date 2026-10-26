# SYNCOUTFITS

A black-and-white clothing storefront with an Express API, PostgreSQL-backed products, owner-only product administration, stock controls, sale pricing, and dashboard/email cart-activity notifications.

## What is implemented

- Responsive storefront and shopping bag/cart.
- Product catalogue backed by PostgreSQL.
- Admin sign-in, product creation/editing, stock management, original price and optional sale price.
- Admin-only product API routes protected by a signed, HTTP-only cookie.
- Cart events stored in PostgreSQL and displayed in the admin dashboard API.
- Optional SMTP email notifications when a shopper adds an item to their cart.
- Render deployment blueprint.

## Important limitations in this starter

- Checkout/payment processing is **not implemented yet**. The storefront explicitly says so; do not accept payments until a verified payment-provider flow and order fulfilment are added.
- Cart activity is a signal of interest, not a sale or reservation. It does not reserve stock.
- Product photos currently use image URLs. Use URLs for images you own or have permission to use. A future update can add secure image uploads.
- A dedicated visual admin dashboard is available at `/admin.html` after deployment.
- Configure SMTP to receive emails. Without SMTP, events are still saved and available from `GET /api/admin/cart-events`.
- This initial build creates the first admin from `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when that email does not already exist. Changing those environment variables later does not automatically reset the stored password.

## Run locally (beginner steps)

1. Install Node.js 20 or newer and PostgreSQL.
2. Create an empty database named `syncoutfits`.
3. Copy `.env.example` to `.env`.
4. Put your PostgreSQL connection string in `DATABASE_URL`, set a long random `JWT_SECRET`, and choose a strong `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters).
5. Open a terminal in this folder and run:
   ```bash
   npm install
   npm start
   ```
6. Open `http://localhost:3000`. The database tables are created on first start.

Never upload `.env` to GitHub. `.gitignore` excludes it.

## Deploy on GitHub + Render

### A. Create the GitHub repository

1. Sign in to GitHub and create a **new empty repository** named `syncoutfits` (do not add a README if you plan to upload this folder as-is).
2. Upload the contents of this folder to the repository root, or use GitHub Desktop to publish this project.
3. Check that `package.json`, `server.js`, `render.yaml`, and `public/` are at the repository root.

### B. Create PostgreSQL on Render

1. Sign in to Render and choose **New + → PostgreSQL**.
2. Name it `syncoutfits-db`. Choose a region close to the web service.
3. Create it and copy its **Internal Database URL** for a web service in the same Render region (use the External URL only if needed for local access).
4. Check the database plan's current cost, expiry and storage terms before relying on it for a real store. Free service availability and persistence terms can change.

### C. Deploy the web service

1. In Render choose **New + → Web Service**, connect your new `syncoutfits` repository.
2. Build command: `npm install`; Start command: `npm start`.
3. Add environment variables in Render → your service → Environment:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = Internal Database URL copied from Render PostgreSQL
   - `DATABASE_SSL` = `true`
   - `JWT_SECRET` = a long random secret (32+ characters)
   - `ADMIN_EMAIL` = your private admin email
   - `ADMIN_PASSWORD` = a strong unique password of at least 12 characters
   - `ADMIN_NOTIFICATION_EMAIL` = email where cart alerts should arrive
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` = your SMTP provider settings
4. Save environment variables and deploy. Visit `https://YOUR-SERVICE.onrender.com/api/health`; expect `{"ok":true,"database":"connected"}`.
5. Open the service URL to view the storefront.

### D. Configure email notifications

Use an SMTP service/provider you control. Copy its SMTP host, port, username and password/app-password into Render environment variables. For common submission ports, port 587 usually uses `SMTP_SECURE=false`; port 465 usually uses `SMTP_SECURE=true`. Follow your provider's current instructions. Do not place SMTP credentials in frontend files or GitHub.

### E. Test admin-only access

Admin API routes:
- `POST /api/admin/login` with JSON `{"email":"your-admin-email","password":"your-admin-password"}`
- `GET /api/admin/me`
- `GET /api/admin/products`
- `POST /api/admin/products`
- `PUT /api/admin/products/:id`
- `DELETE /api/admin/products/:id` (soft-deactivates product)
- `GET /api/admin/cart-events`

Login sets an HTTP-only cookie. Use an API client that retains cookies to test protected endpoints. Open `https://YOUR-SERVICE.onrender.com/admin.html` to use the admin dashboard.

## Product API payload example

```json
{
  "name": "SYNC Signature Tee",
  "description": "Black cotton tee with the white SYNC wordmark.",
  "imageUrl": "https://example.com/your-authorized-product-photo.jpg",
  "price": 15000,
  "salePrice": 12000,
  "stock": 25,
  "sizes": ["S", "M", "L", "XL"],
  "active": true
}
```

Prices are entered in naira and stored as integer kobo. The sale price must not exceed the original price.

## Before selling for real

Add a full admin dashboard UI, implement and verify payment-provider checkout and webhook signature validation, order creation, shipping details, privacy notice, backups, monitoring, and a stock reservation/decrement transaction. Test on staging first.
