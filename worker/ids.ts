import type { Env } from './env';
import { NotFoundError, ValidationError, getSetting, setSetting, str } from './db.ts';
import { IDS, ROOT, accessToken, ensureFolder, safeName, uploadFile } from './drive.ts';

// The "Add ID" screen (security guard and owner), same idea as the Finance Tracker's House Help:
// pick the unit, take a photo (or choose photos / PDFs). Each goes straight to Google Drive under
//   Challaghatta Home › Tenant IDs › <unit> › "<unit> - YYYY-MM-DD HH.MM - <names>.jpg"
// Cloudflare's AI reads ONLY the printed name(s). ID numbers are never read or stored.
// If a name matches someone listed in the unit, the photo is attached to them automatically;
// otherwise it waits on the unit's page for the owner.

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AI_CHARS = 1_500_000;
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const LICENCE_KEY = 'ai_licence_agreed';
const MAX_NAMES = 6;

// ---------- reading names (ported from the Finance Tracker) ----------

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(/[^\p{L}\p{M} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) return null;
  if (!/\p{L}{2}/u.test(s)) return null;
  if (['null', 'none', 'unknown', 'not readable', 'n a', 'na'].includes(s.toLowerCase())) return null;
  return s
    .split(' ')
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

function uniqueNames(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const n = cleanName(r);
    if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

const REFUSAL = /\b(sorry|cannot|can't|unable|not able|no names?|i |i'm|as an ai|here (is|are)|names? (is|are))\b/i;

export function namesFromReply(reply: any): string[] {
  const out = typeof reply === 'string' ? reply : reply?.response ?? reply?.result?.response ?? reply;
  const fromObject = (o: any): string[] | null => {
    if (!o || typeof o !== 'object') return null;
    if (Array.isArray(o)) return uniqueNames(o);
    if (Array.isArray(o.names)) return uniqueNames(o.names);
    if ('name' in o) return uniqueNames([o.name]);
    return null;
  };
  const direct = fromObject(out);
  if (direct) return direct;
  const text = typeof out === 'string' ? out : '';
  if (!text) return [];
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = fromObject(JSON.parse(json[0]));
      if (parsed) return parsed;
    } catch {
      /* fall through */
    }
  }
  const quoted = [...text.matchAll(/"?names?"?\s*[:=]\s*\[?\s*"([^"]+)"/gi)].map((m) => m[1]);
  if (quoted.length) return uniqueNames(quoted);
  const body = text.replace(/^[\s\S]*?\b(?:names?(?: printed)?(?: on (?:the|this|these) cards?)? (?:is|are)|names?:)\s*/i, '');
  const lines = body
    .split(/\n|;|\s+and\s+|\s+&\s+|,\s+(?=[A-Z])/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|card \d+:?)\s*/i, '').replace(/[."'`*]+$/g, '').replace(/^["'`*]+/, '').trim())
    .filter((l) => l && l.split(/\s+/).length <= 6 && !REFUSAL.test(l));
  return uniqueNames(lines);
}

const SYSTEM =
  'You help a small residential landlord keep the tenant register they are required to keep. ' +
  'Tenants handed over their identity cards when moving in. You only transcribe the printed names; ' +
  'never output ID numbers, dates of birth, addresses or any other details.';
const PROMPT =
  'The photo shows one or more identity cards (sometimes two cards side by side). ' +
  "Transcribe the holder's name from EACH card, exactly as printed in English (Latin) letters. " +
  'Reply with ONLY this JSON: {"names": ["<name on card 1>", "<name on card 2>"]}. If no name is visible, reply {"names": []}.';
const RETRY_PROMPT = 'What names are printed on the card or cards in this photo, in English letters? Reply with just the names, one per line, nothing else.';

/** Every card holder's name in the photo. Never throws: [] if it can't read one. */
export async function readNames(env: Env, imageBase64: string | null): Promise<string[]> {
  if (!imageBase64 || !env.AI) return [];
  const image = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  const run = (prompt: string) =>
    env.AI!.run(VISION_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      image,
      max_tokens: 80,
      temperature: 0,
    });
  // Meta's licence for this model is accepted once per account by sending "agree".
  const agree = async () => {
    await env.AI!.run(VISION_MODEL, { prompt: 'agree' });
    await setSetting(env.DB, LICENCE_KEY, 'yes');
  };
  try {
    if (!(await getSetting(env.DB, LICENCE_KEY))) await agree().catch((e) => console.error('Licence', e));
    let reply;
    try {
      reply = await run(PROMPT);
    } catch (e: any) {
      if (!/agree|licen[cs]e/i.test(String(e?.message || e))) throw e;
      await agree();
      reply = await run(PROMPT);
    }
    let names = namesFromReply(reply);
    if (!names.length) names = namesFromReply(await run(RETRY_PROMPT));
    return names;
  } catch (e) {
    console.error('Name reading failed', e);
    return [];
  }
}

// ---------- matching a name to someone in the unit ----------

const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3);

