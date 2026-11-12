# Challaghatta Rent

Rent collection for **Challaghatta Home** (24 units: G1–G6, F1–F6, S1–S6, T1–T6). It runs free on Cloudflare: a Worker, a D1 database and a daily cron.

## What it does

- **Units:** you can add more at any time (Units › ＋). Any unit can be marked **rent-free**, such as Anita's.
- **Tenants:** each unit records the move-in date, monthly rent, refundable deposit, WhatsApp/SMS number, and everyone living there. Each person's ID photo is saved to Google Drive. ID numbers are never stored.
- **Rent rules:**
  - Rent is **post-paid** and charged by **calendar month** (the 1st to the month's last day).
  - A part month (the move-in and move-out months) is charged as **monthly rent ÷ 30 × days stayed**. For example, moving in on 12 Nov at ₹9,000 means November is 19 days, ₹5,700.
  - Each month's rent is **due by the 10th of the next month**. After that it shows as pending, in red for Anita.
  - Rent goes up **5% from the 1st after every 11 months**, compounding and rounded to the rupee. For example, moving in on 12 Nov 2026 means the new rent starts on 1 Nov 2027.
  - Part payments are allowed and clear the oldest month first.
- **Moving out:** record the last day stayed, then settle the deposit.
  - **One month's rent is kept for maintenance** (you can change the amount), and any rent still owed is taken from the rest. The app records that as a payment.
  - The refund is what's left.
  - Anything the deposit doesn't cover stays on the pending list.
- **Rent links:** tap **Send link** to create a Razorpay Payment Link for every month that has ended and isn't paid (from the 1st, last month's rent can be collected). Then tap **WhatsApp** or **SMS** to send it from your phone, with the message ready. When the tenant pays, Razorpay's webhook records the payment. A 9 AM daily check catches anything the webhook missed.
- **Dashboard:**
  - Collected this month (MTD) and this financial year (YTD, April to March)
  - Pending amount and how many tenants owe
  - Deposits held, occupancy and the monthly rent total
  - A due-vs-collected chart for each month of the year
- **Adding IDs (Anita):** Anita picks the unit, takes a photo of the ID (or chooses a photo or PDF), checks it, then taps **Submit**. Submitting is one-way: she can't delete, replace or view IDs afterwards.
  - The photo goes to Drive under the unit. Cloudflare Workers AI reads the **ID type, the holder's name and the address**. It knows the Aadhaar, PAN, driving licence, Voter ID and passport layouts: for example the English name above "DOB" on Aadhaar, and "Name" rather than "Father's Name" or "S/D/W of".
  - **ID numbers and dates of birth are never stored**: anything that looks like one is removed before saving.
  - A back-of-Aadhaar photo (address, no name) sent within 15 minutes of the front is joined to the same person.
  - **Settings › Reading IDs** shows what the reader saw last time, to help when a card isn't read.
  - If the name matches someone listed in that unit in full, the photo is attached to them automatically.
  - Otherwise it waits under **New IDs to attach** on the unit's page (the dashboard shows which units), where you attach it to a person, add a new person, or dismiss it.
  - Her screens can switch between English and Nepali.
- **Anita's phone (no Gmail needed):** in **Settings › Anita's phone › Add a phone** you get a one-time 6-digit code, valid for 24 hours, plus a link to WhatsApp to Anita.
  - The code signs in that phone only, for 400 days, and it sees only rent status and Add ID.
  - **Remove** signs the phone out at once. Ten wrong codes cancel every open code.
  - On Android, she opens the link in Chrome, then ⋮ › Add to Home screen.
  - On iPhone, she adds the app to the Home Screen *first*, opens it, taps "Anita? Enter your code" and types the code. iPhones keep a separate sign-in for Home Screen apps.
  - If Anita uses a Gmail account, it can go in `SECURITY_EMAILS` instead. Each unit shows **Paid**, or **Pending** in red with the number of months and "Remind tenant". He never sees amounts.

## Setup (one time)

