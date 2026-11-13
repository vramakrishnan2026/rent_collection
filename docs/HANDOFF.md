# Handoff: Challaghatta Rent

Everything decided while building this app (Nov 2026), so work can continue without the original chat.
`README.md` has the feature list and one-time setup; this file has the **why**, the **current state** and **what's open**.

## What it is

A private rent-collection app for **Challaghatta Home**: 24 units, numbered G1–G6, F1–F6, S1–S6 and T1–T6 (Ground, First, Second, Third). More units can be added in the app.

- Users:
  - **The owner** (full app).
  - **Anita**, who looks after the building. Her screens are rent status and Add ID only. Call her **Anita** everywhere: never "security", "guard" or "helper".
- It's a standalone app modelled on the owner's **Finance Tracker** (repo `vramakrishnan2026/Finance-tracker`). It shares the same Cloudflare account, but has its own repo, its own Gmail sign-in and its own database. Muthu (on the Finance Tracker) never sees it.
- **Stack:** a Cloudflare Worker, D1 (SQLite), plain HTML/CSS/JS with no build step, Workers AI, Google Drive and Razorpay. Everything runs on free tiers except the Razorpay fees.

## Live setup (as of 13 Nov 2026)

| Thing | Value / state |
|---|---|
| GitHub repo | `vramakrishnan2026/rent_collection`. Pushes to `main` auto-deploy. |
| Cloudflare Worker | `rent-collection` on the Finance Tracker's account → `https://rent-collection.kvinay14.workers.dev` |
| Build settings | Build command empty; deploy command `npm run deploy` (it applies D1 migrations, then deploys); root `/` |
| D1 database | `rent_collection`, id `d7b71d89-7cc4-441b-92df-554ba2558641` (in `wrangler.jsonc`) |
| Secrets set | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAILS` |
| Google | A separate Google Cloud project on the owner's app Gmail. The consent screen was published (In production) after filling in Branding. Redirect URIs are `/auth/callback` and `/api/drive/callback`. |
| Razorpay | **Test mode**; KYC is under process. The test webhook was being set up: the webhook list was empty when last checked, so check it exists. |
| Workers AI | `ai` binding in `wrangler.jsonc` (reads ID cards) |

Secret **values** are only in Cloudflare, never in this repo.

## Decisions (and why)

**Rent**
- **Post-paid, by calendar month** (the 1st to the month's end). A part month (move-in or move-out) is **rent ÷ 30 × days stayed**, a fixed ÷30 as the owner asked ("1st to 30th").
- **Due by the 10th of the next month.** It counts as pending (red for Anita) from the 11th.
- **5% increase every 11 months, compounding, rounded to the rupee.** The new rent applies **from the 1st after the 11 months complete**. For example, moving in on 12 Nov 2026 means the new rent starts on 1 Nov 2027.
- **Part payments** are allowed and clear the oldest month first. A part-paid month still counts as pending once it's due.
- **Deposit (advance)** is a refundable deposit, held separately. At **move-out, one month's rent is kept for maintenance** (editable), plus any rent still owed if the owner ticks that, and the rest is refunded.
- **Tenants who lived here before the app** ("Already living here before this app"):
  - Their move-in date is backdated, and the rent entered is their **current** rent.
  - Charging starts from **"Charge rent from"** (the 1st of next month by default; the owner started using the app from **1 Dec 2026**). Nothing earlier is asked for.
  - **The next 5% increase date is entered per tenant**, then repeats every 11 months.
- **Rent-free unit** (Anita's) needs the **PIN** to turn on.

**Payments and links**
- **Razorpay only** ("Option B"): rent links are Razorpay Payment Links, and the owner records other payments by hand. A webhook plus a daily 9 AM check marks payments as paid.
- Links ask for **every unpaid month that has ended**. The current month is collected after it ends.
- **Sending:** free, from the owner's own WhatsApp. The app can't press Send in WhatsApp, so the owner taps Send each time.
  - The **Send links** screen steps through each tenant: tap WhatsApp, Send, come back, and the next tenant is ready.
  - **Web push reminders** go out at 9 AM on the **1st** ("links ready") and the **3rd** (if any are left).
  - Automatic SMS from Razorpay and the paid WhatsApp Business API were discussed and **not chosen**.
- Razorpay costs about **2% + 18% GST (2.36%)**. That includes UPI, which isn't free through a gateway, and UPI above ₹2,000 carries MDR from 15 Oct 2026.
  - Cashfree has a 0%-up-to-₹20-lakh new-merchant offer.
  - A free direct-UPI option (paid to the owner's own account and marked by hand) was offered.
  - Neither has been built yet.
- Building an actual payment gateway isn't possible: RBI requires authorisation and a net worth of ₹15–25 crore.

**IDs**
- Photos are stored in the **owner's Google Drive**, under `Challaghatta Home › Tenant IDs › <unit>`, using the `drive.file` scope.
- The app reads and stores the **ID type, name and address only**. **ID numbers and dates of birth are never stored**, and anything that looks like one is stripped.
- The reader is **Llama 4 Scout on Workers AI** (it runs on Cloudflare, under this account, and isn't used for training), falling back to Llama 3.2 Vision, then to reading printed lines with layout rules for Aadhaar, PAN, DL, Voter ID and passport.
- Each person can have a **front and a back photo**. A back photo (address only) sent within 15 minutes of the front is paired with it.
- **Matching:** a card attaches to a person automatically only on a **full-name match**, because a shared first name was a real bug (Suresh Kumar ≠ Suresh Gowda).
- **Duplicates:** if the person already has an ID, both are kept and the new one waits for review (**Use this one** or **Keep current**).
- **Anita's uploads are one-way:**
  - She reviews the photo, then taps Submit. After that she can't delete, replace or see it.
  - Her screens are in **Nepali by default**, with an English switch, and her home screen has a step-by-step guide.
  - **The Nepali text needs checking by a native speaker.**
- **The owner can start a new tenant from an ID photo**: the name is read and pre-filled.
- While an ID uploads, **the screen greys out with a spinner**. It gives up after 90 seconds.

**Access**
- **The owner** signs in with Google (`OWNER_EMAILS`).
- **Anita needs no Gmail.** The owner taps **Add a phone** (no PIN) to get a one-time 6-digit code. It works once, lasts 24 hours, and gives a 400-day sign-in on that phone. Ten wrong codes cancel all open codes.
- **The owner PIN** (`OWNER_PIN`, default **1234**) is checked on the server and protects:
  - Making a unit rent-free.
  - Deleting a payment and deleting test payments.
  - Removing a phone.
  - Linking or unlinking Google Drive.
  - Downloading the backup.

## Open / next

1. **Razorpay KYC.** When it's approved, switch to live keys, add the webhook again in Live mode, then go to Settings › Delete test payments.
2. **Check the Razorpay test webhook exists**, with events `payment_link.paid`, `.cancelled` and `.expired`, and that the same secret is in `RAZORPAY_WEBHOOK_SECRET`.
3. **Anita's phone:** pair it (Settings › Anita's phone › Add a phone), and turn on the owner's reminders (Settings › Reminders on this phone).
4. **Check ID reading on real cards.** Settings › Reading IDs shows what the reader last replied, with digits hidden. It was rebuilt after a plain Aadhaar wasn't read, and hasn't been confirmed on a real card yet.
5. **Get a native speaker to check the Nepali.**
6. **Ideas offered but not built:**
   - A free direct-UPI option alongside the Razorpay link.
   - Switching to Cashfree.
   - Automatic matching of bank credit-alert emails.
   - Kannada or Hindi for Anita.

## Next features the owner liked (not built yet)

These come from a discussion of Cloudflare AI features on 13 Nov 2026.

1. **Reading payment screenshots, plus direct UPI.**
   - Add a free "pay by UPI to the owner's account" option alongside the Razorpay link (no gateway fee).
   - When a tenant sends a UPI payment screenshot, the owner (and maybe Anita) uploads it. The vision model already used for IDs (Llama 4 Scout on Workers AI) reads the amount, date, UTR/reference and payer. The app then matches the tenant and records the payment (method `upi`, UTR as the reference).
   - Same approach as the IDs: guard against duplicates (the same UTR twice), and send anything unclear to review instead of guessing.
   - **Needs:** the UPI ID the rent should go to.
2. **Asking the data questions** (chat on the dashboard, owner only).
   - Examples: "Who's more than 2 months behind?", "How much did the First floor pay this year?", "When is F3's next increase?"
   - The model must only **read**, and work through the app's existing rules (`worker/rent.ts` and `db.ts`), with no raw database access, so answers match the screens.

Also mentioned, lower priority:
- Reading PDFs (ID PDFs and rental agreements, via Workers AI's document-to-text conversion).
- Matching bank credit-alert emails (Cloudflare Email Workers).
- Nepali voice notes from Anita (Whisper).
- A monthly summary on the 11th.

## Working on it

- `npm test` runs the rules and API tests (Node 22+, no install).
- `npm run preview` starts a local copy with made-up tenants: open `http://localhost:8787/dev/login?as=owner` (or `?as=anita`).
- `npm run lint` type-checks.
- A schema change means adding a new file in `migrations/` (the next is `0010_…`). Never edit an applied migration.
- Commit to `main` only when it's ready: every push deploys live.