/**
 * The listed person whose name matches the name on the card. Strict on purpose: every word of
 * the shorter name (3+ letters) must appear in the other, so "Suresh Kumar" never lands on
 * "Suresh Gowda". Anything less certain waits for the owner.
 */
export function bestMatch(name: string, people: { id: string; name: string }[]): string | null {
  const card = tokens(name);
  if (!card.length) return null;
  const hits = people.filter((p) => {
    const listed = tokens(p.name);
    if (!listed.length) return false;
    const [short, long] = listed.length <= card.length ? [listed, card] : [card, listed];
    return short.every((w) => long.includes(w));
  });
  return hits.length === 1 ? hits[0].id : null;
}

// ---------- India time for file names ----------

function ist(iso: string) {
  const d = new Date(new Date(iso).getTime() + 330 * 60_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16).replace(':', '.') };
}

// ---------- upload ----------

export async function handleIdUpload(request: Request, env: Env, email: string) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError('Send the photo as a form upload');
  }
  const code = str(form.get('unit'), 12).toUpperCase();
  const unit = await env.DB.prepare('SELECT code FROM units WHERE code = ?').bind(code).first();
  if (!unit) throw new ValidationError('Choose the unit first');
  const photo = form.get('photo');
  if (!photo || typeof photo === 'string') throw new ValidationError('No photo attached');
  const blob = photo as Blob;
  const isPdf = blob.type === 'application/pdf';
  if (!isPdf && !/^image\/(jpeg|png|webp|heic|heif)$/.test(blob.type || '')) throw new ValidationError('The file must be a photo or a PDF');
  if (blob.size > MAX_BYTES) throw new ValidationError('File is too large (over 10 MB)');
  if (blob.size < 1000) throw new ValidationError('File is empty');

  const takenRaw = new Date(String(form.get('takenAt') || ''));
  const now = Date.now();
  const takenAt =
    !isNaN(takenRaw.getTime()) && takenRaw.getTime() <= now + 5 * 60_000 && now - takenRaw.getTime() < 30 * 86_400_000
      ? takenRaw.toISOString()
      : new Date(now).toISOString();

  let token: string;
  try {
    token = await accessToken(env);
  } catch {
    return { status: 503, body: { success: false, error: 'drive_not_linked', message: 'Google Drive isn’t linked yet. Please tell the owner.' } };
  }

  const preview = form.get('preview');
  const names = await readNames(env, !isPdf && typeof preview === 'string' && preview.length > 100 && preview.length < MAX_AI_CHARS ? preview : null);

  const t = ist(takenAt);
  const root = await ensureFolder(token, ROOT);
  const ids = await ensureFolder(token, IDS, root);
  const unitFolder = await ensureFolder(token, code, ids);
  const ext = isPdf ? 'pdf' : blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type.startsWith('image/hei') ? 'heic' : 'jpg';
  const label = names.length ? safeName(names.join(' & ')) : isPdf ? 'PDF' : 'Name not read';
  const fileName = `${code} - ${t.date} ${t.time} - ${label}.${ext}`;
  const file = await uploadFile(token, { name: fileName, mimeType: blob.type, parents: [unitFolder] }, blob);

  // Attach to people listed in the unit's current tenancy when the names match.
  const tenancy = await env.DB.prepare('SELECT id FROM tenancies WHERE unit_code = ? AND end_date IS NULL').bind(code).first<{ id: string }>();
  const linked: string[] = [];
  if (tenancy && names.length) {
    const people = (await env.DB.prepare('SELECT id, name FROM people WHERE tenancy_id = ?').bind(tenancy.id).all<{ id: string; name: string }>()).results;
    for (const n of names) {
      const match = bestMatch(n, people.filter((p) => !linked.includes(p.id)));
      if (match) linked.push(match);
    }
    const nowIso = new Date().toISOString();
    for (const pid of linked) {
      await env.DB.prepare('UPDATE people SET drive_file_id = ?, drive_file_name = ?, id_uploaded_at = ? WHERE id = ?').bind(file.id, fileName, nowIso, pid).run();
    }
  }
  const allLinked = names.length > 0 && linked.length === names.length;
  await env.DB
    .prepare(
      'INSERT INTO id_uploads (id, unit_code, tenancy_id, drive_file_id, file_name, names, is_pdf, taken_at, uploaded_by, status, person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(crypto.randomUUID(), code, tenancy?.id ?? null, file.id, fileName, JSON.stringify(names), isPdf ? 1 : 0, takenAt, email, allLinked ? 'linked' : 'new', linked[0] ?? null)
    .run();
  return { status: 200, body: { success: true, names, matched: linked.length, unit: code } };
}

