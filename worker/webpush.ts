import type { D1Database } from './env';

// Free browser push notifications (the Web Push standard), done with the built-in WebCrypto:
//  - VAPID (RFC 8292): the app's own key pair identifies it to the phone's push service.
//    The keys are created on first use and kept in the settings table, so there's nothing to set up.
//  - Message encryption (RFC 8291, "aes128gcm"): only the subscribed phone can read the message.

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const fromB64url = (s: string): Bytes => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Bytes;
};

const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// ---------- VAPID keys ----------

const VAPID_KEY = 'vapid_keys';

export interface VapidKeys {
  publicKey: string; // base64url, uncompressed P-256 point (what the browser needs)
  privateJwk: JsonWebKey;
}

export async function getVapidKeys(db: D1Database): Promise<VapidKeys> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(VAPID_KEY).first<{ value: string }>();
  if (row) return JSON.parse(row.value);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const keys: VapidKeys = {
    publicKey: b64url((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  };
  // If two requests race, keep whichever was saved first.
  await db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind(VAPID_KEY, JSON.stringify(keys)).run();
  const saved = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(VAPID_KEY).first<{ value: string }>();
  return JSON.parse(saved!.value);
}

async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string) {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
  );
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto gives the raw r||s signature that ES256 JWTs use.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ---------- message encryption (RFC 8291) ----------

async function hkdf(salt: Bytes, ikm: ArrayBuffer | Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

export async function encryptPayload(payload: string, p256dh: string, auth: string): Promise<Bytes> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);

  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, local.privateKey, 256);

  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const cek = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: aes128gcm\0')), 16);
  const nonce = await hkdf(salt, ikm, concat(enc.encode('Content-Encoding: nonce\0')), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concat(enc.encode(payload), new Uint8Array([2])); // 0x02 = last (and only) record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plaintext));

  const rs = new Uint8Array(new ArrayBuffer(4));
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// ---------- sending ----------

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Sends one notification. Returns 'gone' when the phone has unsubscribed (the row should be deleted). */
export async function sendPush(
  sub: Subscription,
  message: { title: string; body: string; url?: string; tag?: string },
  keys: VapidKeys,
  subject: string
): Promise<'ok' | 'gone' | 'error'> {
  try {
    const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(sub.endpoint, keys, subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(24 * 3600),
        Urgency: 'high',
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) {
      console.error('Push failed', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return 'error';
    }
    return 'ok';
  } catch (e) {
    console.error('Push failed', e);
    return 'error';
  }
}
