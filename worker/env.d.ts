// Minimal Cloudflare runtime types used by the Worker
// (kept local so the project type-checks without @cloudflare/workers-types).

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<any>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai; // Cloudflare Workers AI: reads the name off tenant ID photos

  // Google sign-in (and Google Drive for tenant ID photos)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // Who may sign in, comma-separated Gmail addresses (secrets):
  OWNER_EMAILS?: string;     // the whole app
  SECURITY_EMAILS?: string;  // Anita (optional, if she uses Gmail): rent status and Add ID only

  // Razorpay (test keys start rzp_test_, live keys rzp_live_)
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;

  // Owner PIN for protected actions: making a unit rent-free, deleting payments (default 1234)
  OWNER_PIN?: string;
  RENT_FREE_PIN?: string; // older name, still honoured

  // Tests only: pretend today is this date (YYYY-MM-DD)
  TEST_TODAY?: string;

  // Optional: key for signing session cookies (defaults to one derived from GOOGLE_CLIENT_SECRET)
  SESSION_SECRET?: string;
}
