# CLAUDE.md — YourEdge Project Guide

## What This Is

YourEdge is a lead capture and CRM platform built for trade shows (currently the **National Home Show 2026** in Toronto). It gives booth vendors a branded CRM page where visitors scan a QR code to submit their info, and vendors get a real-time lead dashboard.

The business model: the basic lead capture CRM is **free**. Data enrichment (property intelligence on each lead) and automated follow-ups (SMS, email) are **paid upsells**.

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS (no frameworks, no build step)
- **Hosting:** Vercel (static files + serverless functions)
- **Database:** Supabase (PostgreSQL via REST API)
- **Domain:** weareyouredge.com

## Project Structure

```
youredge/
├── index.html              # Marketing homepage
├── product.html            # Product/features page
├── services.html           # Services page
├── audit.html              # Home audit landing page
├── book.html               # Booking page
├── contact.html            # Contact page
├── security.html           # Security info page
├── privacy.html            # Privacy policy
├── terms.html              # Terms of service
├── samplecrm.html          # THE CRM — serves ALL vendor dashboards + QR intake
├── admin.html              # Admin panel — vendor directory, contacts, add vendors
├── vercel.json             # Vercel routing config
├── package.json            # Minimal (just dotenv devDep)
├── vendors.json            # Static vendor list (backup/reference)
├── api/
│   ├── add-vendor.js       # Create new vendor (generates slug + 6-digit PIN)
│   ├── save-contact.js     # Save/update vendor contact info to DB
│   ├── get-contacts.js     # Fetch all vendor contacts (admin use)
│   └── verify-pin.js       # Verify vendor's 6-digit PIN for CRM access
└── enrichment/
    ├── watcher.js           # Background script: auto-enriches leads via HouseSigma
    ├── prefetch-all.js      # Batch prefetch enrichment data
    ├── all-enrichment-data.json  # Cached enrichment data
    └── (various test/debug scripts)
```

## How Routing Works

`vercel.json` has two rewrites:
1. `/admin` → `admin.html`
2. `/:slug` → `samplecrm.html` (catch-all)

This means **every vendor gets a unique URL** like `weareyouredge.com/bath-fitter`. They all serve the same `samplecrm.html`, which reads the URL slug, fetches that vendor's data from Supabase, and customizes the page.

**IMPORTANT:** Do NOT add `cleanUrls: true` to vercel.json — it breaks the catch-all routing and causes 404s on vendor slugs.

## The CRM (samplecrm.html)

This is the biggest file (~138KB, all inline HTML/CSS/JS). It serves two completely different views:

### View 1: QR Intake Form (visitors)
- URL: `weareyouredge.com/vendor-slug?booth=vendor-slug`
- Shows a simple form: name, email, phone, address, interests, notes
- Submits lead data that appears in the vendor's dashboard
- **No PIN required** — visitors must be able to submit without friction

### View 2: Vendor Dashboard (vendors)
- URL: `weareyouredge.com/vendor-slug`
- **PIN-protected** — 6-digit PIN gate before access
- PIN verified server-side via `/api/verify-pin`, cached in localStorage
- Shows: lead cards, lead scoring, analytics, QR code generator, export

### Key CRM Concepts

**Demo Leads:** Each vendor CRM comes with 8 sample leads pre-populated with realistic data matching the vendor's industry. The `categoryLeadData` object maps ~70 vendor categories to industry-specific interests and notes.

**Enrichment (upsell):** Demo leads have mock enrichment data (property type, year built, home value, sqft, etc.). Some fields are visible as a teaser, others are blurred/locked with an "Unlock with YourEdge Enrichment" CTA. Real leads do NOT get enrichment by default — it's a paid feature toggled on the backend.

**Lead Scoring:** Hot/Warm/Cold badges based on home age + matching interests. Visible on free tier as a teaser.

**Data Storage:** Leads are stored in localStorage keyed by `ye-leads-{vendor-slug}`. Voice notes are persisted as base64 in the lead object.

**Multi-tab Detection:** A `storage` event listener detects when another tab modifies leads and shows a reload banner.

### Key Functions in samplecrm.html
- `createLeadCard(l)` — renders a single lead card with all sections
- `renderLeads()` — renders all lead cards with current filter/sort
- `renderAnalytics()` — analytics tab with charts and ROI calculator
- `persistLeads()` — saves leads array to localStorage
- `loadLocalLeads()` — loads leads from localStorage, restores voice note blobs
- `customizeDemoLeads(category)` — swaps demo lead interests/notes for vendor's industry
- `submitPin()` / `unlockDashboard()` — PIN gate flow
- `renderQR()` — generates QR code for the vendor's intake URL

## Admin Panel (admin.html)

Password-protected panel at `weareyouredge.com/admin`.

### Features
- **Vendor directory** — searchable list of all 124+ vendors
- **Industry filter** — dropdown to filter by category
- **Contacted filter** — filter to vendors you've saved contact info for
- **Contact capture** — manual input (name, title, email, phone, notes) per vendor
- **Business card photo** — snap/upload, auto-resized to 600px/40% JPEG
- **Add vendor** — creates new vendor in Supabase, auto-generates CRM page + PIN
- **PIN display** — each vendor's 6-digit PIN visible with copy button
- **URL copy** — one-tap copy of vendor's CRM URL

