import type { Env, ExecutionContext, ScheduledController } from './env';
import { cookie, currentUser, getCookie, handleAuth, isPublicPath, LOGIN_PATH, redirect, type User } from './auth.ts';
import {
  NotFoundError,
  ValidationError,
  addPerson,
  addUnit,
  createTenancy,
  dashboard,
  date,
  deletePayment,
  deletePerson,
  deleteTenancy,
  deleteTestPayments,
  endTenancy,
  exportAll,
  listPayments,
  overview,
  recordPayment,
  settleDeposit,
  settlementPreview,
  securityView,
  unitDetail,
  updatePerson,
  updateTenancy,
  updateUnit,
} from './db.ts';
import * as drive from './drive.ts';
import { WEBHOOK_PATH, handleWebhook, linkForTenancy, markSent, razorpayStatus, refreshLink, syncOpenLinks } from './razorpay.ts';
import { todayIST } from './rent.ts';
import { PAIR_PATH, cancelCodes, createPairCode, currentDevice, handlePair, listDevices, removeDevice } from './devices.ts';
import { lastRead } from './idread.ts';
import { handleScreenshot } from './screenshot.ts';
import { ask } from './ask.ts';
import { getUpi } from './razorpay.ts';
import { setSetting } from './db.ts';
import { collectQueue, pushKey, rentReminders, subscribe, unsubscribe, notifyOwners } from './collect.ts';
import { attachUpload, attachWaiting, dismissUpload, handleIdUpload, waitingByUnit, waitingIds } from './ids.ts';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const error = (message: string, status = 400) => json({ success: false, error: message }, status);

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
}

/** Blocks form posts from other sites: JSON API calls must come from this origin. */
function sameOrigin(request: Request, url: URL) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

function drivePage(ok: boolean, message: string) {
  const safe = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F8FAFC">
<div style="text-align:center;background:#fff;padding:2rem;border-radius:1.5rem;max-width:22rem;box-shadow:0 10px 25px -10px rgba(15,23,42,.15)">
<h1 style="color:${ok ? '#059669' : '#E11D48'}">${ok ? 'Google Drive linked' : 'Couldn’t link Google Drive'}</h1>
<p style="color:#64748B">${safe}</p><p><a href="/" style="color:#0F172A;font-weight:700">Back to the app</a></p></div></body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie(drive.STATE_COOKIE, '', 0, '/api/drive') },
  });
}

/**
 * The owner's PIN for critical actions: making a unit rent-free, deleting payments, removing a phone,
 * linking/unlinking Google Drive and downloading the backup. Default 1234.
 */
const ownerPin = (env: Env) => env.OWNER_PIN || env.RENT_FREE_PIN || '1234';
async function requirePin(request: Request, env: Env): Promise<any> {
  const body: any = await request.json().catch(() => ({}));
  if (String(body?.pin ?? '').trim() !== ownerPin(env)) throw new ValidationError('Wrong PIN');
  return body;
}

