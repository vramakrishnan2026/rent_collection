import type { Env } from './env';
import { getSetting, setSetting } from './db.ts';

// Reads Indian ID cards with Cloudflare Workers AI and returns, per card: type, holder's name, address.
// ID numbers and dates of birth are never kept: the prompts ask the model to leave them out, and
// anything that looks like an ID number is stripped from what comes back before it is used.
//
// Layouts (checked Nov 2026):
//  - Aadhaar front: "Government of India"; name in the local script, then the name in English, directly
//    above "DOB:" / "Year of Birth" and "Male"/"Female". No address on the front of the plastic card.
//  - Aadhaar back (and the e-Aadhaar letter): "Address:" starting S/O, D/O, W/O or C/O <relative>,
//    then house, street, area, district, state and a 6-digit PIN. The letter also has a "To" block.
//  - PAN: "INCOME TAX DEPARTMENT"; newer cards label "Name" and "Father's Name"; older cards print
//    the holder's name on the first line and the father's name on the second. No address.
//  - Driving licence: "Name", "S/D/W of" (relative, not the holder), "Add"/"Address", DOB, validity.
//  - Voter ID (EPIC): "Elector's Name" / "Name"; "Father's/Husband's Name" is a relative; address on the back.
//  - Passport: "Surname" and "Given Name(s)"; the address is on the last page.

export const ID_TYPES = ['Aadhaar', 'PAN', 'Driving licence', 'Voter ID', 'Passport', 'Other'];

const PRIMARY = '@cf/meta/llama-4-scout-17b-16e-instruct';
const FALLBACK = '@cf/meta/llama-3.2-11b-vision-instruct';
const LICENCE_KEY = 'ai_licence_agreed';
const LAST_KEY = 'id_read_last';

export interface Card {
  type: string | null;
  name: string | null;
  address: string | null;
}

const SYSTEM =
  'You help a small residential landlord in India keep the tenant register the law requires. Tenants handed over ' +
  'their identity cards. You transcribe only the card type, the holder\'s name and the printed address. Never output ' +
  'ID numbers (Aadhaar, VID, PAN, licence or EPIC numbers), dates of birth, phone numbers or QR contents.';

const PROMPT = `The photo shows one or more Indian identity cards (front or back), or an e-Aadhaar letter.
For EACH card, give:
- "type": one of Aadhaar, PAN, Driving licence, Voter ID, Passport, Other.
- "name": the card HOLDER's name in English letters, exactly as printed.
   Aadhaar: the English name just above "DOB"/"Year of Birth" (ignore the regional-script name and "Government of India").
   PAN: the line labelled "Name", or on older cards the FIRST name line (the second line is the father's name).
   Driving licence: the "Name" field, NOT "S/D/W of". Voter ID: "Elector's Name", NOT the father's/husband's name.
   Passport: Given name(s) followed by Surname. Back of an Aadhaar card: use null (no holder name there).
- "address": the printed address in English, exactly as printed, including S/O/D/O/W/O/C/O, house, street, area, city, state and PIN code. null if the card shows no address (PAN and the Aadhaar front have none).
Reply with ONLY JSON: {"cards":[{"type":"...","name":"...","address":"..."}]}`;

const LINES_PROMPT =
  'Transcribe every line of English text printed on the card(s), top to bottom, one per line. ' +
  'Write X instead of every digit of any ID number or date of birth. Reply with just the lines.';

