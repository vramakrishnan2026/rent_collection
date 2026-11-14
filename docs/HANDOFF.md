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

## Built on 13 Nov 2026 (from the Cloudflare AI discussion)

1. **Direct UPI + payment screenshots** (`worker/screenshot.ts`).
   - **UPI ID:** set in Settings with the PIN, because it decides where money goes. It's stored in `settings` as `upi_id` and `upi_name`. When it's set, rent messages offer it; with no Razorpay, the messages are UPI-only (a `payment_links` row with status `upi` tracks "sent").
   - **Screenshots are uploaded by the owner only.** The payment is recorded **straight away** only when every check passes:
     - the payment succeeded,
     - the tenant is clear (the one chosen, a full-name match on the payer, or a unique amount match),
     - the UTR is new (it's saved as the payment reference),
     - it went to the owner's UPI ID (when that's set and shown),
     - the date isn't in the future and is less than 90 days old.
   - Otherwise the Record payment form opens pre-filled, with the reasons. Screenshots go to Drive under *Payment screenshots/<month>* when Drive is linked.
2. **Ask about your rent** (`worker/ask.ts`, dashboard, owner only).
   - The app builds a read-only JSON summary with every figure pre-computed by `rent.ts` and `db.ts` rules: per unit, per floor, totals and by month.
   - Llama 3.3 70B (falling back to Llama 4 Scout) only finds and phrases the answer, and is told to say when the data doesn't have it.
   - No phone numbers, addresses or IDs are included. The conversation history is kept only on the page, for that visit.

## Deleting a past tenant (built 14 Nov 2026)

The owner had added test tenants and moved them out, and there was no way to remove them (the existing delete is only for a current tenant with no payments). They asked how to remove them from the database; a button was built instead of hand-editing D1.

- Unit page › Past tenants › **🔒 Delete** (PIN). The question names the tenant, their dates and the total of the payments that will go.
- Removes the tenancy with its payments, people and rent links (`deletePastTenancy` in `worker/db.ts`). Dashboard totals change accordingly.
- **Only a tenant who has moved out**, so one tap can't wipe someone living there.
- ID photos in Google Drive are not touched; an ID upload stays with the unit.

## Unit page keeps itself up to date (built 13 Nov 2026)

The owner noticed that after sending a rent link from a unit page, a payment didn't show until they left the page and came back. The webhook had recorded it; only the screen was stale. They asked what a refresh would cost and chose the light version:

- The unit page re-reads itself **every 30 seconds only while it is on screen and has an unpaid rent link**, plus **once when you return to the tab or close a form**.
- It stops when you go to another page, switch tabs or close the app, and it goes quiet 30 minutes after the page last changed. There is no background checking.
- It pauses while a form is open, so nothing typed is lost, and redraws only if something changed (keeping the scroll position). A new payment shows "Payment received ✓".
- It only re-reads the unit from the app's own database (one small request). It does not ask Razorpay; the **Check** button still does that.
- Code: `refreshUnit` in `public/app.js`.

## PIN sign-in for a visitor (built 13 Nov 2026, for Razorpay's KYC website check)

Razorpay asked to sign in and see inside the app. Two decisions by the owner, in order:

1. First a **demo login on a copy with made-up names** was built and deployed (`/auth/demo`, a second D1 database). Razorpay then said they check **the app's own login only**, so the owner had it **removed the same day**.
2. In its place: a **PIN box on the real sign-in page, next to Google sign-in**. Asked whether the PIN should open a made-up copy or the real data, the owner chose **the real data**.

Because it opens real tenants to someone outside, it is kept tight (`worker/pinsignin.ts`):

- **Off by default.** Settings › PIN sign-in, the owner's PIN to turn on. The PIN box is only on the sign-in page while it is on.
- **Its own 8-digit random PIN**, shown in Settings. Never the owner's PIN for locked actions.
- **View only.** A PIN sign-in gets the owner's screens, but `index.ts` refuses every POST, PUT and DELETE for it (and the Drive routes). That covers recording, editing, deleting, sending links, the backup, the AI questions and settings. *This was not asked for by the owner; it was added as the safe default and they were told. If Razorpay needs to try an action, ask the owner before loosening it.*
- **Guessing:** five wrong PINs in a row pause PIN sign-in for 15 minutes.
- **Ending it:** stops after 14 days; Turn off stops it at once; New PIN signs earlier visitors out. A PIN sign-in lasts 12 hours.
- After KYC is approved: **turn PIN sign-in off**.

Left over from the demo: the D1 database **`rent_collection_demo`** still exists in Cloudflare (the app no longer uses it). The owner can delete it under Storage & Databases › D1. Migration `0010` removes the two demo settings.

## Wanted next (discussed 13 Nov 2026, not built)

- **Change rent from a date.** Today **Edit details** replaces `base_rent` for the whole tenancy, including months already charged. The owner wants to set, say, "₹12,000 from 1 Jan 2027": earlier months keep the old rent, and the 5% cycle continues from the new rent. This probably needs a `rent_changes` table that `rent.ts` reads.
- **Bulk edit.** A table of all units for editing many at once: new rent plus from-date, next 5% date, deposit, phone. Show a summary of the changes, ask for the PIN once, and make it easy on a laptop (cards on a phone). The owner may do this later with Claude.
- (Fixed already: the Ask chat once replied as though it had changed rents. It's now explicitly read-only, and the server adds a notice to any change request.)

- **Option: Razorpay Subscriptions (UPI AutoPay) as a hybrid.** The owner tested a ₹1 monthly subscription on 13 Nov 2026.
  - Drawbacks, which are why it isn't a replacement:
    - Autopay without approving each debit only works up to ₹15,000 for rent.
    - It costs about 0.9–0.99% on top of 2% + GST.
    - It charges a fixed amount, which doesn't fit part months, 5% increases or catching up arrears.
    - Tenants must agree, and can cancel any time.
    - It ends after a set number of cycles.
  - If wanted: the app creates each willing tenant's subscription with the right amount and marks months paid from `subscription.charged` webhooks. Everyone else stays on links or direct UPI.

Also mentioned, lower priority:
- Reading PDFs (ID PDFs and rental agreements, via Workers AI's document-to-text conversion).
- Matching bank credit-alert emails (Cloudflare Email Workers).
- Nepali voice notes from Anita (Whisper).
- A monthly summary on the 11th.

## Working on it

- `npm test` runs the rules and API tests (Node 22+, no install).
- `npm run preview` starts a local copy with made-up tenants: open `http://localhost:8787/dev/login?as=owner` (or `?as=anita`).
- `npm run lint` type-checks.
- A schema change means adding a new file in `migrations/` (the next is `0011_…`). Never edit an applied migration.
- Commit to `main` only when it's ready: every push deploys live.
