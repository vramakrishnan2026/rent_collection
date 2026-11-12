import type { Env } from './env';
import { NotFoundError, ValidationError, getSetting, setSetting, str } from './db.ts';
import { IDS, ROOT, accessToken, ensureFolder, safeName, uploadFile } from './drive.ts';
import { readCards, type Card } from './idread.ts';

// The "Add ID" screen (security guard and owner), same idea as the Finance Tracker's House Help:
// pick the unit, take a photo (or choose photos / PDFs). Each goes straight to Google Drive under
//   Challaghatta Home › Tenant IDs › <unit> › "<unit> - YYYY-MM-DD HH.MM - <names>.jpg"
// Cloudflare's AI reads ONLY the printed name(s). ID numbers are never read or stored.
// If a name matches someone listed in the unit, the photo is attached to them automatically;
// otherwise it waits on the unit's page for the owner.

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AI_CHARS = 1_500_000;
const PAIR_MINUTES = 15; // a back-of-card photo (address, no name) joins the front taken just before it

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

export async function handleIdUpload(request: Request, env: Env, email: string, role: 'owner' | 'security' = 'security') {
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
  let blob = photo as Blob;
  const fileName0 = (photo as File).name || '';
  // Some browsers send PDFs (and phone photos) without a type; go by the file's name or first bytes.
  if (!blob.type || blob.type === 'application/octet-stream') {
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    const isPdfBytes = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46; // %PDF
    const type = isPdfBytes || /\.pdf$/i.test(fileName0) ? 'application/pdf' : head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg' : '';
    if (type) blob = new Blob([blob], { type });
  }
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
  const cards: Card[] = await readCards(env, !isPdf && typeof preview === 'string' && preview.length > 100 && preview.length < MAX_AI_CHARS ? preview : null);
  const names = [...new Set(cards.map((c) => c.name).filter((n): n is string => Boolean(n)))];
  const idType = cards.find((c) => c.type)?.type ?? null;
  const address = cards.find((c) => c.address)?.address ?? null;

  const t = ist(takenAt);
  const ext = isPdf ? 'pdf' : blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : blob.type.startsWith('image/hei') ? 'heic' : 'jpg';
  const label = names.length ? safeName(names.join(' & ')) : address ? 'Back (address)' : isPdf ? 'PDF' : 'Name not read';
  const fileName = `${code} - ${t.date} ${t.time} - ${label}.${ext}`;
  let file: { id: string };
  try {
    const root = await ensureFolder(token, ROOT);
    const ids = await ensureFolder(token, IDS, root);
    const unitFolder = await ensureFolder(token, code, ids);
    file = await uploadFile(token, { name: fileName, mimeType: blob.type, parents: [unitFolder] }, blob);
  } catch (e: any) {
    console.error('Drive upload failed', e);
    return { status: 502, body: { success: false, error: 'drive_failed', message: `Google Drive refused the file: ${String(e?.message || e).slice(0, 200)}` } };
  }

  // Attach to people listed in the unit's current tenancy when the names match.
  const tenancy = await env.DB.prepare('SELECT id FROM tenancies WHERE unit_code = ? AND end_date IS NULL').bind(code).first<{ id: string }>();
  let linked: string[] = [];
  // The owner tapped "Add ID" on a particular person: attach it to them, whatever name was read.
  const forPerson = role === 'owner' ? String(form.get('person_id') || '') : '';
  const side: 'front' | 'back' = String(form.get('side') || '') === 'back' ? 'back' : 'front';
  if (forPerson) {
    const p = tenancy && (await env.DB.prepare('SELECT id FROM people WHERE id = ? AND tenancy_id = ?').bind(forPerson, tenancy.id).first());
    if (!p) throw new ValidationError('That person isn’t in this unit');
    const uploadId = crypto.randomUUID();
    await applyToPerson(env, forPerson, { fileId: file.id, fileName, idType, address, replace: true, side });
    await env.DB
      .prepare("INSERT INTO id_uploads (id, unit_code, tenancy_id, drive_file_id, file_name, names, is_pdf, taken_at, uploaded_by, status, person_id, id_type, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?)")
      .bind(uploadId, code, tenancy!.id, file.id, fileName, JSON.stringify(names), isPdf ? 1 : 0, takenAt, email, forPerson, idType, address)
      .run();
    return { status: 200, body: { success: true, uploadId, names, idType, address: Boolean(address), matched: 1, paired: false, unit: code } };
  }
  type P = { id: string; name: string; drive_file_id: string | null; back_file_id: string | null };
  let people: P[] = [];
  if (tenancy && names.length) {
    people = (await env.DB.prepare('SELECT id, name, drive_file_id, back_file_id FROM people WHERE tenancy_id = ?').bind(tenancy.id).all<P>()).results;
    for (const n of names) {
      const match = bestMatch(n, people.filter((p) => !linked.includes(p.id)));
      if (match) linked.push(match);
    }
  }
  // The back of an Aadhaar has the address but no name: pair it with the front sent just before it.
  let pairedWith: any = null;
  if (!names.length && address) {
    const since = new Date(Date.parse(takenAt) - PAIR_MINUTES * 60_000).toISOString();
    pairedWith = await env.DB
      .prepare("SELECT * FROM id_uploads WHERE unit_code = ? AND uploaded_by = ? AND names IS NOT NULL AND names != '[]' AND taken_at >= ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1")
      .bind(code, email, since, takenAt)
      .first<any>();
    if (pairedWith) {
      if (pairedWith.address == null) await env.DB.prepare('UPDATE id_uploads SET address = ? WHERE id = ?').bind(address, pairedWith.id).run();
      if (pairedWith.status === 'linked' && pairedWith.person_id) {
        people = (await env.DB.prepare('SELECT id, name, drive_file_id, back_file_id FROM people WHERE drive_file_id = ?').bind(pairedWith.drive_file_id).all<P>()).results;
        linked = people.map((r) => r.id);
      } else if (pairedWith.status === 'new') {
        // The front is waiting for the owner (e.g. under review): this back waits with it.
        pairedWith = null;
      }
    }
  }
  // Someone who already has this side on file keeps it: the new photo is kept too, for the owner to review.
  const sideField = pairedWith ? 'back_file_id' : 'drive_file_id';
  const already = linked.filter((id) => people.find((p) => p.id === id)?.[sideField]);
  linked = linked.filter((id) => !already.includes(id));
  for (const pid of linked) await applyToPerson(env, pid, { fileId: file.id, fileName, idType: idType ?? pairedWith?.id_type ?? null, address, side: pairedWith ? 'back' : 'front' });
  // Paired back photo: its address went to the people (or onto the waiting front photo), so nothing is left to do.
  const status = already.length
    ? 'new'
    : pairedWith ? (linked.length ? 'linked' : 'dismissed') : names.length > 0 && linked.length === names.length ? 'linked' : 'new';
  const review = already[0] ?? null;
  const uploadId = crypto.randomUUID();
  await env.DB
    .prepare(
      'INSERT INTO id_uploads (id, unit_code, tenancy_id, drive_file_id, file_name, names, is_pdf, taken_at, uploaded_by, status, person_id, id_type, address, review_person_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(uploadId, code, tenancy?.id ?? null, file.id, fileName, JSON.stringify(names), isPdf ? 1 : 0, takenAt, email, status, linked[0] ?? null, idType, address, review)
    .run();
  return { status: 200, body: { success: true, uploadId, status, names, idType, address: Boolean(address), matched: linked.length, paired: Boolean(pairedWith) && linked.length > 0, review: Boolean(review), unit: code } };
}

/** Saves an ID's file and details on a person (keeps what's already there if the ID doesn't have it). */
async function applyToPerson(
  env: Env,
  personId: string,
  d: { fileId: string | null; fileName: string; idType: string | null; address: string | null; replace?: boolean; side?: 'front' | 'back' }
) {
  const now = new Date().toISOString();
  if (d.fileId && d.side === 'back') {
    await env.DB.prepare('UPDATE people SET back_file_id = ?, back_file_name = ? WHERE id = ?').bind(d.fileId, d.fileName, personId).run();
  } else if (d.fileId) {
    await env.DB.prepare('UPDATE people SET drive_file_id = ?, drive_file_name = ?, id_uploaded_at = ? WHERE id = ?').bind(d.fileId, d.fileName, now, personId).run();
  }
  await env.DB
    .prepare(d.replace ? 'UPDATE people SET id_type = COALESCE(?, id_type), address = COALESCE(?, address) WHERE id = ?' : 'UPDATE people SET id_type = COALESCE(id_type, ?), address = COALESCE(?, address) WHERE id = ?')
    .bind(d.idType, d.address, personId)
    .run();
}

// ---------- owner: waiting IDs ----------

export async function waitingIds(env: Env, code: string) {
  const rows = (
    await env.DB
      .prepare(
        `SELECT u.*, p.name AS review_name, p.drive_file_id AS review_front, p.back_file_id AS review_back, p.id_uploaded_at AS review_saved
         FROM id_uploads u LEFT JOIN people p ON p.id = u.review_person_id
         WHERE u.unit_code = ? AND u.status = 'new' ORDER BY u.taken_at DESC`
      )
      .bind(code)
      .all<any>()
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
  // A back-of-card photo (address only) adds the address without replacing the person's ID photo.
  const backOnly = !safeJson(u.names).length && u.address && body?.person_id;
  await applyToPerson(env, personId, { fileId: u.drive_file_id, fileName: u.file_name, idType: u.id_type, address: u.address, side: backOnly ? 'back' : 'front' });
  await env.DB.prepare("UPDATE id_uploads SET status = 'linked', person_id = ?, tenancy_id = ? WHERE id = ?").bind(personId, tenancyId, id).run();
}

export async function dismissUpload(env: Env, id: string) {
  await getUpload(env, id);
  await env.DB.prepare("UPDATE id_uploads SET status = 'dismissed' WHERE id = ?").bind(id).run();
}

/** After a tenant is added: attach any waiting ID photos for that unit whose names match people listed. */
export async function attachWaiting(env: Env, code: string) {
  const tenancy = await env.DB.prepare('SELECT id FROM tenancies WHERE unit_code = ? AND end_date IS NULL').bind(code).first<{ id: string }>();
  if (!tenancy) return 0;
  const waiting = (await env.DB.prepare("SELECT * FROM id_uploads WHERE unit_code = ? AND status = 'new' ORDER BY taken_at").bind(code).all<any>()).results;
  if (!waiting.length) return 0;
  const people = (await env.DB.prepare('SELECT id, name FROM people WHERE tenancy_id = ? AND drive_file_id IS NULL').bind(tenancy.id).all<{ id: string; name: string }>()).results;
  let n = 0;
  for (const w of waiting) {
    const names = safeJson(w.names);
    const linked: string[] = [];
    for (const name of names) {
      const match = bestMatch(name, people.filter((p) => !linked.includes(p.id)));
      if (match) linked.push(match);
    }
    if (!linked.length) continue;
    for (const pid of linked) {
      await applyToPerson(env, pid, { fileId: w.drive_file_id, fileName: w.file_name, idType: w.id_type, address: w.address });
      people.splice(people.findIndex((p) => p.id === pid), 1);
    }
    const all = linked.length === names.length;
    await env.DB.prepare('UPDATE id_uploads SET status = ?, person_id = ?, tenancy_id = ? WHERE id = ?').bind(all ? 'linked' : 'new', linked[0], tenancy.id, w.id).run();
    n += linked.length;
  }
  return n;
}