// ---------- owner: waiting IDs ----------

export async function waitingIds(env: Env, code: string) {
  const rows = (
    await env.DB.prepare("SELECT * FROM id_uploads WHERE unit_code = ? AND status = 'new' ORDER BY taken_at DESC").bind(code).all<any>()
  ).results;
  return rows.map((r) => ({ ...r, names: safeJson(r.names) }));
}

/** Units with ID photos waiting for the owner, and how many. */
export async function waitingByUnit(env: Env) {
  return (
    await env.DB.prepare("SELECT unit_code AS unit, COUNT(*) AS n FROM id_uploads WHERE status = 'new' GROUP BY unit_code ORDER BY unit_code").all<{ unit: string; n: number }>()
  ).results;
}

const safeJson = (s: string | null) => {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

async function getUpload(env: Env, id: string) {
  const u = await env.DB.prepare('SELECT * FROM id_uploads WHERE id = ?').bind(id).first<any>();
  if (!u) throw new NotFoundError('ID photo not found');
  return u;
}

async function openTenancy(env: Env, code: string) {
  const t = await env.DB.prepare('SELECT id FROM tenancies WHERE unit_code = ? AND end_date IS NULL').bind(code).first<{ id: string }>();
  if (!t) throw new ValidationError('Add the tenant to this unit first');
  return t.id;
}

/** Attach to an existing person, or add a new person with this ID. */
export async function attachUpload(env: Env, id: string, body: any) {
  const u = await getUpload(env, id);
  const tenancyId = await openTenancy(env, u.unit_code);
  let personId = str(body?.person_id, 60);
  if (personId) {
    const p = await env.DB.prepare('SELECT id FROM people WHERE id = ? AND tenancy_id = ?').bind(personId, tenancyId).first();
    if (!p) throw new ValidationError('That person isn’t in this unit');
  } else {
    const name = str(body?.name, 80);
    if (!name) throw new ValidationError('Name is required');
    personId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO people (id, tenancy_id, name, id_type) VALUES (?, ?, ?, ?)').bind(personId, tenancyId, name, null).run();
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE people SET drive_file_id = ?, drive_file_name = ?, id_uploaded_at = ? WHERE id = ?').bind(u.drive_file_id, u.file_name, new Date().toISOString(), personId),
    env.DB.prepare("UPDATE id_uploads SET status = 'linked', person_id = ?, tenancy_id = ? WHERE id = ?").bind(personId, tenancyId, id),
  ]);
}

export async function dismissUpload(env: Env, id: string) {
  await getUpload(env, id);
  await env.DB.prepare("UPDATE id_uploads SET status = 'dismissed' WHERE id = ?").bind(id).run();
}