async function handleApi(request: Request, env: Env, url: URL, user: User): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  const today = env.TEST_TODAY || todayIST();
  if (method !== 'GET' && !sameOrigin(request, url)) return error('Not allowed', 403);

  if (pathname === '/api/me' && method === 'GET') return json({ email: user.email, role: user.role, name: user.name ?? null, device: Boolean(user.device) });

  // The security guard's screen (owners can open it too).
  if (pathname === '/api/security' && method === 'GET') return json(await securityView(env.DB, today));

  // "Add ID" screen: the security guard and owners can photograph tenant IDs.
  if (pathname === '/api/id-uploads' && method === 'POST') {
    const { status, body } = await handleIdUpload(request, env, user.email, user.role);
    return json(body, status);
  }

  if (user.role !== 'owner') return error('Not allowed', 403);

  // ---- Google Drive link for tenant IDs
  // Linking needs the PIN: a different Google account would send ID photos to someone else's Drive.
  if (pathname === drive.CONNECT_PATH && method === 'POST') {
    await requirePin(request, env);
    if (!drive.isConfigured(env)) return error('Google isn’t set up on the server', 503);
    const state = crypto.randomUUID();
    const res = json({ url: drive.authUrl(env, url.origin, state) });
    res.headers.append('Set-Cookie', cookie(drive.STATE_COOKIE, state, 600, '/api/drive'));
    return res;
  }
  if (pathname === drive.CALLBACK_PATH && method === 'GET') {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('error') || !code) return drivePage(false, 'Linking was cancelled.');
    if (url.searchParams.get('state') !== getCookie(request, drive.STATE_COOKIE)) return drivePage(false, 'That link expired. Please try again.');
    try {
      await drive.handleCallback(env, url.origin, code);
      return drivePage(true, 'Tenant ID photos will be saved to “Challaghatta Home › Tenant IDs” in your Drive.');
    } catch (e) {
      return drivePage(false, e instanceof Error ? e.message : 'Unknown error');
    }
  }
  if (pathname === '/api/drive/disconnect' && method === 'POST') {
    await requirePin(request, env);
    await drive.disconnect(env);
    return json({ success: true });
  }

  // Ask your data (read-only summary + AI)
  if (pathname === '/api/ask' && method === 'POST') return json(await ask(env, await readJson(request), today));

  // UPI payment screenshots: read, and record straight away when everything checks out
  if (pathname === '/api/payments/screenshot' && method === 'POST') return json(await handleScreenshot(request, env, user.email, today));

  // The owner's UPI ID for direct payments (PIN: it decides where tenants send money)
  if (pathname === '/api/settings/upi' && method === 'PUT') {
    const body = await requirePin(request, env);
    const id = String(body?.upi_id ?? '').trim();
    if (id && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/.test(id)) throw new ValidationError('That doesn’t look like a UPI ID (e.g. name@okhdfcbank)');
    await setSetting(env.DB, 'upi_id', id || null);
    await setSetting(env.DB, 'upi_name', String(body?.upi_name ?? '').trim().slice(0, 60) || null);
    return json({ success: true, upi: await getUpi(env.DB) });
  }

  // "Send all" queue and reminders on this phone
  if (pathname === '/api/collect' && method === 'GET') return json(await collectQueue(env, today));
  if (pathname === '/api/push/key' && method === 'GET') return json(await pushKey(env));
  if (pathname === '/api/push/subscribe' && method === 'POST') {
    await subscribe(env, user.email, await readJson(request));
    return json({ success: true });
  }
  if (pathname === '/api/push/unsubscribe' && method === 'POST') {
    await unsubscribe(env, await readJson(request));
    return json({ success: true });
  }
  if (pathname === '/api/push/test' && method === 'POST') {
    return json(await notifyOwners(env, { title: 'Reminders are on', body: 'You’ll get a reminder on the 1st to send the rent links.', url: '/#/send', tag: 'test' }, url.origin));
  }

  // Security phones (paired with a one-time code, no Gmail)
  if (pathname === '/api/devices' && method === 'GET') return json(await listDevices(env));
  if (pathname === '/api/devices/pair' && method === 'POST') return json(await createPairCode(env, await readJson(request), url.origin));
  if (pathname === '/api/devices/codes' && method === 'DELETE') {
    await cancelCodes(env);
    return json({ success: true });
  }
  if (pathname.startsWith('/api/devices/') && method === 'DELETE') {
    await requirePin(request, env);
    await removeDevice(env, decodeURIComponent(pathname.slice('/api/devices/'.length)));
    return json({ success: true });
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return json({ razorpay: razorpayStatus(env), webhookUrl: url.origin + WEBHOOK_PATH, drive: await drive.status(env), idReading: { connected: Boolean(env.AI), last: await lastRead(env) }, upi: await getUpi(env.DB) });
  }
  if (pathname === '/api/dashboard' && method === 'GET') return json({ ...(await dashboard(env.DB, today)), idsWaiting: await waitingByUnit(env) });
  if (pathname === '/api/units' && method === 'GET') {
    const { units, former } = await overview(env.DB, today);
    return json({ today, units, former });
  }
  if (pathname === '/api/units' && method === 'POST') return json({ success: true, code: await addUnit(env.DB, await readJson(request)) }, 201);
  if (pathname === '/api/export' && method === 'POST') {
    await requirePin(request, env); // every tenant's name, phone and address
    return new Response(JSON.stringify(await exportAll(env.DB), null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="challaghatta-rent-${today}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const seg = pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [resource, id, action] = seg;

  if (resource === 'units' && id) {
    if (seg.length === 2 && method === 'GET') {
      const code = id.toUpperCase();
      return json({ ...(await unitDetail(env.DB, code, today)), waitingIds: await waitingIds(env, code) });
    }
    if (seg.length === 2 && method === 'PUT') {
      await updateUnit(env.DB, id.toUpperCase(), await readJson(request), ownerPin(env));
      return json({ success: true });
    }
  }

  if (resource === 'tenancies') {
    if (seg.length === 1 && method === 'POST') {
      const body = await readJson(request);
      const newId = await createTenancy(env.DB, body);
      const idsAttached = await attachWaiting(env, String(body?.unit_code || '').toUpperCase());
      return json({ success: true, id: newId, idsAttached }, 201);
    }
    if (seg.length === 2 && method === 'PUT') {
      await updateTenancy(env.DB, id, await readJson(request));
      return json({ success: true });
    }
    if (seg.length === 3 && action === 'settlement' && method === 'GET') return json(await settlementPreview(env.DB, id, today));
    if (seg.length === 2 && method === 'DELETE') {
      await deleteTenancy(env.DB, id);
      return json({ success: true });
    }
    if (seg.length === 3 && method === 'POST') {
      if (action === 'end') await endTenancy(env.DB, id, await readJson(request));
      else if (action === 'settle') return json({ success: true, ...(await settleDeposit(env.DB, id, await readJson(request), user.email, today)) });
      else if (action === 'people') return json({ success: true, id: await addPerson(env.DB, id, await readJson(request)) }, 201);
      else if (action === 'link') return json(await linkForTenancy(env, env.DB, id, today));
      else return error('Not found', 404);
      return json({ success: true });
    }
  }

  if (resource === 'people' && id) {
    if (seg.length === 2 && method === 'PUT') {
      await updatePerson(env.DB, id, await readJson(request));
      return json({ success: true });
    }
    if (seg.length === 2 && method === 'DELETE') {
      await deletePerson(env.DB, id);
      return json({ success: true });
    }
    if (seg.length === 3 && action === 'id' && method === 'POST') return json({ success: true, ...(await drive.uploadIdPhoto(env, id, request)) });
  }

  if (resource === 'id-uploads' && id && seg.length === 3 && method === 'POST') {
    if (action === 'attach') await attachUpload(env, id, await readJson(request));
    else if (action === 'dismiss') await dismissUpload(env, id);
    else return error('Not found', 404);
    return json({ success: true });
  }

  if (resource === 'links' && id && seg.length === 3 && method === 'POST') {
    if (action === 'sent') {
      await markSent(env.DB, id, (await readJson(request))?.via);
      return json({ success: true });
    }
    if (action === 'refresh') return json(await refreshLink(env, env.DB, id));
  }

  if (resource === 'payments') {
    if (seg.length === 1 && method === 'GET') {
      const from = url.searchParams.get('from') ? date(url.searchParams.get('from'), 'From') : '2000-01-01';
      const to = url.searchParams.get('to') ? date(url.searchParams.get('to'), 'To') : '2999-12-31';
      return json(await listPayments(env.DB, from, to));
    }
    if (seg.length === 1 && method === 'POST') {
      return json({ success: true, id: await recordPayment(env.DB, await readJson(request), user.email, today) }, 201);
    }
    if (seg.length === 2 && id === 'test' && method === 'DELETE') {
      await requirePin(request, env);
      return json({ success: true, deleted: await deleteTestPayments(env.DB) });
    }
    if (seg.length === 2 && method === 'DELETE') {
      await requirePin(request, env);
      await deletePayment(env.DB, id);
      return json({ success: true });
    }
  }

  return error('Not found', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    // Razorpay calls this directly; it is checked by signature instead of sign-in.
    if (url.pathname === WEBHOOK_PATH && request.method === 'POST') return handleWebhook(request, env, env.DB);

    if (url.pathname === PAIR_PATH) return handlePair(request, env, url);

    const authResponse = await handleAuth(request, env, url);
    if (authResponse) return authResponse;

    if (!isApi && isPublicPath(url.pathname)) return env.ASSETS.fetch(request);

    let user: User | null = await currentUser(request, env);
    if (!user) {
      const phone = await currentDevice(request, env);
      if (phone) user = { email: phone.label, role: 'security', name: phone.label, device: true };
    }
    if (!user) {
      if (isApi) return error('Please sign in', 401);
      return redirect(`${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`);
    }

    if (isApi) {
      try {
        return await handleApi(request, env, url, user);
      } catch (e) {
        if (e instanceof ValidationError) return error(e.message, 400);
        if (e instanceof NotFoundError) return error(e.message, 404);
        console.error('API error', e);
        return error(e instanceof Error ? e.message : 'Something went wrong', 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        await syncOpenLinks(env, env.DB)
          .then((r) => console.log('Razorpay link check', r))
          .catch((e) => console.error('Razorpay link check failed', e));
        await rentReminders(env, env.TEST_TODAY || todayIST())
          .then((r) => console.log('Rent reminders', r))
          .catch((e) => console.error('Rent reminders failed', e));
      })()
    );
  },
};