// ---------- cleaning ----------

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/\d/.test(raw)) return null; // names have no digits (this also drops ID numbers)
  const s = raw.normalize('NFKC').replace(/[^\p{L}\p{M} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60 || !/\p{L}{2}/u.test(s)) return null;
  const lower = s.toLowerCase();
  if (/^(null|none|unknown|not readable|n ?a|name|holder|government of india|income tax department|govt of india|male|female)$/.test(lower)) return null;
  if (/government|department|authority|india|licen[cs]e|union|election|republic|permanent account/i.test(s)) return null;
  return s
    .split(' ')
    .map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Removes anything that looks like an ID number; keeps house numbers and the PIN code. */
export function scrubIds(s: string): string {
  return s
    .replace(/\b\d{4}\s?\d{4}\s?\d{4}(\s?\d{4})?\b/g, ' ') // Aadhaar (12) / VID (16)
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, ' ') // PAN
    .replace(/\b[A-Z]{2}[- ]?\d{2}[- ]?\d{4}[- ]?\d{6,7}\b/g, ' ') // DL
    .replace(/\b[A-Z]{3}\d{7}\b/g, ' ') // EPIC
    .replace(/\b(DOB|D\.O\.B|Date of Birth|Year of Birth|YOB)\s*[:\-]?\s*[\dX\/.\-]+/gi, ' ')
    .replace(/\b(Mobile|Mob|Ph|Phone)\s*[:\-]?\s*\+?\d[\d\s]{8,}/gi, ' ');
}