### 1. Cloudflare (same account as the Finance Tracker)

1. **Storage & Databases › D1 › Create**, named `rent_collection`. Its Database ID is already in `wrangler.jsonc` (`d7b71d89-…`).
2. **Workers & Pages › Create › Import a repository**, and pick this repo.
   - Build command: *(leave empty)*
   - Deploy command: `npm run deploy`. This applies database changes, then deploys.
   - Every push to `main` deploys from then on.
3. The app's address will be `https://rent-collection.<your-subdomain>.workers.dev`.

### 2. Google (sign-in and Drive, on the new Gmail account)

1. Signed in as the new Gmail, open console.cloud.google.com and create a project.
2. Set up the **OAuth consent screen**:
   - User type External
   - Scopes: `openid`, `email`, `profile`, `.../auth/drive.file`
   - Publish it (**In production**) so the sign-in doesn't expire every 7 days.
3. Go to **Credentials › Create OAuth client ID › Web application** and add two **Authorised redirect URIs**:
   - `https://rent-collection.<your-subdomain>.workers.dev/auth/callback`
   - `https://rent-collection.<your-subdomain>.workers.dev/api/drive/callback`

### 3. Razorpay (test mode first)

1. In the Razorpay Dashboard, switch to **Test mode**, then go to **Account & Settings › API Keys › Generate**.
2. Go to **Webhooks › Add new webhook**:
   - URL: `https://rent-collection.<your-subdomain>.workers.dev/api/razorpay/webhook`
   - Secret: make up a long random string.
   - Events: `payment_link.paid`, `payment_link.cancelled`, `payment_link.expired`

### 4. Secrets

Add these under Cloudflare › the Worker › **Settings › Variables and Secrets**. Always choose type **Secret**.

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from step 2 |
| `OWNER_EMAILS` | your Gmail (comma-separate to add more) |
| `SECURITY_EMAILS` | optional: Anita's Gmail (or pair her phone with a code instead) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | from step 3 (`rzp_test_…` for now) |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret from step 3 |
| `SESSION_SECRET` | optional: any long random string |
| `OWNER_PIN` | optional: the PIN for protected actions (making a unit rent-free, deleting payments). 1234 if not set |

### 5. In the app

1. Sign in, then go to **☰ More › Link Google Drive** (for ID photos).
2. Open Anita's unit and, under **Unit › Rent-free unit**, tap **🔒 Turn on** and enter the PIN.
3. Add tenants from **Units**.

## Going live (after Razorpay KYC)

1. In Razorpay **Live mode**, generate live API keys and add the same webhook again. Live mode has its own webhooks.
2. Replace `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` with the live values.
3. Go to **☰ More › Delete test payments**.

Until Razorpay is connected, the Send link buttons show a message instead, and you can still **Record payment** by hand (UPI, cash or bank transfer).

## Code map

- `worker/index.ts`: the routes, plus the cron that runs at 9 AM India time
- `worker/auth.ts`: Google sign-in and the owner and Anita's roles
- `worker/rent.ts`: the rent rules (due dates, 5% increases, oldest-first allocation, financial year)
- `worker/db.ts`: units, tenancies, people, payments, the dashboard and Anita's rent-status view
- `worker/razorpay.ts`: payment links, the WhatsApp/SMS message, the webhook (signature-checked) and the daily check
- `worker/devices.ts`: Anita's phone, paired with one-time codes (no Gmail)
- `worker/idread.ts`: reads ID type, name and address off Indian ID cards (layout rules, fallbacks, ID-number scrubbing)
- `worker/ids.ts`: Anita's Add ID uploads, name reading (Workers AI), matching to people, and attach/dismiss
- `worker/drive.ts`: ID photos to Drive (`drive.file` scope: the app sees only its own files)
- `public/`: the app (plain HTML, CSS and JavaScript, no build step)
- `migrations/`: the database schema and the 24 starting units

Commands:

- `npm test`: runs the rent rules and API tests (Node 22+, no install needed)
- `npm run lint`: type check