### Auth Flow
1. User enters password on lock screen
2. Password verified via `/api/add-vendor` (piggybacks on existing endpoint)
3. Stored in `localStorage` as `ye-admin-pw`
4. All API calls include password in request body

### Contact Persistence
- Contacts saved to **both** localStorage (immediate cache) and Supabase `vendor_contacts` table
- On load, contacts fetched from DB via `/api/get-contacts`
- If DB save fails (e.g. large photo), falls back to saving text fields without photo

## API Endpoints (Vercel Serverless Functions)

All endpoints are in `api/`. They're plain Node.js modules (no framework).

### POST /api/add-vendor
- **Auth:** `password` in body must match `ADMIN_PASSWORD` env var
- **Body:** `{ name, category, booth, password }`
- **Action:** Slugifies name, generates 6-digit PIN, inserts into `vendors` table
- **Returns:** Created vendor object (including slug and pin)

### POST /api/save-contact
- **Auth:** `password` in body
- **Body:** `{ password, vendor_slug, contact_name, contact_title, contact_email, contact_phone, notes, card_photo }`
- **Action:** Verifies vendor exists, upserts into `vendor_contacts` table
- **Note:** `card_photo` is base64 — can be large. If save fails, admin.html retries without photo.

### POST /api/get-contacts
- **Auth:** `password` in `x-admin-password` header (NOT query params)
- **Returns:** All contacts as `{ "vendor-slug": { contact_name, ... }, ... }`

### POST /api/verify-pin
- **Auth:** None (the PIN itself is the auth)
- **Body:** `{ slug, pin }`
- **Action:** Checks PIN against `vendors` table. If vendor has no PIN, allows access.
- **Returns:** `{ ok: true }` or 401

## Database (Supabase)

### Table: `vendors`
```sql
slug        text PRIMARY KEY
name        text NOT NULL
category    text
booth       text
pin         text          -- 6-digit PIN for CRM access
demo        boolean
```

### Table: `vendor_contacts`
```sql
id            serial PRIMARY KEY
vendor_slug   text UNIQUE NOT NULL
contact_name  text
contact_title text
contact_email text
contact_phone text
notes         text
card_photo    text          -- base64 data URI
updated_at    timestamptz
```

### Connection Details
- **URL:** `https://oyeedqoecsbtixiodhyp.supabase.co`
- **Anon key** (read-only, safe for frontend): `sb_publishable_E0-8ppn-ZfRqEa5GWicwtQ_uW_dK1fL`
- **Service key** (full access, server-side only): stored in Vercel env var `SUPABASE_SERVICE_KEY`

## Environment Variables (Vercel)

Set via `npx vercel env add <NAME> production`:
- `ADMIN_PASSWORD` — password for admin panel + API auth
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key (server-side only)

To pull env vars locally: `npx vercel env pull --environment production`

## Enrichment System

The enrichment watcher (`enrichment/watcher.js`) is a **local background script** — NOT deployed to Vercel. It:

1. Connects to a local Chrome instance via Puppeteer (remote debugging port 9222)
2. Finds open CRM tabs
3. Every 60s, checks for leads with addresses but no enrichment data
4. Searches HouseSigma's API for property data
5. Scrapes property details (type, age, value, sqft, photos, etc.)
6. Injects data back into the CRM page and persists to localStorage

**This is a paid upsell feature.** It only runs when explicitly started. Vendors never run it themselves.

To run: `cd enrichment && node watcher.js` (requires Chrome with `--remote-debugging-port=9222`)

## Deployment

```bash
# Commit
git add -A && git commit -m "description"

# Push + deploy
git push origin main
npx vercel --prod --yes
```

Deploy takes ~15 seconds. The site is aliased to `weareyouredge.com`.

**IMPORTANT:** Always get explicit approval before committing or deploying.

## Security Measures

- All HTML output escaped via `esc()` function (XSS prevention)
- Passwords checked server-side, never exposed in frontend
- API error details stripped from 500 responses (no stack traces to client)
- Google Maps API key restricted to domain + specific APIs only
- Business card photos auto-resized (600px, 40% quality) to prevent payload issues
- PIN verification is server-side (PIN not exposed in frontend fetches)
- `get-contacts` uses header auth only (no query param password)

## Common Tasks

### Add a new vendor manually
Go to admin panel → enter name + category → Create. Auto-generates slug, PIN, and CRM page.

### Change a vendor's PIN
Update directly in Supabase: `UPDATE vendors SET pin = '123456' WHERE slug = 'vendor-slug';`

### Modify demo lead data for a category
Edit the `categoryLeadData` object in `samplecrm.html`. Each category maps to `{ interests: [...8 arrays...], notes: [...8 strings...] }`.

### Add a new API endpoint
Create `api/endpoint-name.js` with `module.exports = async function handler(req, res) { ... }`. Vercel auto-routes it to `/api/endpoint-name`.

### Test locally
```bash
npx vercel dev    # runs dev server with serverless functions
# OR
npx serve .       # static only, no API endpoints
```

## Style Guide

- All frontend code is vanilla JS (no TypeScript, no React, no build step)
- CSS is inline in each HTML file (no external stylesheets)
- Dark theme: black background (#000), blue accent (#2563eb), Inter font
- Mobile-first responsive design
- No emojis in code unless user requests it