export function cleanAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = scrubIds(raw.normalize('NFKC'))
    .replace(/^\s*(address|add|addr|पता)\s*[:\-]?\s*/i, '')
    .replace(/[^\p{L}\p{M}\p{N} ,./#&()'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .trim()
    .replace(/^[,.\- ]+|[,.\- ]+$/g, '');
  if (s.length < 10 || !/\p{L}{3}/u.test(s) || /^null$/i.test(s)) return null;
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

export function cleanType(raw: unknown): string | null {
  const s = String(raw ?? '').toLowerCase();
  if (/aadha?ar|uidai/.test(s)) return 'Aadhaar';
  if (/\bpan\b|income tax|permanent account/.test(s)) return 'PAN';
  if (/driv|licen[cs]e|\bdl\b/.test(s)) return 'Driving licence';
  if (/voter|elector|epic/.test(s)) return 'Voter ID';
  if (/passport/.test(s)) return 'Passport';
  return s && s !== 'null' ? 'Other' : null;
}

const normalise = (c: any): Card => ({ type: cleanType(c?.type), name: cleanName(c?.name), address: cleanAddress(c?.address) });

/** Cards from the model's JSON reply (tolerates extra text around it). */
export function cardsFromReply(reply: any): Card[] {
  const out = typeof reply === 'string' ? reply : reply?.response ?? reply?.result?.response ?? reply;
  let obj: any = out && typeof out === 'object' ? out : null;
  if (!obj && typeof out === 'string') {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  const list = Array.isArray(obj?.cards) ? obj.cards : Array.isArray(obj) ? obj : obj && ('name' in obj || 'address' in obj) ? [obj] : [];
  return list.map(normalise).filter((c: Card) => c.name || c.address).slice(0, 6);
}

/** Fallback: find type, name and address in plain transcribed lines using the layouts above. */
export function cardsFromLines(text: string): Card[] {
  const lines = String(text || '')
    .split(/\n/)
    .map((l) => l.replace(/^[\s\-*•\d.)]+(?=\D)/, '').trim())
    .filter(Boolean);
  const all = lines.join('\n');
  const type = cleanType(
    /aadhaar|uidai|unique identification/i.test(all) ? 'aadhaar'
    : /income tax|permanent account/i.test(all) ? 'pan'
    : /driving|licen[cs]e|transport/i.test(all) ? 'dl'
    : /election|elector/i.test(all) ? 'voter'
    : /passport|republic of india/i.test(all) ? 'passport'
    : ''
  );
  let name: string | null = null;
  // Labelled fields first: "Name: X" (not father's / S/D/W of)
  for (let i = 0; i < lines.length && !name; i++) {
    const l = lines[i];
    if (!/^(?:elector'?s\s+)?name\b/i.test(l) || /father|husband|mother/i.test(l)) continue;
    const value = l.replace(/^(?:elector'?s\s+)?name\s*[:/\-]?\s*(?:नाम)?\s*[:\-]?\s*/i, '');
    // "Name: X" on one line, or the label alone with the name on the next line (new PAN cards)
    name = cleanName(value) || (value ? null : cleanName(lines[i + 1] || ''));
  }
  // Aadhaar: the English line just above DOB / Year of Birth
  if (!name) {
    const i = lines.findIndex((l) => /\b(DOB|D\.O\.B|Year of Birth|YOB|Date of Birth)\b/i.test(l));
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      name = cleanName(lines[j]);
      if (name) break;
    }
  }
  // PAN (old): first plausible name line after the header
  if (!name && type === 'PAN') {
    const h = lines.findIndex((l) => /income tax|govt|government/i.test(l));
    for (let j = h + 1; j < lines.length && j <= h + 4; j++) {
      name = cleanName(lines[j]);
      if (name) break;
    }
  }
  // Address: from "Address"/"Add" (or an S/O, D/O, W/O, C/O line) through the PIN code
  let address: string | null = null;
  const a = lines.findIndex((l) => /^(address|add)\b|^(s|d|w|c)\s?\/\s?o\b/i.test(l));
  if (a >= 0) {
    const parts: string[] = [];
    for (let j = a; j < lines.length && parts.length < 8; j++) {
      parts.push(lines[j]);
      if (/\b\d{6}\b/.test(lines[j])) break;
    }
    address = cleanAddress(parts.join(', '));
  }
  return name || address ? [{ type, name, address }] : [];
}

// ---------- calling the model ----------

async function run(env: Env, model: string, prompt: string, image: string) {
  if (model === PRIMARY) {
    return env.AI!.run(model, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] },
      ],
      max_tokens: 600,
      temperature: 0,
    });
  }
  return env.AI!.run(model, {
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    image,
    max_tokens: 600,
    temperature: 0,
  });
}

async function agree(env: Env) {
  if (await getSetting(env.DB, LICENCE_KEY)) return;
  await env.AI!.run(FALLBACK, { prompt: 'agree' }).catch(() => {});
  await setSetting(env.DB, LICENCE_KEY, 'yes');
}

const textOf = (reply: any) => {
  const out = typeof reply === 'string' ? reply : reply?.response ?? reply?.result?.response ?? reply;
  return typeof out === 'string' ? out : JSON.stringify(out ?? '');
};
const masked = (s: string) => s.replace(/\d/g, '•').replace(/\s+/g, ' ').trim().slice(0, 240);

async function note(env: Env, entry: Record<string, unknown>) {
  try {
    await setSetting(env.DB, LAST_KEY, JSON.stringify({ at: new Date().toISOString(), ...entry }));
  } catch {
    /* diagnostics only */
  }
}

export async function lastRead(env: Env) {
  try {
    return JSON.parse((await getSetting(env.DB, LAST_KEY)) || 'null');
  } catch {
    return null;
  }
}

/** Every card in the photo: type, holder's name, address. Never throws: [] if it can't read anything. */
export async function readCards(env: Env, imageBase64: string | null): Promise<Card[]> {
  if (!imageBase64) return [];
  if (!env.AI) {
    await note(env, { ok: false, error: 'Workers AI is not connected (missing "ai" binding).' });
    return [];
  }
  const image = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  const tries: string[] = [];
  for (const model of [PRIMARY, FALLBACK]) {
    try {
      if (model === FALLBACK) await agree(env);
      let reply = await run(env, model, PROMPT, image).catch(async (e: any) => {
        if (model === FALLBACK && /agree|licen[cs]e/i.test(String(e?.message || e))) {
          await env.AI!.run(FALLBACK, { prompt: 'agree' });
          return run(env, model, PROMPT, image);
        }
        throw e;
      });
      let cards = cardsFromReply(reply);
      tries.push(`${model.split('/').pop()}: ${masked(textOf(reply))}`);
      if (!cards.some((c) => c.name || c.address)) {
        reply = await run(env, model, LINES_PROMPT, image);
        cards = cardsFromLines(textOf(reply));
        tries.push(`${model.split('/').pop()} (lines): ${masked(textOf(reply))}`);
      }
      if (cards.length) {
        await note(env, { ok: true, model, cards: cards.map((c) => ({ type: c.type, name: Boolean(c.name), address: Boolean(c.address) })) });
        return cards;
      }
    } catch (e: any) {
      tries.push(`${model.split('/').pop()} error: ${String(e?.message || e).slice(0, 160)}`);
    }
  }
  console.log('ID not read', tries);
  await note(env, { ok: false, tries });
  return [];
}
