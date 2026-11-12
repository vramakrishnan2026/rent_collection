# Challaghatta Rent

Rent collection for **Challaghatta Home** (24 units: G1–G6, F1–F6, S1–S6, T1–T6). It runs free on Cloudflare: a Worker, a D1 database and a daily cron.

## What it does

- **Units:** you can add more at any time (Units › ＋). Any unit can be marked **rent-free**, such as the security guard's.
- **Tenants:** each unit records the move-in date, monthly rent, refundable deposit, WhatsApp/SMS number, and everyone living there. Each person's ID photo is saved to Google Drive. ID numbers are never stored.
- **Rent rules:**
  - Rent is due on the move-in day every month. If that day doesn't exist in a month (e.g. the 31st), it's due on the last day of that month.
  - Rent goes up **5% every 11 months**, compounding and rounded to the rupee. For ₹10,000: months 1–11 are ₹10,000, months 12–22 are ₹10,500, months 23–33 are ₹11,025.
  - Part payments are allowed. They clear the oldest month first, and a part-paid month still counts as pending.
- **Rent links:** tap **Send link** to create a Razorpay Payment Link for everything the tenant owes. If nothing is owed, the link is for next month's rent. Then tap **WhatsApp** or **SMS** to send it from your phone, with the message ready. When the tenant pays, Razorpay's webhook records the payment. A 9 AM daily check catches anything the webhook missed.
- **Dashboard:**
  - Collected this month (MTD) and this financial year (YTD, April to March)
  - Pending amount and how many tenants owe
  - Deposits held, occupancy and the monthly rent total
  - A due-vs-collected chart for each month of the year
- **Adding IDs (security guard):** the guard picks the unit, takes a photo of the ID (or chooses a photo or PDF), checks it, then taps **Submit**. Submitting is one-way: she can't delete, replace or view IDs afterwards.
  - The photo goes to Drive under the unit. Cloudflare Workers AI reads only the printed name.
  - If the name matches someone listed in that unit in full, the photo is attached to them automatically.
  - Otherwise it waits under **New IDs from security** on the unit's page (the dashboard shows which units), where you attach it to a person, add a new person, or dismiss it.
  - Her screens can switch between English and Nepali.
- **Security guard (no Gmail needed):** in **Settings › Security phones › Add a phone** you get a one-time 6-digit code, valid for 24 hours, plus a link to WhatsApp to her.
  - The code signs in that phone only, for 400 days, and it sees only rent status and Add ID.
  - **Remove** signs the phone out at once. Ten wrong codes cancel every open code.
  - On Android, she opens the link in Chrome, then ⋮ › Add to Home screen.
  - On iPhone, she adds the app to the Home Screen *first*, opens it, taps "Security guard? Enter your code" and types the code. iPhones keep a separate sign-in for Home Screen apps.
  - A guard with a Gmail account can still be listed in `SECURITY_EMAILS` instead. Each unit shows **Paid**, or **Pending** in red with the number of months and "Remind tenant". He never sees amounts.
- **Moving out:** record the move-out date (no rent falls due after it), then the deposit refund. A tenant who moved out still owing stays on the pending list.

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
| `SECURITY_EMAILS` | optional: a guard's Gmail (or pair her phone with a code instead) |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | from step 3 (`rzp_test_…` for now) |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret from step 3 |
| `SESSION_SECRET` | optional: any long random string |

### 5. In the app

1. Sign in, then go to **☰ More › Link Google Drive** (for ID photos).
2. Open the security guard's unit and tick **Rent-free unit**.
3. Add tenants from **Units**.

## Going live (after Razorpay KYC)

1. In Razorpay **Live mode**, generate live API keys and add the same webhook again. Live mode has its own webhooks.
2. Replace `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` with the live values.
3. Go to **☰ More › Delete test payments**.

Until Razorpay is connected, the Send link buttons show a message instead, and you can still **Record payment** by hand (UPI, cash or bank transfer).

## Code map

- `worker/index.ts`: the routes, plus the cron that runs at 9 AM India time
- `worker/auth.ts`: Google sign-in and the owner and security roles
- `worker/rent.ts`: the rent rules (due dates, 5% increases, oldest-first allocation, financial year)
- `worker/db.ts`: units, tenancies, people, payments, the dashboard and the security view
- `worker/razorpay.ts`: payment links, the WhatsApp/SMS message, the webhook (signature-checked) and the daily check
- `worker/devices.ts`: security phones paired with one-time codes (no Gmail)
- `worker/ids.ts`: the guard's Add ID uploads, name reading (Workers AI), matching to people, and attach/dismiss
- `worker/drive.ts`: ID photos to Drive (`drive.file` scope: the app sees only its own files)
- `public/`: the app (plain HTML, CSS and JavaScript, no build step)
- `migrations/`: the database schema and the 24 starting units

Commands:

- `npm test`: runs the rent rules and API tests (Node 22+, no install needed)
- `npm run lint`: type check
