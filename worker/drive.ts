import type { Env } from './env';
import { getPerson, getSetting, setPersonIdFile, setSetting, ValidationError } from './db.ts';
import { todayIST } from './rent.ts';

// Tenant ID photos go to Google Drive (same approach as the Finance Tracker's guest IDs):
//   Challaghatta Home › Tenant IDs › <unit> › "<unit> - <name> - <ID type> - <date>.jpg"
// Scope drive.file: the app can only see files and folders it created itself.
// ID numbers are never read or stored by the app.

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token';
export const ROOT = 'Challaghatta Home';
export const IDS = 'Tenant IDs';
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export const CONNECT_PATH = '/api/drive/connect';
export const CALLBACK_PATH = '/api/drive/callback';
export const STATE_COOKIE = 'cr_drive_state';

export const isConfigured = (env: Env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export function authUrl(env: Env, origin: string, state: string) {
  return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: origin + CALLBACK_PATH,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  })}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Google token error ${res.status}`);
  return data as { access_token: string; refresh_token?: string };
}

export async function handleCallback(env: Env, origin: string, code: string) {
  const tokens = await tokenRequest({
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: origin + CALLBACK_PATH,
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove the app from your Google account’s third-party access and link again.');
  }
  await setSetting(env.DB, REFRESH_TOKEN_KEY, tokens.refresh_token);
}

export async function status(env: Env) {
  return { configured: isConfigured(env), connected: Boolean(await getSetting(env.DB, REFRESH_TOKEN_KEY)) };
}

export async function disconnect(env: Env) {
  await setSetting(env.DB, REFRESH_TOKEN_KEY, null);
}

export async function accessToken(env: Env) {
  if (!isConfigured(env)) throw new ValidationError('Google isn’t set up on the server');
  const refresh = await getSetting(env.DB, REFRESH_TOKEN_KEY);
  if (!refresh) throw new ValidationError('Link Google Drive first (☰ › Google Drive)');
  return (
    await tokenRequest({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    })
  ).access_token;
}

async function driveFetch(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Google Drive error ${res.status}`);
  return data;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export async function ensureFolder(token: string, name: string, parentId?: string): Promise<string> {
  let query = `name = '${q(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  if (parentId) query += ` and '${q(parentId)}' in parents`;
  const found = await driveFetch(token, `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q: query, fields: 'files(id)', orderBy: 'createdTime' })}`);
  if (found.files?.length) return found.files[0].id;
  const created = await driveFetch(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }),
  });
  return created.id;
}

export async function uploadFile(token: string, meta: { name: string; mimeType: string; parents: string[] }, content: Blob) {
  const boundary = 'cr' + crypto.randomUUID().replace(/-/g, '');
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return driveFetch(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }) as Promise<{ id: string }>;
}

async function trashFile(token: string, fileId: string) {
  return driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Saves one person's ID photo (or PDF) to Drive, replacing their previous one. */
export async function uploadIdPhoto(env: Env, personId: string, request: Request) {
  const person = await getPerson(env.DB, personId);
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') throw new ValidationError('Choose a photo or PDF of the ID');
  if (!TYPES.includes(file.type)) throw new ValidationError('The ID must be a photo (JPG, PNG, WebP) or a PDF');
  if (file.size > MAX_BYTES) throw new ValidationError('That file is over 8 MB');

  const token = await accessToken(env);
  const root = await ensureFolder(token, ROOT);
  const ids = await ensureFolder(token, IDS, root);
  const unitFolder = await ensureFolder(token, person.unit_code, ids);
  const ext = file.type === 'application/pdf' ? 'pdf' : file.type.split('/')[1].replace('jpeg', 'jpg');
  const name = `${person.unit_code} - ${safeName(person.name)} - ${person.id_type || 'ID'} - ${todayIST()}.${ext}`;
  const uploaded = await uploadFile(token, { name, mimeType: file.type, parents: [unitFolder] }, file);

  if (person.drive_file_id) await trashFile(token, person.drive_file_id).catch((e) => console.error('Old ID not trashed', e));
  await setPersonIdFile(env.DB, person.id, uploaded.id, name);
  return { fileId: uploaded.id, name };
}
