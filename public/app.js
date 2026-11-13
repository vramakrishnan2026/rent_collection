// Challaghatta Home rent app. Plain JavaScript, no build step.
// Owner: Home (dashboard) · Units · Payments · ☰ settings.
// Anita (who looks after the building): rent status and Add ID only.

// The person who looks after the building and uses the rent-status / Add ID screens.
const GUARD = 'Anita';

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');
const $busy = document.getElementById('busy');

/** Greys out the whole screen and blocks every tap until hideBusy(). */
function showBusy(text, sub = '') {
  $busy.querySelector('[data-busy-text]').textContent = text;
  $busy.querySelector('[data-busy-sub]').textContent = sub;
  $busy.hidden = false;
  document.activeElement?.blur?.();
}
function hideBusy() {
  $busy.hidden = true;
}
// While busy, swallow keys too (Enter/Space would otherwise press a focused button).
document.addEventListener('keydown', (e) => { if (!$busy.hidden) { e.preventDefault(); e.stopPropagation(); } }, true);

/** fetch that gives up after `ms` so the screen can never stay locked. */
async function fetchWithTimeout(url, opts, ms = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'It took too long. Check the internet and try again.' : 'No internet connection. Try again.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- helpers ----------

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const inr = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (s) => {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const monthOf = (s) => {
  const [y, m] = s.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
const ago = (iso) => {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const METHOD = { razorpay: 'Razorpay', upi: 'UPI', cash: 'Cash', bank: 'Bank transfer', other: 'Other' };
const ID_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Driving licence', 'Voter ID', 'Other'];
const MONTH_CHIP = { paid: ['paid', 'Paid'], partial: ['partial', 'Part paid'], pending: ['pending', 'Pending'], running: ['vacant', 'Running'], 'to-collect': ['upcoming', 'To collect'], future: ['vacant', 'Not started'] };
const STATUS = { paid: 'Paid', pending: 'Pending', vacant: 'Vacant', free: 'Rent-free', upcoming: 'Moving in' };

function toast(text, ms = 2600) {
  $toast.textContent = text;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), ms);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) {
    location.href = '/auth/login?next=' + encodeURIComponent(location.pathname + location.hash);
    throw new Error('Please sign in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- sheets (pop-up forms) ----------

function openSheet(html, onSubmit) {
  $sheet.innerHTML = `<div class="backdrop"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = $sheet.firstElementChild;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop || e.target.closest('[data-close]')) closeSheet();
  });
  const form = $sheet.querySelector('form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const errBox = form.querySelector('.err');
      if (errBox) errBox.remove();
      btn.disabled = true;
      try {
        await onSubmit(formData(form), form);
      } catch (err) {
        form.insertAdjacentHTML('afterbegin', `<div class="err">${esc(err.message)}</div>`);
        btn.disabled = false;
      }
    });
    setTimeout(() => form.querySelector('input:not([type=hidden]),select')?.focus(), 50);
  }
  return $sheet.querySelector('.sheet');
}
const closeSheet = () => ($sheet.innerHTML = '');
// Tenant form: show the "already living here" dates only when ticked.
$sheet.addEventListener('change', (e) => {
  if (e.target.name !== 'existing') return;
  const box = $sheet.querySelector('[data-existing]');
  if (box) box.hidden = !e.target.checked;
  const label = $sheet.querySelector('[data-rent-label]');
  if (label) label.textContent = e.target.checked ? 'Current monthly rent' : 'Monthly rent';
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeSheet());

// ---------- shell ----------

let me = null;

function shell(title, sub, body, tab) {
  const owner = me.role === 'owner';
  const items = [
    ['home', '⌂', 'Home', 'Dashboard'],
    ['units', '▦', 'Units', 'Units'],
    ['send', '📤', 'Send', 'Send links'],
    ['payments', '₹', 'Payments', 'Payments'],
    ['menu', '☰', 'More', 'Settings'],
  ];
  const nav = owner
    ? `<nav class="tabs">
        <div class="brand"><span class="logo">⌂</span><div><b>Challaghatta Home</b><small>Rent collection</small></div></div>
        ${items.map(([k, i, s, l]) => `<a href="#/${k}" class="${tab === k ? 'on' : ''}"><span class="i">${i}</span><span class="s">${s}</span><span class="l">${l}</span></a>`).join('')}
        <a href="#/security" class="lg-only ${tab === 'security' ? 'on' : ''}"><span class="i">◉</span><span class="l">${GUARD}’s view</span></a>
        <div class="who"><span>${esc(me.name || me.email)}</span><a href="/auth/logout">Sign out</a></div>
      </nav>`
    : '';
  $app.innerHTML = `<div class="layout${owner ? ' has-nav' : ''}">${nav}<div class="content">
    <header class="top"><h1>${title}${sub ? `<span class="sub">${sub}</span>` : ''}</h1>${headerExtra}</header>
    <main class="wrap">${body}</main></div></div>`;
  headerExtra = '';
}
let headerExtra = '';

/** ₹1.2L / ₹45K style, for chart labels. */
const compact = (n) => {
  n = Math.round(Number(n) || 0);
  if (n >= 1e7) return '₹' + +(n / 1e7).toFixed(1) + 'Cr';
  if (n >= 1e5) return '₹' + +(n / 1e5).toFixed(1) + 'L';
  if (n >= 1e3) return '₹' + +(n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return '₹' + n;
};

const byFloor = (units) => {
  const floors = [];
  for (const u of units) {
    let f = floors.find((x) => x.name === u.floor);
    if (!f) floors.push((f = { name: u.floor, units: [] }));
    f.units.push(u);
  }
  return floors;
};

function unitMapHtml(units) {
  return `<div class="umap">${byFloor(units)
    .map(
      (f) => `<div class="urow"><span class="fl" title="${esc(f.name)} floor">${esc(f.name.slice(0, 1))}</span>${f.units
        .map(
          (u) => `<a href="#/unit/${esc(u.code)}" class="ucell ${u.status}" title="${esc(u.code)} · ${esc(u.name || STATUS[u.status])}${u.status === 'pending' ? ` · ${plural(u.months, 'month')} due` : ''}">${esc(u.code)}${u.status === 'pending' ? `<i>${u.months}</i>` : ''}</a>`
        )
        .join('')}</div>`
    )
    .join('')}</div>
    <div class="legend"><span><i class="lg paid"></i>Paid</span><span><i class="lg pending"></i>Pending</span><span><i class="lg vacant"></i>Vacant</span><span><i class="lg free"></i>Rent-free</span></div>`;
}

// ---------- owner: dashboard ----------

async function viewHome() {
  const [d, s, q] = await Promise.all([api('/api/dashboard'), api('/api/settings'), api('/api/collect').catch(() => null)]);
  const fyLabel = `FY ${d.financialYear.start.slice(0, 4)}–${d.financialYear.end.slice(2, 4)}`;
  const max = Math.max(1, ...d.months.map((m) => Math.max(m.due, m.collected)));
  const fyDue = d.months.reduce((a, m) => a + m.due, 0);
  const rate = d.dueThisMonth ? Math.min(100, Math.round((d.collected.mtd / d.dueThisMonth) * 100)) : null;
  const fyRate = fyDue ? Math.min(100, Math.round((d.collected.ytd / fyDue) * 100)) : null;

  const chart = `<div class="chart2">
    <div class="yaxis"><span>${compact(max)}</span><span>${compact(max / 2)}</span><span>₹0</span></div>
    <div class="plot"><div class="gl" style="bottom:100%"></div><div class="gl" style="bottom:50%"></div><div class="gl" style="bottom:0"></div>
    ${d.months
      .map(
        (m) => `<div class="col" title="${esc(monthOf(m.month))}: collected ${inr(m.collected)} of ${inr(m.due)} due">
        <div class="bars"><div class="due" style="height:${(m.due / max) * 100}%"></div><div class="got" style="height:${(m.collected / max) * 100}%">${m.collected ? `<b>${compact(m.collected)}</b>` : ''}</div></div>
        <div class="m">${MONTHS[Number(m.month.slice(5)) - 1]}</div></div>`
      )
      .join('')}</div></div>`;

  const pending = d.pending.length
    ? d.pending
        .map(
          (p) => `<div class="row">
          <a class="code red" href="#/unit/${esc(p.unit)}">${esc(p.unit)}</a>
          <div class="main"><div class="t">${esc(p.name)}${p.former ? ' <span class="chip vacant">moved out</span>' : ''}</div>
            <div class="d">${plural(p.months, 'month')} pending${p.lastSentAt ? ` · link sent ${ago(p.lastSentAt)}` : ''}</div></div>
          <div class="amt" style="color:var(--red)">${inr(p.amount)}</div>
          ${p.former ? '' : `<button class="btn small" data-send="${esc(p.tenancyId)}">Send link</button>`}
        </div>`
        )
        .join('')
    : `<div class="empty">✓<span>Nobody owes rent right now.</span></div>`;

  const upcoming = d.upcoming.length
    ? d.upcoming
        .map(
          (u) => `<div class="row"><span class="datechip"><b>${Number(u.date.slice(8))}</b>${MONTHS[Number(u.date.slice(5, 7)) - 1]}</span>
          <div class="main"><div class="t"><a href="#/unit/${esc(u.unit)}">${esc(u.unit)}</a> · ${esc(u.name)}</div><div class="d">${u.date === d.today ? 'Due today' : `Due ${fmtDate(u.date)}`}</div></div>
          <div class="amt">${inr(u.amount)}</div></div>`
        )
        .join('')
    : `<div class="empty"><span>No rent falls due in the next 7 days.</span></div>`;

  const recent = d.recent.length
    ? d.recent
        .map(
          (p) => `<div class="row"><a class="code green" href="#/unit/${esc(p.unit_code)}">${esc(p.unit_code)}</a>
          <div class="main"><div class="t">${esc(p.contact_name)} ${p.test ? '<span class="chip test">test</span>' : ''}</div><div class="d">${fmtDate(p.paid_on)} · ${METHOD[p.method] || esc(p.method)}</div></div>
          <div class="amt" style="color:var(--green)">${inr(p.amount)}</div></div>`
        )
        .join('')
    : `<div class="empty"><span>No payments recorded yet.</span></div>`;

  const banners = [];
  if (!s.razorpay.configured) banners.push('Razorpay isn’t connected yet, so rent links are off. You can still record payments by hand.');
  else if (s.razorpay.mode === 'test') banners.push('Razorpay is in <b>test mode</b>: links take test payments only.' + (d.collected.testTotal ? ` ${inr(d.collected.testTotal)} of test payments are counted (clear them in Settings).` : ''));
  if (d.idsWaiting?.length) banners.push(`📷 New ID photos to attach: ${d.idsWaiting.map((w) => `<a href="#/unit/${esc(w.unit)}"><b>${esc(w.unit)}</b>${w.n > 1 ? ` (${w.n})` : ''}</a>`).join(', ')}`);
  const noTenants = d.occupied === 0 && !d.pending.length;

  headerExtra = `<a class="btn small" href="#/security">◉ ${GUARD}’s view</a>`;
  shell(
    'Dashboard',
    `Challaghatta Home · ${fmtDate(d.today)}`,
    `${banners.map((b) => `<div class="banner">${b}</div>`).join('')}
    ${q && q.toSend ? `<a class="sendbar" href="#/send"><span>📤 <b>Send rent links</b> · ${plural(q.toSend, 'tenant')} to send for ${esc(q.forMonth)}</span><span class="go">Start →</span></a>` : ''}
    ${noTenants ? `<div class="hero"><div><b>Add your first tenant</b><span>Open a unit, add who lives there, their rent and deposit. The dashboard fills in from there.</span></div><a class="btn primary" href="#/units">Go to units</a></div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="l">Collected this month</div><div class="v" style="color:var(--green)">${inr(d.collected.mtd)}</div>
        <div class="bar"><i style="width:${rate ?? 0}%"></i></div><div class="s">${rate === null ? 'Nothing fell due yet this month' : `${rate}% of ${inr(d.dueThisMonth)} due this month`}</div></div>
      <div class="kpi"><div class="l">Collected this year</div><div class="v">${inr(d.collected.ytd)}</div>
        <div class="bar"><i style="width:${fyRate ?? 0}%"></i></div><div class="s">${fyLabel} · ${fyRate === null ? 'April to March' : `${fyRate}% of ${inr(fyDue)} due`}</div></div>
      <div class="kpi ${d.pendingTotal > 0 ? 'red' : ''}"><div class="l">Pending</div><div class="v">${inr(d.pendingTotal)}</div><div class="s">${d.pendingUnits ? `${plural(d.pendingUnits, 'tenant')} behind` : 'Everyone is up to date'}</div></div>
      <div class="kpi"><div class="l">Deposits held</div><div class="v">${inr(d.depositsHeld)}</div><div class="s">Refundable advances</div></div>
    </div>
    <div class="dash-grid">
      <div class="card"><div class="card-h"><h2>${fyLabel}: due vs collected</h2><div class="legend"><span><i style="background:var(--soft);border:1px dashed var(--muted)"></i>Fell due</span><span><i style="background:var(--green)"></i>Collected</span></div></div>${chart}</div>
      <div class="card"><div class="card-h"><h2>Occupancy</h2><span class="big">${d.occupied}<small>/${d.rentableUnits}</small></span></div>
        ${unitMapHtml(d.unitMap)}
        <div class="strip" style="margin-top:.8rem"><span>Monthly rent roll <b>${inr(d.monthlyRentRoll)}</b></span><span>Vacant <b>${d.vacant.length}</b></span></div></div>
    </div>
    <div class="dash-3">
      <div class="card"><div class="card-h"><h2>Pending</h2>${d.pendingTotal ? `<span class="chip pending">${inr(d.pendingTotal)}</span>` : ''}</div><div class="list">${pending}</div></div>
      <div class="card"><div class="card-h"><h2>Due in the next 7 days</h2></div><div class="list">${upcoming}</div></div>
      <div class="card"><div class="card-h"><h2>Recent payments</h2><a class="link" href="#/payments">All →</a></div><div class="list">${recent}</div></div>
    </div>`,
    'home'
  );
}

// ---------- owner: send rent link ----------

async function sendLink(tenancyId) {
  const sheet = openSheet(`<h2>Rent link</h2><p class="note">Creating the Razorpay link…</p>`);
  try {
    const r = await api(`/api/tenancies/${encodeURIComponent(tenancyId)}/link`, { method: 'POST', body: {} });
    sheet.innerHTML = `<h2>Send rent link</h2>
      ${r.test ? '<div class="banner">Test mode: this link only takes test payments.</div>' : ''}
      <div class="msg">${esc(r.message)}</div>
      <div class="actions" style="margin-bottom:.6rem">
        <a class="btn green" ${r.whatsappUrl ? `href="${esc(r.whatsappUrl)}" target="_blank" rel="noopener" data-via="whatsapp"` : 'aria-disabled="true"'}>WhatsApp</a>
        <a class="btn" ${r.smsUrl ? `href="${esc(r.smsUrl)}" data-via="sms"` : 'aria-disabled="true"'}>SMS</a>
      </div>
      <div class="actions"><button class="btn" data-copy>Copy link</button><button class="btn" data-close>Done</button></div>
      <p class="note" style="margin-top:.8rem">When the tenant pays, the payment is recorded automatically.</p>`;
    sheet.querySelectorAll('[data-via]').forEach((a) =>
      a.addEventListener('click', () => api(`/api/links/${encodeURIComponent(r.link.id)}/sent`, { method: 'POST', body: { via: a.dataset.via } }).catch(() => {}))
    );
    sheet.querySelector('[data-copy]').addEventListener('click', async () => {
      await navigator.clipboard.writeText(r.link.short_url).catch(() => {});
      toast('Link copied');
    });
  } catch (e) {
    sheet.innerHTML = `<h2>Rent link</h2><div class="err">${esc(e.message)}</div><button class="btn block" data-close>Close</button>`;
  }
}

// ---------- owner: units ----------

const tileLabel = (u, today) => {
  if (u.tenancy?.bill_from && u.tenancy.bill_from > today) return `<span class="chip vacant">From ${monthOf(u.tenancy.bill_from)}</span>`;
  if (u.status === 'pending') return `<span class="chip pending">${plural(u.tenancy.pendingMonths, 'month')} due</span>`;
  return `<span class="chip ${u.status}">${STATUS[u.status]}</span>`;
};

async function viewUnits() {
  const { units, former, today } = await api('/api/units');
  const floors = [];
  for (const u of units) {
    let f = floors.find((x) => x.name === u.floor);
    if (!f) floors.push((f = { name: u.floor, units: [] }));
    f.units.push(u);
  }
  headerExtra = `<button class="btn small primary" data-add-unit>＋ Add unit</button>`;
  const count = (st) => units.filter((u) => u.status === st).length;
  const filters = [['all', 'All', units.length], ['pending', 'Pending', count('pending')], ['paid', 'Paid', count('paid')], ['vacant', 'Vacant', count('vacant')], ['free', 'Rent-free', count('free')]]
    .filter(([k, , n]) => k === 'all' || n)
    .map(([k, l, n]) => `<button class="fchip ${k === 'all' ? 'on' : ''}" data-filter="${k}">${l} <b>${n}</b></button>`)
    .join('');
  shell(
    'Units',
    `${units.length} units · ${count('paid') + count('pending')} occupied`,
    `<div class="filters">${filters}</div>` +
    floors
      .map(
        (f) => `<section class="floor"><h3>${esc(f.name)} floor</h3><div class="grid">${f.units
          .map(
            (u) => `<a class="tile ${u.status}" data-status="${u.status}" href="#/unit/${esc(u.code)}"><div class="c">${esc(u.code)}</div>
            <div class="n">${esc(u.tenancy?.contact_name || u.note || '')}&nbsp;</div>
            <div class="r">${u.tenancy && !u.rent_free ? `${inr(u.tenancy.currentRent)}/mo` : '&nbsp;'}</div>${tileLabel(u, today)}</a>`
          )
          .join('')}</div></section>`
      )
      .join('') +
      (former.length
        ? `<h2 class="sec">Moved out, still owing</h2><div class="card"><div class="list">${former
            .map((t) => `<div class="row"><span class="code red">${esc(t.unit_code)}</span><div class="main"><div class="t">${esc(t.contact_name)}</div>
            <div class="d">Moved out ${fmtDate(t.end_date)} · ${plural(t.pendingMonths, 'month')}</div></div><div class="amt" style="color:var(--red)">${inr(t.outstanding)}</div></div>`)
            .join('')}</div></div>`
        : ''),
    'units'
  );
  $app.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      $app.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('on', x === b));
      const k = b.dataset.filter;
      $app.querySelectorAll('.tile').forEach((t) => (t.hidden = k !== 'all' && t.dataset.status !== k));
      $app.querySelectorAll('.floor').forEach((f) => (f.hidden = ![...f.querySelectorAll('.tile')].some((t) => !t.hidden)));
    })
  );
  const floorsList = floors.map((f) => f.name);
  $app.querySelector('[data-add-unit]').addEventListener('click', () =>
    openSheet(
      `<h2>Add a unit</h2><form>
        <label class="f">Unit code <input name="code" required maxlength="12" placeholder="e.g. G7" autocapitalize="characters"></label>
        <label class="f">Floor <select name="floor">${floorsList.map((f) => `<option>${esc(f)}</option>`).join('')}<option value="__new">New floor…</option></select></label>
        <label class="f" data-newfloor hidden>New floor name <input name="newFloor" maxlength="30" placeholder="e.g. Fourth"></label>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add unit</button></div></form>`,
      async (v) => {
        const floor = v.floor === '__new' ? v.newFloor : v.floor;
        await api('/api/units', { method: 'POST', body: { code: v.code, floor } });
        closeSheet();
        toast(`Unit ${v.code.toUpperCase()} added`);
        render();
      }
    ).querySelector('select[name=floor]').addEventListener('change', (e) => {
      $sheet.querySelector('[data-newfloor]').hidden = e.target.value !== '__new';
    })
  );
}

// ---------- owner: one unit ----------

function tenancyForm(t, rentFree, prefill = null) {
  return `<form>
    ${prefill?.note ? `<div class="banner">${prefill.note}</div>` : ''}
    <label class="f">Tenant name (rent links are addressed to them) <input name="contact_name" required maxlength="80" value="${esc(t?.contact_name ?? prefill?.contact_name)}"></label>
    <div class="two">
      <label class="f">WhatsApp number <input name="whatsapp" inputmode="tel" placeholder="98xxxxxxxx" value="${esc(t?.whatsapp)}"></label>
      <label class="f">SMS number <small>(if different)</small><input name="phone" inputmode="tel" placeholder="Same as WhatsApp" value="${esc(t?.phone && t.phone !== t.whatsapp ? t.phone : '')}"></label>
    </div>
    <div class="two">
      <label class="f">Move-in date <input name="start_date" type="date" required value="${esc(t?.start_date || todayIST())}"></label>
      ${rentFree ? '<input type="hidden" name="base_rent" value="0">' : `<label class="f"><span data-rent-label>${t?.bill_from || t?.next_increase_on ? 'Current monthly rent' : 'Monthly rent'}</span> (₹) <input name="base_rent" inputmode="numeric" required value="${esc(t?.base_rent ?? '')}"></label>`}
    </div>
    ${rentFree ? '' : `<label class="chk existing"><input type="checkbox" name="existing" ${t?.bill_from || t?.next_increase_on ? 'checked' : ''}> Already living here before this app</label>
    <div class="existing-box" data-existing ${t?.bill_from || t?.next_increase_on ? '' : 'hidden'}>
      <div class="two">
        <label class="f">Charge rent from <input name="bill_from" type="date" value="${esc(t?.bill_from || nextFirst())}"></label>
        <label class="f">Next 5% increase on <input name="next_increase_on" type="date" value="${esc(t?.next_increase_on || '')}"></label>
      </div>
      <p class="note">Nothing before “Charge rent from” is charged or asked for. Enter their current rent above. After the next increase, it goes up 5% every 11 months. Leave the increase date empty to count 11-month cycles from the move-in date instead.</p>
    </div>`}
    <label class="f">Advance / deposit (₹, refundable) <input name="deposit" inputmode="numeric" value="${esc(t?.deposit ?? '')}"></label>
    ${t ? '' : `<label class="f">Everyone living there <small>(one name per line)</small><textarea name="people" rows="3" placeholder="Same as tenant name if left empty">${esc((prefill?.people || []).join('\n'))}</textarea></label>`}
    <label class="f">Notes <textarea name="notes" rows="2" maxlength="500">${esc(t?.notes)}</textarea></label>
    ${rentFree ? '' : '<p class="note">Rent is post-paid for each calendar month (a part month is rent ÷ 30 × days), due by the 10th of the next month. It goes up 5% from the 1st after every 11 months. At move-out, one month’s rent is kept from the deposit for maintenance.</p>'}
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
  </form>`;
}

const nextFirst = () => {
  const [y, m] = todayIST().split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};
const tenancyBody = (v) => ({
  ...v,
  existing: v.existing === 'on',
  phone: v.phone || v.whatsapp,
  base_rent: String(v.base_rent || '0').replace(/[,₹\s]/g, ''),
  deposit: String(v.deposit || '0').replace(/[,₹\s]/g, ''),
});

async function viewUnit(code) {
  const d = await api(`/api/units/${encodeURIComponent(code)}`);
  const { unit, current: t, past } = d;
  headerExtra = `<a class="icon-btn" href="#/units" title="Back">←</a>`;
  let body = '<div class="unit-cols"><div class="ucol">';
  if (d.waitingIds?.length) {
    body += `<div class="card waiting"><div class="card-h"><h2>New IDs to attach</h2><span class="chip upcoming">${d.waitingIds.length}</span></div><div class="list">${d.waitingIds
      .map(
        (w) => `<div class="row wrow"><div class="main"><div class="t">${w.names.length ? esc(w.names.join(', ')) : w.address ? 'Back of card (address)' : w.is_pdf ? 'PDF' : 'Name not read'}${w.id_type ? ` <span class="chip vacant">${esc(w.id_type)}</span>` : ''}</div>
          ${w.address ? `<div class="d addr">📍 ${esc(w.address)}</div>` : ''}
          <div class="d">${fmtDate(w.taken_at)} · ${new Date(w.taken_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · by ${esc(w.uploaded_by)} ·
          <a href="https://drive.google.com/file/d/${esc(w.drive_file_id)}/view" target="_blank" rel="noopener">Open</a></div>
          ${w.review_name && t ? `<div class="review-note">⚠ <b>${esc(w.review_name)}</b> already has an ID on file${w.review_front ? ` (<a href="https://drive.google.com/file/d/${esc(w.review_front)}/view" target="_blank" rel="noopener">current front</a>${w.review_back ? `, <a href="https://drive.google.com/file/d/${esc(w.review_back)}/view" target="_blank" rel="noopener">back</a>` : ''})` : ''}. Compare and choose.</div>
            <div class="wact"><button class="btn small primary" data-use-new="${esc(w.id)}" data-person="${esc(w.review_person_id)}">Use this one</button><button class="btn small" data-keep="${esc(w.id)}">Keep current</button></div>`
          : t ? `<div class="wact"><select data-attach-sel="${esc(w.id)}"><option value="">Attach to…</option>${t.people
              .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.drive_file_id ? ' (has ID)' : ''}</option>`)
              .join('')}<option value="__new">＋ New person…</option></select>
            <button class="btn small danger" data-dismiss="${esc(w.id)}">Dismiss</button></div>`
            : `<div class="wact"><button class="btn small primary" data-tenant-from="${esc(w.id)}">Add as new tenant</button><button class="btn small danger" data-dismiss="${esc(w.id)}">Dismiss</button></div>`}
        </div></div>`
      )
      .join('')}</div></div>`;
  }

  if (!t) {
    body += `<div class="card"><p style="margin-top:0">${unit.rent_free ? 'Rent-free unit. Add who lives here to keep their ID on file.' : 'No tenant right now.'}</p>
      <div class="actions"><button class="btn primary" data-act="add">Add tenant</button>
      <label class="btn">📷 Start from ID photo<input type="file" accept="image/*,application/pdf" data-id-first hidden></label></div>
      <p class="note">Start from an ID photo: the app reads the name off the ID and fills in the form for you. The photo is saved to Drive.</p></div></div><div class="ucol">`;
  } else {
    const owe =
      t.outstanding > 0
        ? `<div class="owe red"><div><div style="font-weight:700">${plural(t.pendingMonths, 'month')} pending</div></div><b>${inr(t.outstanding)}</b></div>`
        : unit.rent_free
          ? `<div class="owe green"><div style="font-weight:700">Rent-free</div></div>`
          : t.bill_from && t.bill_from > d.today
          ? `<div class="owe green"><div style="font-weight:700">Rent starts ${fmtDate(t.bill_from)}</div><b>—</b></div>`
          : `<div class="owe green"><div style="font-weight:700">${t.outstanding < 0 ? 'Paid ahead' : 'All paid'}</div><b>${t.outstanding < 0 ? inr(-t.outstanding) + ' credit' : '✓'}</b></div>`;
    const contact = [t.whatsapp && `WhatsApp ${t.whatsapp}`, t.phone && t.phone !== t.whatsapp && `SMS ${t.phone}`].filter(Boolean).join(' · ') || 'No number yet';
    body += `${t.start_date > d.today ? `<div class="banner">Moves in on ${fmtDate(t.start_date)}.</div>` : ''}${owe}
      <div class="card"><div class="row" style="padding-top:0"><div class="main"><div class="t">${esc(t.contact_name)}</div><div class="d">${esc(contact)}</div></div>
        ${t.phone || t.whatsapp ? `<a class="btn small" href="tel:+91${esc(t.phone || t.whatsapp)}">Call</a>` : ''}</div>
        <div class="facts" style="margin-top:.6rem">
          <div><div class="l">Moved in</div><div class="v">${fmtDate(t.start_date)}${t.bill_from ? `<br><span class="note">charged from ${fmtDate(t.bill_from)}</span>` : ''}</div></div>
          <div><div class="l">Rent now</div><div class="v">${inr(t.currentRent)}</div></div>
          <div><div class="l">Next due</div><div class="v">${t.nextDueDate ? `${fmtDate(t.nextDueDate)}<br><span class="note">${inr(t.nextRent)}</span>` : '—'}</div></div>
          <div><div class="l">Next 5% increase</div><div class="v">${!unit.rent_free && t.nextIncreaseOn ? `${fmtDate(t.nextIncreaseOn)}<br><span class="note">to ${inr(t.nextIncreaseRent)}</span>` : '—'}</div></div>
          <div><div class="l">Deposit</div><div class="v">${inr(t.deposit)}</div></div>
          ${t.notes ? `<div><div class="l">Notes</div><div class="v" style="font-weight:500">${esc(t.notes)}</div></div>` : ''}
        </div></div>
      ${unit.rent_free ? '' : `<div class="actions" style="margin-bottom:.9rem">
        <button class="btn primary" data-send="${esc(t.id)}">Send rent link</button>
        <button class="btn" data-act="pay">Record payment</button></div>`}
      <div class="card"><h2>People &amp; IDs</h2><div class="list">${t.people
        .map(
          (p) => `<div class="row"><div class="main"><div class="t">${esc(p.name)}</div><div class="d">${esc(p.id_type || 'ID type not set')} · ${
            p.drive_file_id
              ? `<a href="https://drive.google.com/file/d/${esc(p.drive_file_id)}/view" target="_blank" rel="noopener">Front</a>${
                  p.back_file_id ? ` · <a href="https://drive.google.com/file/d/${esc(p.back_file_id)}/view" target="_blank" rel="noopener">Back</a>` : ' · <span class="muted">no back</span>'
                } · saved ${fmtDate(p.id_uploaded_at)}`
              : '<span style="color:var(--red)">No ID yet</span>'
          }</div>${p.address ? `<div class="d addr">📍 ${esc(p.address)}</div>` : ''}</div>
          <div class="idbtns"><label class="btn small">${p.drive_file_id ? 'Front ↻' : 'Add ID'}<input type="file" accept="image/*,application/pdf" data-id-for="${esc(p.id)}" data-side="front" hidden></label>
          ${p.drive_file_id ? `<label class="btn small">${p.back_file_id ? 'Back ↻' : '＋ Add back'}<input type="file" accept="image/*,application/pdf" data-id-for="${esc(p.id)}" data-side="back" hidden></label>` : ''}</div>
          <button class="btn small" data-edit-person="${esc(p.id)}" title="Edit">✎</button></div>`
        )
        .join('')}</div>
        <button class="btn small" data-act="person" style="margin-top:.6rem">＋ Add person</button></div>
      <div class="actions" style="margin-bottom:.9rem"><button class="btn" data-act="edit">Edit details</button><button class="btn danger" data-act="end">Move out</button></div>
      </div><div class="ucol">
      ${unit.rent_free ? '' : `<div class="card"><h2>Months</h2><div class="list">${
        t.periods.length
          ? t.periods
              .map(
                (p) => `<div class="row"><div class="main"><div class="t">${monthOf(p.month)}</div>
                <div class="d">${p.full ? '' : `${p.days} days (${Number(p.from.slice(8))}–${Number(p.to.slice(8))}) · `}${p.status === 'future' ? `Charging starts ${fmtDate(p.from)} · due by ${fmtDate(p.due)}` : p.status === 'running' ? 'This month · collect after it ends' : `Due by ${fmtDate(p.due)}`}${p.status === 'partial' ? ` · ${inr(p.paid)} paid` : ''}</div></div>
                <div class="amt">${inr(p.rent)}</div><span class="chip ${MONTH_CHIP[p.status][0]}">${MONTH_CHIP[p.status][1]}</span></div>`
              )
              .join('')
          : '<p class="note">No rent has fallen due yet.</p>'
      }</div></div>
      <div class="card"><h2>Payments</h2><div class="list">${
        t.payments.length
          ? t.payments
              .map(
                (p) => `<div class="row"><div class="main"><div class="t">${inr(p.amount)} ${p.test ? '<span class="chip test">test</span>' : ''}</div>
                <div class="d">${fmtDate(p.paid_on)} · ${METHOD[p.method] || esc(p.method)}${p.reference ? ` · ${esc(p.reference)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div></div>
                <button class="btn small danger" data-del-pay="${esc(p.id)}">Delete</button></div>`
              )
              .join('')
          : '<p class="note">No payments yet.</p>'
      }</div></div>
      ${t.links.length ? `<div class="card"><h2>Rent links</h2><div class="list">${t.links
        .map(
          (l) => `<div class="row"><div class="main"><div class="t">${inr(l.amount)} <span class="chip ${l.status === 'paid' ? 'paid' : l.status === 'created' ? 'upcoming' : 'vacant'}">${l.status === 'created' ? 'Unpaid' : esc(l.status)}</span></div>
          <div class="d">${esc(l.description)} · made ${fmtDate(l.created_at)}${l.sent_at ? ` · sent on ${esc(l.sent_via)} ${ago(l.sent_at)}` : ''}</div></div>
          ${l.status === 'created' ? `<button class="btn small" data-refresh="${esc(l.id)}">Check</button>` : ''}</div>`
        )
        .join('')}</div></div>` : ''}`}`;
  }

  if (past.length) {
    body += `<h2 class="sec">Past tenants</h2><div class="card"><div class="list">${past
      .map(
        (p) => `<div class="row"><div class="main"><div class="t">${esc(p.contact_name)}</div><div class="d">${fmtDate(p.start_date)} – ${fmtDate(p.end_date)} · deposit ${inr(p.deposit)}${
          p.deposit_refunded_on
            ? `: ${p.deposit_maintenance ? `${inr(p.deposit_maintenance)} kept for maintenance, ` : ''}${inr(p.deposit_refund)} refunded ${fmtDate(p.deposit_refunded_on)}`
            : ', not settled yet'
        }</div></div>
        ${p.owedThroughEnd > 0 ? `<div class="amt" style="color:var(--red)">${inr(p.owedThroughEnd)}</div>` : ''}
        ${p.deposit_refunded_on ? '' : `<button class="btn small primary" data-settle="${esc(p.id)}">Settle deposit</button>`}
        ${p.owedThroughEnd > 0 ? `<button class="btn small" data-pay-past="${esc(p.id)}" data-owed="${p.owedThroughEnd}">Record payment</button>` : ''}</div>`
      )
      .join('')}</div></div>`;
  }

  body += `<div class="card"><h2>Unit</h2><div class="row" style="padding:0"><div class="main"><div class="t">Rent-free unit</div>
    <div class="d">${unit.rent_free ? '<span class="chip free">On</span>' : '<span class="chip vacant">Off</span>'}</div></div>
    ${unit.rent_free ? '<button class="btn small" data-rentfree-off>Turn off</button>' : '<button class="btn small" data-rentfree-on>🔒 Turn on</button>'}</div></div>`;

  body += '</div></div>';
  shell(`${esc(unit.code)}`, `${esc(unit.floor)} floor${unit.note ? ' · ' + esc(unit.note) : ''}`, body, 'units');
  wireUnit(d);
}

function wireUnit(d) {
  const { unit, current: t } = d;
  const reload = () => viewUnit(unit.code);
  const on = (sel, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener('click', (e) => fn(el, e)));

  on('[data-use-new]', async (el) => {
    await api(`/api/id-uploads/${encodeURIComponent(el.dataset.useNew)}/attach`, { method: 'POST', body: { person_id: el.dataset.person } }).catch((e) => toast(e.message));
    toast('New ID saved. The old one stays in Drive.', 3000);
    reload();
  });
  on('[data-keep]', async (el) => {
    await api(`/api/id-uploads/${encodeURIComponent(el.dataset.keep)}/dismiss`, { method: 'POST', body: {} }).catch((e) => toast(e.message));
    toast('Kept the current ID. The new photo stays in Drive.', 3000);
    reload();
  });
  on('[data-dismiss]', async (el) => {
    if (!confirm('Dismiss this ID photo? It stays in your Drive.')) return;
    await api(`/api/id-uploads/${encodeURIComponent(el.dataset.dismiss)}/dismiss`, { method: 'POST', body: {} }).catch((e) => toast(e.message));
    reload();
  });
  $app.querySelectorAll('[data-attach-sel]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const id = sel.dataset.attachSel;
      const w = d.waitingIds.find((x) => x.id === id);
      let body;
      if (sel.value === '__new') {
        const name = prompt('Name of the person on this ID', w.names[0] || '');
        if (!name) { sel.value = ''; return; }
        body = { name };
      } else if (sel.value) body = { person_id: sel.value };
      else return;
      try {
        await api(`/api/id-uploads/${encodeURIComponent(id)}/attach`, { method: 'POST', body });
        toast('ID attached');
        reload();
      } catch (e) {
        toast(e.message);
        sel.value = '';
      }
    })
  );

  const addTenant = (prefill = null) =>
    openSheet(`<h2>New tenant · ${esc(unit.code)}</h2>${tenancyForm(null, unit.rent_free, prefill)}`, async (v) => {
      const people = String(v.people || '').split('\n').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
      const r = await api('/api/tenancies', { method: 'POST', body: { ...tenancyBody(v), unit_code: unit.code, people } });
      closeSheet();
      toast(r.idsAttached ? `Tenant added · ${plural(r.idsAttached, 'ID')} attached` : 'Tenant added');
      reload();
    });
  const fromNames = (names) =>
    names.length
      ? { contact_name: names[0], people: names, note: `Name read from the ID: <b>${esc(names.join(', '))}</b>. Check the spelling.` }
      : { note: 'Couldn’t read a name from the ID (PDFs and unclear photos can’t be read). Type it in; the ID is saved and will be attached when the names match.' };
  on('[data-act=add]', () => addTenant());
  on('[data-tenant-from]', (el) => addTenant(fromNames(d.waitingIds.find((w) => w.id === el.dataset.tenantFrom)?.names || [])));
  $app.querySelector('[data-id-first]')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = await uploadIdFile(unit.code, file);
      toast('ID saved', 1500);
      await reload(); // shows the photo under "New IDs" in case the form is closed
      addTenant(fromNames(data.names || []));
    } catch (err) {
      toast(`ID not saved: ${err.message}`, 8000);
    } finally {
      e.target.value = '';
    }
  });
  on('[data-rentfree-on]', () =>
    openSheet(
      `<h2>Make ${esc(unit.code)} rent-free</h2><form>
        <label class="f">PIN <input name="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="20"></label>
        ${t ? `<p class="note">${esc(t.contact_name)}’s rent will be set to ₹0.</p>` : ''}
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Turn on</button></div></form>`,
      async (v) => {
        await api(`/api/units/${encodeURIComponent(unit.code)}`, { method: 'PUT', body: { rent_free: true, pin: v.pin, note: unit.note || GUARD } });
        closeSheet();
        toast(`${unit.code} is now rent-free`);
        reload();
      }
    )
  );
  on('[data-rentfree-off]', async () => {
    if (!confirm(`Turn off rent-free for ${unit.code}? Rent will be charged from now; set the tenant’s rent in Edit details.`)) return;
    await api(`/api/units/${encodeURIComponent(unit.code)}`, { method: 'PUT', body: { rent_free: false, note: unit.note === GUARD ? '' : unit.note } }).catch((e) => toast(e.message));
    reload();
  });
  on('[data-settle]', (el) => settleSheet(el.dataset.settle, reload));
  on('[data-pay-past]', (el) => paymentSheet(el.dataset.payPast, Number(el.dataset.owed), reload));
  if (!t) return;

  on('[data-act=pay]', () => paymentSheet(t.id, t.collectable > 0 ? t.collectable : t.nextRent || t.currentRent, reload));
  on('[data-act=edit]', () =>
    openSheet(`<h2>Edit · ${esc(unit.code)}</h2>${tenancyForm(t, unit.rent_free)}`, async (v) => {
      await api(`/api/tenancies/${encodeURIComponent(t.id)}`, { method: 'PUT', body: tenancyBody(v) });
      closeSheet();
      toast('Saved');
      reload();
    })
  );
  on('[data-act=end]', () =>
    openSheet(
      `<h2>Move out · ${esc(t.contact_name)}</h2><form>
        <label class="f">Move-out date <input type="date" name="end_date" required value="${todayIST()}"></label>
        <p class="note">The last day they stay. That month is charged for the days up to this date. Next you’ll settle the ${inr(t.deposit)} deposit: one month’s rent kept for maintenance, plus any rent still owed.</p>
        ${t.payments.length ? '' : '<p class="note">Added by mistake? <a href="#" data-delete-tenancy>Delete this tenant</a> instead.</p>'}
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Move out</button></div></form>`,
      async (v) => {
        await api(`/api/tenancies/${encodeURIComponent(t.id)}/end`, { method: 'POST', body: v });
        closeSheet();
        toast('Moved out');
        await reload();
        settleSheet(t.id, reload);
      }
    ).querySelector('[data-delete-tenancy]')?.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(`Delete ${t.contact_name} from ${unit.code}?`)) return;
      await api(`/api/tenancies/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).catch((err) => toast(err.message));
      closeSheet();
      reload();
    })
  );
  const confirmPerson = (d) =>
    openSheet(
      `<h2>New person from the ID</h2><form>
        <div class="banner">${d.names?.length ? `Read from the ID: <b>${esc(readSummary(d))}</b>. Check the spelling.` : 'The name couldn’t be read (PDFs and unclear photos can’t be read). Type it in.'}</div>
        <label class="f">Name <input name="name" required maxlength="80" value="${esc(d.names?.[0] || '')}"></label>
        <div class="actions"><button type="button" class="btn" data-close>Later</button><button class="btn primary" type="submit">Add person</button></div>
        <p class="note">If you choose Later, the ID waits under “New IDs to attach” on this unit.</p></form>`,
      async (v) => {
        await api(`/api/id-uploads/${encodeURIComponent(d.uploadId)}/attach`, { method: 'POST', body: { name: v.name } });
        closeSheet();
        toast(`${v.name} added with their ID. Use “＋ Add back” for the other side.`, 5000);
        reload();
      }
    );
  on('[data-act=person]', () => {
    const sheet = openSheet(
      `<h2>Add person · ${esc(unit.code)}</h2><form>
        <label class="btn green block" style="margin-bottom:.4rem">📷 From ID photo<input type="file" accept="image/*,application/pdf" data-person-id-file hidden></label>
        <p class="note" style="margin-top:0">Take or choose a photo of their ID: the name, ID type and address are read from it and the ID is saved. Or type the name below.</p>
        <label class="f">Name <input name="name" required maxlength="80"></label>
        <label class="f">ID type <select name="id_type"><option value="">Choose…</option>${ID_TYPES.map((x) => `<option>${x}</option>`).join('')}</select></label>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Add</button></div></form>`,
      async (v) => {
        await api(`/api/tenancies/${encodeURIComponent(t.id)}/people`, { method: 'POST', body: v });
        closeSheet();
        reload();
      }
    );
    sheet.querySelector('[data-person-id-file]').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const d = await uploadIdFile(unit.code, file);
        if (d.review) {
          closeSheet();
          toast(`${d.names.join(', ')} already has an ID. The new photo is waiting under “New IDs to attach” for you to compare.`, 6000);
          return reload();
        }
        if (d.status === 'linked') {
          closeSheet();
          toast(`ID attached to ${d.names.join(', ')}, already listed here`, 4000);
          return reload();
        }
        if (d.paired) {
          closeSheet();
          toast('Back of the card: address added to the person from the front', 4000);
          return reload();
        }
        await reload();
        confirmPerson(d);
      } catch (err) {
        sheet.querySelector('form').insertAdjacentHTML('afterbegin', `<div class="err">ID not saved: ${esc(err.message)}</div>`);
      }
    });
  });
  on('[data-edit-person]', (el) => {
    const p = t.people.find((x) => x.id === el.dataset.editPerson);
    const sheet = openSheet(
      `<h2>${esc(p.name)}</h2><form>
        <label class="f">Name <input name="name" required maxlength="80" value="${esc(p.name)}"></label>
        <label class="f">ID type <select name="id_type"><option value="">Choose…</option>${ID_TYPES.map((x) => `<option ${x === p.id_type ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="f">Address (from the ID) <textarea name="address" rows="3" maxlength="300">${esc(p.address)}</textarea></label>
        <div class="actions"><button type="button" class="btn danger" data-remove>Remove</button><button class="btn primary" type="submit">Save</button></div></form>`,
      async (v) => {
        await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'PUT', body: v });
        closeSheet();
        reload();
      }
    );
    sheet.querySelector('[data-remove]').addEventListener('click', async () => {
      if (!confirm(`Remove ${p.name}? Their ID photo stays in your Drive.`)) return;
      await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch((e) => toast(e.message));
      closeSheet();
      reload();
    });
  });
  $app.querySelectorAll('[data-id-for]').forEach((input) =>
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const back = input.dataset.side === 'back';
        const d = await uploadIdFile(unit.code, file, input.dataset.idFor, back ? 'back' : 'front');
        toast(`${back ? 'Back' : 'ID'} saved${readSummary(d) ? ` · ${readSummary(d)}` : ''}`, 4000);
        reload();
      } catch (e) {
        toast(`ID not saved: ${e.message}`, 8000);
      } finally {
        input.value = '';
      }
    })
  );
  on('[data-del-pay]', (el) => {
    const p = t.payments.find((x) => x.id === el.dataset.delPay);
    pinSheet(`Delete ${inr(p.amount)} paid on ${fmtDate(p.paid_on)}?`, 'Delete payment', async (pin) => {
      await api(`/api/payments/${encodeURIComponent(p.id)}`, { method: 'DELETE', body: { pin } });
      toast('Payment deleted');
      reload();
    });
  });
  on('[data-refresh]', async (el) => {
    const r = await api(`/api/links/${encodeURIComponent(el.dataset.refresh)}/refresh`, { method: 'POST', body: {} }).catch((e) => toast(e.message));
    if (r) toast(r.status === 'paid' ? 'Paid ✓' : 'Not paid yet');
    reload();
  });
}

/** Asks for the owner PIN, then runs `action(pin)`. A wrong PIN shows the error and keeps the box open. */
function pinSheet(question, button, action) {
  openSheet(
    `<h2>${esc(question)}</h2><form>
      <label class="f">PIN <input name="pin" type="password" inputmode="numeric" autocomplete="off" required maxlength="20"></label>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary danger-fill" type="submit">${esc(button)}</button></div></form>`,
    async (v) => {
      await action(v.pin);
      closeSheet();
    }
  );
}

/** Owner upload of one ID photo/PDF: saved to Drive, type/name/address read. personId = attach to that person. */
async function uploadIdFile(unitCode, file, personId = null, side = 'front') {
  showBusy('Saving the ID and reading the details…', 'Please wait. This can take up to a minute.');
  try {
    return await uploadIdFileInner(unitCode, file, personId, side);
  } finally {
    hideBusy();
  }
}
async function uploadIdFileInner(unitCode, file, personId, side) {
  const form = new FormData();
  form.append('unit', unitCode);
  form.append('takenAt', new Date().toISOString());
  if (personId) form.append('person_id', personId);
  if (personId && side === 'back') form.append('side', 'back');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) form.append('photo', new Blob([file], { type: 'application/pdf' }), 'id.pdf');
  else {
    const p = await preparePhoto(file).catch(() => ({ photo: file, preview: null }));
    form.append('photo', p.photo, 'id.jpg');
    if (p.preview) form.append('preview', p.preview);
  }
  const res = await fetchWithTimeout('/api/id-uploads', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Upload failed (${res.status})`);
  return data;
}
const readSummary = (d) =>
  [d.idType, d.names?.length ? d.names.join(', ') : null, d.address ? 'address read' : null].filter(Boolean).join(' · ');

async function settleSheet(tenancyId, done) {
  const sheet = openSheet('<h2>Settle deposit</h2><p class="note">Working it out…</p>');
  let s;
  try {
    s = await api(`/api/tenancies/${encodeURIComponent(tenancyId)}/settlement`);
  } catch (e) {
    sheet.innerHTML = `<h2>Settle deposit</h2><div class="err">${esc(e.message)}</div><button class="btn block" data-close>Close</button>`;
    return;
  }
  sheet.innerHTML = `<h2>Settle deposit</h2><form>
    <div class="settle">
      <div><span>Deposit</span><b>${inr(s.deposit)}</b></div>
      <div><span>Kept for maintenance <small>(one month’s rent)</small></span><input name="maintenance" inputmode="numeric" value="${s.maintenance}"></div>
      <div><span>Rent still owed${s.unpaidMonths.length ? `<small>${s.unpaidMonths.map((m) => `${esc(m.month)}${m.full ? '' : ` (${m.days} days)`}: ${inr(m.amount)}`).join(' · ')}</small>` : ''}</span><b>${inr(s.owed)}</b></div>
      <label class="chk"><input type="checkbox" name="take_rent" ${s.owed ? 'checked' : 'disabled'}> Take the rent owed from the deposit</label>
      <div class="total"><span>Refund to tenant</span><b data-refund-total></b></div>
      <p class="note" data-still></p>
    </div>
    <label class="f">Date <input type="date" name="date" required max="${todayIST()}" value="${todayIST()}"></label>
    <div class="actions"><button type="button" class="btn" data-close>Later</button><button class="btn primary" type="submit">Save settlement</button></div></form>`;
  const form = sheet.querySelector('form');
  const calc = () => {
    const m = Math.max(0, Math.min(s.deposit, Number(String(form.maintenance.value).replace(/[,₹\s]/g, '')) || 0));
    const take = form.take_rent.checked ? Math.min(s.owed, s.deposit - m) : 0;
    form.querySelector('[data-refund-total]').textContent = inr(s.deposit - m - take);
    const still = s.owed - take;
    form.querySelector('[data-still]').textContent = still > 0 ? `${inr(still)} of rent is still owed after this. It stays on the pending list.` : '';
  };
  form.addEventListener('input', calc);
  calc();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const r = await api(`/api/tenancies/${encodeURIComponent(tenancyId)}/settle`, {
        method: 'POST',
        body: { maintenance: String(form.maintenance.value).replace(/[,₹\s]/g, '') || '0', take_rent: form.take_rent.checked, date: form.date.value },
      });
      closeSheet();
      toast(`Settled · refund ${inr(r.refund)}`);
      done();
    } catch (err) {
      form.insertAdjacentHTML('afterbegin', `<div class="err">${esc(err.message)}</div>`);
      btn.disabled = false;
    }
  });
}

function paymentSheet(tenancyId, amount, done) {
  openSheet(
    `<h2>Record payment</h2><form>
      <div class="two"><label class="f">Amount (₹) <input name="amount" inputmode="numeric" required value="${esc(amount || '')}"></label>
      <label class="f">Date paid <input type="date" name="paid_on" required max="${todayIST()}" value="${todayIST()}"></label></div>
      <label class="f">How <select name="method">${Object.entries(METHOD).map(([k, v]) => `<option value="${k}" ${k === 'upi' ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="f">Reference <small>(UTR / cheque no., optional)</small><input name="reference" maxlength="80"></label>
      <label class="f">Note <input name="note" maxlength="300"></label>
      <p class="note">Part payments are fine: they clear the oldest month first.</p>
      <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`,
    async (v) => {
      await api('/api/payments', { method: 'POST', body: { ...v, amount: String(v.amount).replace(/[,₹\s]/g, ''), tenancy_id: tenancyId } });
      closeSheet();
      toast('Payment recorded');
      done();
    }
  );
}

/** Resizes photos to at most 1800px (keeps uploads fast); PDFs go as they are. */
async function shrink(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return new File([blob], 'id.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

// ---------- owner: payments ----------

async function viewPayments(month) {
  month = month || todayIST().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = await api(`/api/payments?from=${month}-01&to=${month}-${String(last).padStart(2, '0')}`);
  const total = rows.reduce((a, p) => a + p.amount, 0);
  headerExtra = `<input type="month" value="${month}" data-month class="btn small" style="padding:.45rem .6rem">`;
  shell(
    'Payments',
    `${monthOf(month)} · ${inr(total)} from ${plural(rows.length, 'payment')}`,
    `${rows.length ? `<div class="kpis kpis-3">${Object.entries(
      rows.reduce((acc, p) => ((acc[p.method] = (acc[p.method] || 0) + p.amount), acc), {})
    )
      .map(([k, v]) => `<div class="kpi"><div class="l">${METHOD[k] || esc(k)}</div><div class="v">${inr(v)}</div></div>`)
      .join('')}</div>` : ''}
    <div class="card tcard">${
      rows.length
        ? `<table class="tbl"><thead><tr><th>Date</th><th>Unit</th><th>Tenant</th><th class="hide-sm">Method</th><th class="hide-sm">Reference</th><th class="num">Amount</th></tr></thead><tbody>${rows
            .map(
              (p) => `<tr><td>${fmtDate(p.paid_on)}</td><td><a class="code sm" href="#/unit/${esc(p.unit_code)}">${esc(p.unit_code)}</a></td>
              <td>${esc(p.contact_name)} ${p.test ? '<span class="chip test">test</span>' : ''}<div class="show-sm d">${METHOD[p.method] || esc(p.method)}</div></td>
              <td class="hide-sm">${METHOD[p.method] || esc(p.method)}</td><td class="hide-sm mono">${esc(p.reference || '—')}</td><td class="num"><b>${inr(p.amount)}</b></td></tr>`
            )
            .join('')}</tbody><tfoot><tr><td colspan="3"><b>Total</b></td><td class="hide-sm"></td><td class="hide-sm"></td><td class="num"><b>${inr(total)}</b></td></tr></tfoot></table>`
        : '<div class="empty"><span>No payments this month.</span></div>'
    }</div>`,
    'payments'
  );
  $app.querySelector('[data-month]').addEventListener('change', (e) => e.target.value && viewPayments(e.target.value));
}

// ---------- reminders (web push) ----------

const urlB64ToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg && (await reg.pushManager.getSubscription());
  return sub ? 'on' : 'off';
}
async function renderPushCard() {
  const box = $app.querySelector('[data-push]');
  if (!box) return;
  const st = await pushState().catch(() => 'unsupported');
  const iphone = /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;
  box.innerHTML =
    st === 'on'
      ? `<p class="note" style="margin-top:0"><b>On.</b> At 9 AM on the 1st you’ll get “Rent links ready”, and on the 3rd a reminder if any are left.</p>
         <div class="actions"><button class="btn small" data-push-test>Send a test</button><button class="btn small" data-push-off>Turn off</button></div>`
      : st === 'blocked'
      ? '<p class="note" style="margin-top:0">Notifications are blocked for this site. Allow them in the browser’s site settings, then come back.</p>'
      : st === 'unsupported' || iphone
      ? `<p class="note" style="margin-top:0">${iphone ? 'On iPhone, add this app to the Home Screen first (Share › Add to Home Screen), open it from there, then turn reminders on here.' : 'This browser can’t show reminders. Open the app in Chrome.'}</p>`
      : `<p class="note" style="margin-top:0">Get a reminder on this phone at 9 AM on the 1st to send the rent links, and on the 3rd if any are left.</p>
         <button class="btn small primary" data-push-on>Turn on reminders</button>`;
  box.querySelector('[data-push-on]')?.addEventListener('click', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      if ((await Notification.requestPermission()) !== 'granted') return renderPushCard();
      const { publicKey } = await api('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(publicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('Reminders are on');
    } catch (e) {
      toast(`Couldn’t turn on reminders: ${e.message}`, 6000);
    }
    renderPushCard();
  });
  box.querySelector('[data-push-off]')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    renderPushCard();
  });
  box.querySelector('[data-push-test]')?.addEventListener('click', async () => {
    const r = await api('/api/push/test', { method: 'POST', body: {} }).catch((e) => toast(e.message));
    if (r) toast(r.sent ? 'Test sent. It should appear in a few seconds.' : 'The test couldn’t be sent. Turn reminders off and on again.', 4000);
  });
}

// ---------- owner: Send all ----------

const sendState = { skipped: new Set(), focus: null, links: {}, errors: {} };

async function viewSend() {
  const q = await api('/api/collect');
  const ready = (i) => i.hasPhone && !sendState.skipped.has(i.tenancyId);
  const queue = q.items.filter((i) => !i.sentThisMonth && ready(i));
  const cur = (sendState.focus && q.items.find((i) => i.tenancyId === sendState.focus)) || queue[0] || null;
  const sent = q.items.filter((i) => i.sentThisMonth).length;
  const pct = q.items.length ? Math.round((sent / q.items.length) * 100) : 100;
  const chip = (i) =>
    i.sentThisMonth ? `<span class="chip paid">Sent ✓</span>`
    : !i.hasPhone ? '<span class="chip vacant">No number</span>'
    : sendState.skipped.has(i.tenancyId) ? '<span class="chip vacant">Skipped</span>'
    : cur && i.tenancyId === cur.tenancyId ? '<span class="chip upcoming">Now</span>'
    : '<span class="chip pending">To send</span>';
  shell(
    'Send rent links',
    `${esc(q.forMonth)} rent · ${sent} of ${q.items.length} sent`,
    q.items.length
      ? `<div class="sendprog"><i style="width:${pct}%"></i></div>
      ${cur ? `<div class="card sendcard" data-card>
          <div class="sc-top"><span class="code">${esc(cur.unit)}</span><div class="main"><div class="t">${esc(cur.name)}</div>
            <div class="d">${cur.overdueMonths ? `<span style="color:var(--red)">${plural(cur.overdueMonths, 'month')} overdue</span> · ` : ''}${cur.sentThisMonth ? 'Already sent this month' : 'Not sent yet'}</div></div>
            <div class="amt">${inr(cur.amount)}</div></div>
          <div class="msg" data-msg>Getting the link…</div>
          <div class="actions sc-btns"><a class="btn green" data-wa aria-disabled="true">WhatsApp</a><a class="btn" data-sms aria-disabled="true">SMS</a></div>
          <button class="btn block small" data-skip style="margin-top:.5rem">Skip for now</button>
        </div>`
        : `<div class="card"><div class="empty">✓<span>${sent === q.items.length ? `All ${plural(sent, 'link')} sent for ${esc(q.forMonth)}.` : 'Nothing left in the queue. Skipped tenants and those without a number are listed below.'}</span></div></div>`}
      <h2 class="sec">Everyone</h2><div class="card"><div class="list">${q.items
        .map(
          (i) => `<div class="row"><a class="code" href="#/unit/${esc(i.unit)}">${esc(i.unit)}</a><div class="main"><div class="t">${esc(i.name)}</div>
          <div class="d">${inr(i.amount)}${i.lastSentAt ? ` · last sent ${ago(i.lastSentAt)}` : ''}</div></div>${chip(i)}
          ${i.hasPhone && (!cur || i.tenancyId !== cur.tenancyId) ? `<button class="btn small" data-focus="${esc(i.tenancyId)}">${i.sentThisMonth ? 'Resend' : 'Send'}</button>` : ''}</div>`
        )
        .join('')}</div></div>`
      : '<div class="card"><div class="empty">✓<span>Nobody owes rent for a month that has ended.</span></div></div>',
    'send'
  );
  $app.querySelectorAll('[data-focus]').forEach((b) =>
    b.addEventListener('click', () => {
      sendState.focus = b.dataset.focus;
      sendState.skipped.delete(b.dataset.focus);
      viewSend();
      window.scrollTo(0, 0);
    })
  );
  if (!cur) return;
  $app.querySelector('[data-skip]').addEventListener('click', () => {
    sendState.skipped.add(cur.tenancyId);
    sendState.focus = null;
    viewSend();
  });
  // Make (or reuse) the Razorpay link, then arm the WhatsApp/SMS buttons.
  let r = sendState.links[cur.tenancyId];
  if (!r) {
    try {
      r = sendState.links[cur.tenancyId] = await api(`/api/tenancies/${encodeURIComponent(cur.tenancyId)}/link`, { method: 'POST', body: {} });
    } catch (e) {
      const m = $app.querySelector('[data-msg]');
      if (m) m.outerHTML = `<div class="err">${esc(e.message)}</div>`;
      return;
    }
  }
  const card = $app.querySelector('[data-card]');
  if (!card) return;
  card.querySelector('[data-msg]').textContent = r.message;
  const arm = (el, href, via) => {
    if (!href) return;
    el.href = href;
    el.removeAttribute('aria-disabled');
    if (via === 'whatsapp') el.target = '_blank';
    el.addEventListener('click', () => {
      fetch(`/api/links/${encodeURIComponent(r.link.id)}/sent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ via }), keepalive: true }).catch(() => {});
      delete sendState.links[cur.tenancyId];
      sendState.focus = null;
      // When you come back from WhatsApp, the next tenant is ready.
      setTimeout(() => location.hash.startsWith('#/send') && viewSend(), 1200);
    });
  };
  arm(card.querySelector('[data-wa]'), r.whatsappUrl, 'whatsapp');
  arm(card.querySelector('[data-sms]'), r.smsUrl, 'sms');
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && location.hash.startsWith('#/send') && me?.role === 'owner') viewSend().catch(() => {});
});

// ---------- owner: more ----------

function idReadingHtml(r) {
  if (!r?.connected) return '<p class="note" style="margin-top:0">Cloudflare Workers AI isn’t connected, so names and addresses can’t be read. Check that the latest deploy finished.</p>';
  const l = r.last;
  if (!l) return '<p class="note" style="margin-top:0">Connected. No ID has been read yet.</p>';
  const when = `${fmtDate(l.at)} ${new Date(l.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  if (l.ok)
    return `<p class="note" style="margin-top:0">Last ID (${when}): read ✓ ${(l.cards || [])
      .map((c) => `${esc(c.type || 'card')}${c.name ? ' · name' : ''}${c.address ? ' · address' : ''}`)
      .join('; ')}</p>`;
  return `<p class="note" style="margin-top:0">Last ID (${when}): <b style="color:var(--red)">nothing read</b>. What the reader replied (digits hidden):</p>
    <div class="msg mono">${esc((l.tries || [l.error]).join('\n'))}</div>`;
}

async function viewMenu() {
  const s = await api('/api/settings');
  const rz = s.razorpay;
  shell(
    'Settings',
    esc(me.email),
    `<div class="card"><h2>Razorpay</h2>
      <p style="margin-top:0"><b>${rz.configured ? (rz.mode === 'live' ? 'Connected · live' : 'Connected · test mode') : 'Not connected'}</b></p>
      <p class="note">${rz.configured ? 'Rent links are created through your Razorpay account.' : 'Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as secrets in Cloudflare to switch rent links on.'}</p>
      <p class="note">Webhook URL (Razorpay › Webhooks, event <b>payment_link.paid</b>):</p>
      <p class="mono">${esc(s.webhookUrl)}</p>
      <p class="note">Webhook secret: <b>${rz.webhook ? 'set' : 'not set (add RAZORPAY_WEBHOOK_SECRET)'}</b>. Without it, payments are still picked up by a daily check at 9 AM, or when you tap Check.</p>
      <button class="btn small danger" data-clear-test>🔒 Delete test payments</button></div>
    <div class="card"><h2>Google Drive (tenant IDs)</h2>
      <p class="note" style="margin-top:0">${s.drive.connected ? 'Linked. ID photos go to “Challaghatta Home › Tenant IDs › unit”.' : s.drive.configured ? 'Not linked yet.' : 'Google isn’t set up on the server.'}</p>
      ${s.drive.connected ? '<button class="btn small" data-drive-off>🔒 Unlink</button>' : `<button class="btn small primary" data-drive-on ${s.drive.configured ? '' : 'disabled'}>🔒 Link Google Drive</button>`}</div>
    <div class="card"><h2>Reminders on this phone</h2><div data-push><p class="note" style="margin-top:0">Checking…</p></div></div>
    <div class="card"><h2>Reading IDs</h2>${idReadingHtml(s.idReading)}</div>
    <div class="card"><div class="card-h"><h2>${GUARD}’s phone</h2><button class="btn small primary" data-pair>＋ Add a phone</button></div>
      <p class="note" style="margin-top:0">${GUARD}’s phone signs in with a one-time code, no Gmail needed. It sees only rent status and Add ID.</p>
      <div class="list" data-devices><p class="note">Loading…</p></div>
      <a class="btn small" href="#/security" style="margin-top:.6rem">Open ${GUARD}’s screen</a></div>
    <div class="card"><h2>Data</h2><button class="btn small" data-export>🔒 Download backup</button></div>
    <a class="btn block" href="/auth/logout">Sign out</a>`,
    'menu'
  );
  renderPushCard();
  const loadDevices = async () => {
    const box = $app.querySelector('[data-devices]');
    if (!box) return;
    const r = await api('/api/devices').catch(() => null);
    if (!r) return (box.innerHTML = '<p class="note">Couldn’t load phones.</p>');
    box.innerHTML =
      (r.devices.length
        ? r.devices
            .map(
              (d) => `<div class="row"><span class="code">📱</span><div class="main"><div class="t">${esc(d.label)}</div>
              <div class="d">Added ${fmtDate(d.created_at)}${d.last_seen ? ` · last used ${ago(d.last_seen)}` : ''}</div></div>
              <button class="btn small danger" data-unpair="${esc(d.id)}" data-label="${esc(d.label)}">🔒 Remove</button></div>`
            )
            .join('')
        : '<p class="note">No phones paired yet.</p>') +
      (r.openCodes.length ? `<p class="note">${plural(r.openCodes.length, 'code')} waiting to be used. <a href="#" data-cancel-codes>Cancel</a></p>` : '');
    box.querySelectorAll('[data-unpair]').forEach((b) =>
      b.addEventListener('click', () =>
        pinSheet(`Remove ${b.dataset.label}? That phone is signed out straight away and needs a new code to get back in.`, 'Remove phone', async (pin) => {
          await api(`/api/devices/${encodeURIComponent(b.dataset.unpair)}`, { method: 'DELETE', body: { pin } });
          toast(`${b.dataset.label} removed`);
          loadDevices();
        })
      )
    );
    box.querySelector('[data-cancel-codes]')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/devices/codes', { method: 'DELETE' });
      loadDevices();
    });
  };
  loadDevices();
  $app.querySelector('[data-pair]').addEventListener('click', () =>
    openSheet(
      `<h2>Add ${GUARD}’s phone</h2><form>
        <label class="f">Name for this phone <input name="label" maxlength="40" value="${GUARD}" placeholder="e.g. ${GUARD} – new phone"></label>
        <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Get code</button></div></form>`,
      async (v) => {
        const r = await api('/api/devices/pair', { method: 'POST', body: v });
        const msg = `Hi ${GUARD}, this is the Challaghatta Home app.\nOpen this link on your phone: ${r.link}\nOr open ${location.origin} and enter the code ${r.code}.`;
        const sheet = $sheet.querySelector('.sheet');
        sheet.innerHTML = `<h2>Code for ${esc(r.label)}</h2>
          <div class="paircode">${r.code.slice(0, 3)} ${r.code.slice(3)}</div>
          <p class="note" style="text-align:center">Works once, until ${new Date(r.expiresAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
          <div class="actions" style="margin:.8rem 0"><a class="btn green" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Send on WhatsApp</a><button class="btn" data-copy>Copy link</button></div>
          <div class="msg"><b>On ${GUARD}’s phone</b>
• Android: open the link in Chrome, then ⋮ › Add to Home screen.
• iPhone: open ${esc(location.host)} in Safari, Share › Add to Home Screen, open the new icon, tap “${GUARD}? Enter your code” and type the code.</div>
          <button class="btn block" data-close>Done</button>`;
        sheet.querySelector('[data-copy]').addEventListener('click', async () => {
          await navigator.clipboard.writeText(r.link).catch(() => {});
          toast('Link copied');
        });
        $sheet.querySelector('.backdrop').addEventListener('click', (e) => e.target.closest('[data-close]') && loadDevices());
      }
    )
  );
  $app.querySelector('[data-clear-test]').addEventListener('click', () =>
    pinSheet('Delete every payment made with Razorpay test keys?', 'Delete test payments', async (pin) => {
      const r = await api('/api/payments/test', { method: 'DELETE', body: { pin } });
      toast(`${plural(r.deleted, 'test payment')} deleted`);
    })
  );
  $app.querySelector('[data-drive-off]')?.addEventListener('click', () =>
    pinSheet('Unlink Google Drive? New ID photos can’t be saved until it’s linked again.', 'Unlink', async (pin) => {
      await api('/api/drive/disconnect', { method: 'POST', body: { pin } });
      toast('Google Drive unlinked');
      viewMenu();
    })
  );
  $app.querySelector('[data-drive-on]')?.addEventListener('click', () =>
    pinSheet('Link Google Drive for tenant ID photos', 'Continue to Google', async (pin) => {
      const r = await api('/api/drive/connect', { method: 'POST', body: { pin } });
      location.href = r.url;
    })
  );
  $app.querySelector('[data-export]').addEventListener('click', () =>
    pinSheet('Download a backup of all tenants, payments and IDs?', 'Download', async (pin) => {
      const res = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `challaghatta-rent-${todayIST()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Backup downloaded');
    })
  );
}

// ---------- security guard: rent status + Add ID (English / Nepali) ----------
// Nepali: please have it checked by a native speaker.

const GT = {
  en: {
    status: 'Rent status', addId: 'Add ID',
    pendingHead: (n) => `${n === 1 ? 'unit has' : 'units have'} rent pending.<br>Remind the tenant.`,
    allPaid: 'All rent is paid.', remind: 'Remind tenant', month: 'month', months: 'months', floor: 'floor',
    paid: 'Paid ✓', vacant: 'Vacant', free: 'Rent-free', upcoming: 'Moving in', signOut: 'Sign out', updated: 'Updated',
    whichUnit: 'Which unit is the ID for?', change: 'Change', empty: 'Empty',
    intro: 'Take a clear photo of each person’s ID, front and back. Check it, then tap Submit.',
    take: 'Take photo', gallery: 'Choose photo or PDF', tips: 'Tips: lay the ID flat, fill the frame, avoid glare.',
    review: 'Check the photo', reviewHint: 'Is the ID clear and the name easy to read?',
    retake: 'Retake', submit: 'Submit', lockNote: 'After you submit, the ID can’t be changed or deleted.',
    submitted: 'Submitted', uploading: 'Submitting…', saved: 'Saved', nameRead: 'Name', noName: 'Name not read. That’s OK, it’s saved.',
    reviewNote: 'Saved. The owner will review it.',
    busy: 'Sending the ID and reading the details…', busySub: 'Please wait. Don’t close the app.',
    addrRead: 'address read ✓', backPaired: 'Back of card: address added ✓', backSaved: 'Back of card: address read. Saved.',
    failed: 'Failed. Tap to try again', driveMissing: 'Google Drive isn’t linked yet. Please tell the owner.', none: 'Nothing submitted yet.',
    guideTitle: 'How to add a tenant’s ID', guideStart: 'Add an ID now',
    guide: [
      ['📷', 'Tap the <b>Add ID</b> tab at the top.'],
      ['🏠', 'Choose the tenant’s unit, for example <b>G3</b>. The tenant’s name is shown under it.'],
      ['📸', 'Tap <b>Take photo</b>. Lay the ID flat, fill the screen with it, and avoid glare. Take the <b>front and the back</b> as two photos. For a PDF, tap <b>Choose photo or PDF</b>.'],
      ['👀', 'Check the photo. If it is blurred or the name can’t be read, tap <b>Retake</b>.'],
      ['✅', 'If it is clear, tap <b>Submit</b>.'],
    ],
    afterTitle: 'After you tap Submit',
    after: [
      ['☁️', 'The photo goes straight to the owner’s Google Drive. It is not kept on your phone.'],
      ['📝', 'The app reads the name and address on the ID and shows them under <b>Submitted</b>. If they aren’t read, that’s OK. The photo is still saved. Send the back right after the front: the address is joined to the same person.'],
      ['🔒', 'After you submit, the photo <b>can’t be changed, deleted or seen again</b>. If you sent a wrong photo, just tell the owner.'],
      ['👤', 'The owner checks it and attaches it to the right tenant.'],
      ['⚠️', 'If it says <b>Failed</b>, check the internet and tap it to try again.'],
    ],
  },
  ne: {
    status: 'भाडाको स्थिति', addId: 'परिचयपत्र थप्नुहोस्',
    pendingHead: (n) => `वटा कोठाको भाडा बाँकी छ।<br>भाडावाललाई सम्झाउनुहोस्।`,
    allPaid: 'सबै भाडा तिरिएको छ।', remind: 'भाडावाललाई सम्झाउनुहोस्', month: 'महिना', months: 'महिना', floor: 'तल्ला',
    paid: 'तिरेको ✓', vacant: 'खाली', free: 'भाडा छैन', upcoming: 'सर्दैछन्', signOut: 'साइन आउट', updated: 'अपडेट भयो',
    whichUnit: 'परिचयपत्र कुन कोठाको हो?', change: 'बदल्नुहोस्', empty: 'खाली',
    intro: 'हरेक व्यक्तिको परिचयपत्रको अगाडि र पछाडि स्पष्ट फोटो खिच्नुहोस्। जाँच गरेर Submit थिच्नुहोस्।',
    take: 'फोटो खिच्नुहोस्', gallery: 'फोटो वा PDF छान्नुहोस्', tips: 'सुझाव: परिचयपत्रलाई समतल राख्नुहोस्, पूरै फ्रेममा देखाउनुहोस्, चमक नपरोस्।',
    review: 'फोटो जाँच गर्नुहोस्', reviewHint: 'परिचयपत्र स्पष्ट छ र नाम पढ्न सकिन्छ?',
    retake: 'फेरि खिच्नुहोस्', submit: 'पठाउनुहोस्', lockNote: 'पठाएपछि परिचयपत्र बदल्न वा मेटाउन सकिँदैन।',
    submitted: 'पठाइएका', uploading: 'पठाउँदै…', saved: 'सुरक्षित भयो', nameRead: 'नाम', noName: 'नाम पढ्न सकिएन। ठीक छ, फोटो सुरक्षित भयो।',
    reviewNote: 'सुरक्षित भयो। मालिकले जाँच गर्नुहुनेछ।',
    busy: 'परिचयपत्र पठाउँदै र विवरण पढ्दै…', busySub: 'कृपया पर्खनुहोस्। एप बन्द नगर्नुहोस्।',
    addrRead: 'ठेगाना पढियो ✓', backPaired: 'पछाडिको भाग: ठेगाना थपियो ✓', backSaved: 'पछाडिको भाग: ठेगाना पढियो। सुरक्षित भयो।',
    failed: 'असफल भयो। फेरि प्रयास गर्न थिच्नुहोस्', driveMissing: 'Google Drive अझै जोडिएको छैन। कृपया मालिकलाई भन्नुहोस्।', none: 'अहिलेसम्म केही पठाइएको छैन।',
    guideTitle: 'भाडावालको परिचयपत्र कसरी थप्ने', guideStart: 'अहिले परिचयपत्र थप्नुहोस्',
    guide: [
      ['📷', 'माथिको <b>परिचयपत्र थप्नुहोस्</b> ट्याब थिच्नुहोस्।'],
      ['🏠', 'भाडावालको कोठा छान्नुहोस्, जस्तै <b>G3</b>। कोठामुनि भाडावालको नाम देखिन्छ।'],
      ['📸', '<b>फोटो खिच्नुहोस्</b> थिच्नुहोस्। परिचयपत्रलाई समतल राख्नुहोस्, पूरै स्क्रिनमा देखाउनुहोस्, चमक नपरोस्। <b>अगाडि र पछाडि</b> दुवैको छुट्टाछुट्टै फोटो खिच्नुहोस्। PDF भए <b>फोटो वा PDF छान्नुहोस्</b> थिच्नुहोस्।'],
      ['👀', 'फोटो जाँच गर्नुहोस्। धमिलो छ वा नाम पढ्न सकिँदैन भने <b>फेरि खिच्नुहोस्</b> थिच्नुहोस्।'],
      ['✅', 'स्पष्ट छ भने <b>पठाउनुहोस्</b> थिच्नुहोस्।'],
    ],
    afterTitle: 'पठाउनुहोस् थिचेपछि के हुन्छ',
    after: [
      ['☁️', 'फोटो सिधै मालिकको Google Drive मा जान्छ। तपाईंको फोनमा राखिँदैन।'],
      ['📝', 'एपले परिचयपत्रको नाम र ठेगाना पढेर <b>पठाइएका</b> सूचीमा देखाउँछ। पढ्न नसके पनि ठीक छ, फोटो सुरक्षित हुन्छ। अगाडिको भाग पठाएपछि तुरुन्तै पछाडिको भाग पठाउनुहोस्, ठेगाना सोही व्यक्तिसँग जोडिन्छ।'],
      ['🔒', 'पठाएपछि फोटो <b>बदल्न, मेटाउन वा फेरि हेर्न सकिँदैन</b>। गलत फोटो पठाउनुभयो भने मालिकलाई भन्नुहोस्।'],
      ['👤', 'मालिकले जाँचेर सही भाडावालसँग जोड्नुहुन्छ।'],
      ['⚠️', '<b>असफल भयो</b> देखिए इन्टरनेट जाँच गरेर त्यसलाई थिच्नुहोस्, फेरि पठाइन्छ।'],
    ],
  },
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
let lang = store.get('cr-lang') || null; // set after /api/me: Nepali by default for Anita, English for the owner
const gt = () => GT[lang];

function guardHeader(active) {
  const back = me.role === 'owner' ? '<a class="icon-btn" href="#/home" title="Back">←</a>' : '';
  headerExtra = `${back}<div class="langs" role="radiogroup" aria-label="Language / भाषा">
      <button role="radio" aria-checked="${lang === 'en'}" data-lang="en">English</button>
      <button role="radio" aria-checked="${lang === 'ne'}" data-lang="ne" lang="ne">नेपाली</button></div>`;
  return `<div class="seg"><a href="#/security" class="${active === 'status' ? 'on' : ''}">${gt().status}</a><a href="#/ids" class="${active === 'ids' ? 'on' : ''}">📷 ${gt().addId}</a></div>`;
}
function wireLang(again) {
  $app.querySelectorAll('[data-lang]').forEach((b) =>
    b.addEventListener('click', () => {
      lang = b.dataset.lang;
      store.set('cr-lang', lang);
      document.documentElement.lang = lang;
      again();
    })
  );
}

function guideHtml() {
  const T = gt();
  const open = store.get('cr-guide') !== 'closed';
  const steps = (list, numbered) =>
    `<ol class="gsteps${numbered ? '' : ' plain'}">${list.map(([icon, text]) => `<li><span class="gi">${icon}</span><span>${text}</span></li>`).join('')}</ol>`;
  return `<details class="card guide" ${open ? 'open' : ''}><summary>📘 ${T.guideTitle}</summary>
    ${steps(T.guide, true)}
    <h3>${T.afterTitle}</h3>
    ${steps(T.after, false)}
    <a class="btn green block" href="#/ids">📷 ${T.guideStart}</a></details>`;
}

async function viewSecurity() {
  const d = await api('/api/security');
  const T = gt();
  const pending = d.units.filter((u) => u.status === 'pending').sort((a, b) => b.months - a.months);
  const mo = (n) => `<div class="months">${n}<small>${n === 1 ? T.month : T.months}</small></div>`;
  const label = (u) => `<span class="chip ${u.status}">${{ paid: T.paid, vacant: T.vacant, free: T.free, upcoming: T.upcoming }[u.status] || ''}</span>`;
  const top = guardHeader('status');
  headerExtra += '<button class="icon-btn" data-reload title="Refresh">↻</button>';
  shell(
    T.status,
    `Challaghatta Home · ${fmtDate(d.today)}`,
    `${top}${guideHtml()}${pending.length
      ? `<div class="sec-head red"><div class="big">${pending.length}</div><div class="txt">${T.pendingHead(pending.length)}</div></div>`
      : `<div class="sec-head green"><div class="big">✓</div><div class="txt">${T.allPaid}</div></div>`}
    <div class="sec-pend">${pending
      .map(
        (u) => `<div class="sec-row pending"><span class="code">${esc(u.code)}</span>
        <div class="main" style="flex:1"><div class="t">${esc(u.name || '')}</div><div class="act">⚠ ${T.remind}</div></div>${mo(u.months)}</div>`
      )
      .join('')}</div>
    <div class="sec-grid">${byFloor(d.units)
      .map(
        (f) => `<div><h2 class="sec">${esc(f.name)} ${T.floor}</h2>${f.units
          .map(
            (u) => `<div class="sec-row ${u.status === 'pending' ? 'pending' : ''}"><span class="code">${esc(u.code)}</span>
            <div style="flex:1"><div class="t">${esc(u.name || '')}</div></div>${u.status === 'pending' ? mo(u.months) : label(u)}</div>`
          )
          .join('')}</div>`
      )
      .join('')}</div>
    ${me.role === 'owner' || me.device ? '' : `<a class="btn block" href="/auth/logout" style="margin-top:1.5rem">${T.signOut}</a>`}`,
    'security'
  );
  wireLang(viewSecurity);
  $app.querySelector('details.guide')?.addEventListener('toggle', (e) => store.set('cr-guide', e.target.open ? 'open' : 'closed'));
  $app.querySelector('[data-reload]').addEventListener('click', () => viewSecurity().then(() => toast(gt().updated)));
}

// --- Add ID: pick unit → photo → review → Submit (one way: no delete afterwards)

let idUnit = (() => { try { return sessionStorage.getItem('cr-id-unit'); } catch { return null; } })();
const setIdUnit = (u) => { idUnit = u; try { u ? sessionStorage.setItem('cr-id-unit', u) : sessionStorage.removeItem('cr-id-unit'); } catch {} };
let idDraft = null; // { file, url, isPdf, takenAt } waiting for review
const idSent = [];   // this visit's submissions (read-only)

async function preparePhoto(file) {
  const img = await createImageBitmap(file);
  const draw = (max) => {
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  };
  const photo = await new Promise((r) => draw(2000).toBlob(r, 'image/jpeg', 0.85));
  const preview = draw(1280).toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, '');
  const thumb = draw(200).toDataURL('image/jpeg', 0.6);
  img.close?.();
  return { photo, preview, thumb };
}

async function viewIds() {
  const d = await api('/api/security');
  const T = gt();
  const top = guardHeader('ids');
  const unit = d.units.find((u) => u.code === idUnit);
  let body;
  if (!unit) {
    body = `<h2 class="pick-h">${T.whichUnit}</h2>${byFloor(d.units)
      .map(
        (f) => `<h2 class="sec">${esc(f.name)} ${T.floor}</h2><div class="grid">${f.units
          .map((u) => `<button class="tile pick" data-unit="${esc(u.code)}"><div class="c">${esc(u.code)}</div><div class="n">${esc(u.name || T.empty)}</div></button>`)
          .join('')}</div>`
      )
      .join('')}`;
  } else if (idDraft) {
    body = `<div class="unitbar"><span>⌂ ${esc(unit.code)}${unit.name ? ` · ${esc(unit.name)}` : ''}</span></div>
      <div class="card review"><h2>${T.review}</h2>
        ${idDraft.isPdf ? `<div class="pdfbox">📄 ${esc(idDraft.file.name)}</div>` : `<img src="${idDraft.url}" alt="">`}
        <p class="note">${T.reviewHint}</p>
        <div class="actions"><button class="btn" data-retake>${T.retake}</button><button class="btn green" data-submit>${T.submit}</button></div>
        <p class="note lock">🔒 ${T.lockNote}</p></div>`;
  } else {
    body = `<div class="unitbar"><span>⌂ ${esc(unit.code)}${unit.name ? ` · ${esc(unit.name)}` : ''}</span><button class="btn small" data-change>${T.change}</button></div>
      <p class="note" style="font-size:.95rem">${T.intro}</p>
      <button class="btn green block big-btn" data-camera>📷 ${T.take}</button>
      <button class="btn block" data-gallery style="margin-top:.6rem">${T.gallery}</button>
      <p class="note">${T.tips}</p>
      <input type="file" accept="image/*" capture="environment" data-file="camera" hidden>
      <input type="file" accept="image/*,application/pdf,.pdf" data-file="gallery" hidden>`;
  }
  body += `<h2 class="sec">${T.submitted}</h2><div class="card"><div class="list">${
    idSent.length
      ? idSent
          .map(
            (s, i) => `<div class="row" ${s.status === 'failed' ? `data-retry="${i}" style="cursor:pointer"` : ''}>
            ${s.thumb ? `<img class="thumb" src="${s.thumb}" alt="">` : '<span class="code">📄</span>'}
            <div class="main"><div class="t">${esc(s.unit)} · ${new Date(s.at).toLocaleTimeString(lang === 'ne' ? 'ne-NP' : 'en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
            <div class="d">${
              s.status === 'uploading' ? T.uploading
              : s.status === 'failed' ? `<span style="color:var(--red)">${s.drive ? T.driveMissing : T.failed}${!s.drive && s.error ? `<br><small>${esc(s.error)}</small>` : ''}</span>`
              : s.review ? `${T.nameRead}: <b>${esc(s.names.join(', '))}</b> · ${T.reviewNote}`
              : s.names.length ? `${s.idType ? `${esc(s.idType)} · ` : ''}${T.nameRead}: <b>${esc(s.names.join(', '))}</b>${s.address ? ` · ${T.addrRead}` : ''}`
              : s.address ? (s.paired ? T.backPaired : T.backSaved) : s.isPdf ? T.saved : T.noName
            }</div></div>
            ${s.status === 'saved' ? '<span class="chip paid">✓</span>' : ''}</div>`
          )
          .join('')
      : `<p class="note">${T.none}</p>`
  }</div></div>
  ${me.role === 'owner' || me.device ? '' : `<a class="btn block" href="/auth/logout" style="margin-top:1.5rem">${T.signOut}</a>`}`;
  shell(T.addId, `Challaghatta Home`, top + body, 'security');
  wireLang(viewIds);

  $app.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => { setIdUnit(b.dataset.unit); viewIds(); }));
  $app.querySelector('[data-change]')?.addEventListener('click', () => { setIdUnit(null); viewIds(); });
  $app.querySelector('[data-camera]')?.addEventListener('click', () => $app.querySelector('[data-file=camera]').click());
  $app.querySelector('[data-gallery]')?.addEventListener('click', () => $app.querySelector('[data-file=gallery]').click());
  $app.querySelectorAll('[data-file]').forEach((input) =>
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const now = Date.now();
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      idDraft = { file, isPdf, url: isPdf ? '' : URL.createObjectURL(file), takenAt: new Date(file.lastModified && file.lastModified <= now ? file.lastModified : now).toISOString() };
      viewIds();
    })
  );
  $app.querySelector('[data-retake]')?.addEventListener('click', () => {
    if (idDraft?.url) URL.revokeObjectURL(idDraft.url);
    idDraft = null;
    viewIds();
  });
  $app.querySelector('[data-submit]')?.addEventListener('click', () => {
    const draft = idDraft;
    idDraft = null;
    const item = { unit: idUnit, at: Date.now(), draft, isPdf: draft.isPdf, status: 'uploading', names: [], thumb: draft.isPdf ? '' : draft.url };
    idSent.unshift(item);
    viewIds();
    sendId(item);
  });
  $app.querySelectorAll('[data-retry]').forEach((r) => r.addEventListener('click', () => sendId(idSent[Number(r.dataset.retry)])));
}

async function sendId(item) {
  item.status = 'uploading';
  item.error = '';
  showBusy(gt().busy, gt().busySub);
  const redraw = () => location.hash.startsWith('#/ids') && viewIds().catch(() => {});
  redraw();
  try {
    const form = new FormData();
    form.append('unit', item.unit);
    form.append('takenAt', item.draft.takenAt);
    // Some computers don't label PDFs; say what it is so the server accepts it.
    if (item.draft.isPdf) form.append('photo', new Blob([item.draft.file], { type: 'application/pdf' }), 'id.pdf');
    else {
      const p = item.prepared || (item.prepared = await preparePhoto(item.draft.file).catch(() => ({ photo: item.draft.file, preview: null, thumb: '' })));
      if (p.thumb) item.thumb = p.thumb;
      form.append('photo', p.photo, 'id.jpg');
      if (p.preview) form.append('preview', p.preview);
    }
    const res = await fetchWithTimeout('/api/id-uploads', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      item.drive = data.error === 'drive_not_linked';
      item.error = data.message || data.error || `Error ${res.status}`;
      throw new Error(item.error);
    }
    item.status = 'saved';
    item.names = data.names || [];
    item.idType = data.idType || null;
    item.address = Boolean(data.address);
    item.paired = Boolean(data.paired);
    item.review = Boolean(data.review);
    item.draft = null; // locked: nothing kept to resend or change
  } catch (e) {
    item.status = 'failed';
    if (!item.error) item.error = navigator.onLine === false ? 'No internet' : e?.message || '';
  } finally {
    hideBusy();
  }
  redraw();
}

// ---------- routing ----------

document.addEventListener('click', (e) => {
  const send = e.target.closest('[data-send]');
  if (send) sendLink(send.dataset.send);
});

async function render() {
  closeSheet();
  const [route, arg] = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (route === 'ids') return await viewIds();
    if (me.role !== 'owner') return await viewSecurity();
    if (route === 'units') return await viewUnits();
    if (route === 'unit' && arg) return await viewUnit(decodeURIComponent(arg));
    if (route === 'payments') return await viewPayments();
    if (route === 'send') return await viewSend();
    if (route === 'menu') return await viewMenu();
    if (route === 'security') return await viewSecurity();
    return await viewHome();
  } catch (e) {
    $app.innerHTML = `<main class="wrap"><div class="err" style="margin-top:2rem">${esc(e.message)}</div><a class="btn" href="#/home">Home</a></main>`;
  } finally {
    window.scrollTo(0, 0);
  }
}

window.addEventListener('hashchange', render);
(async () => {
  try {
    me = await api('/api/me');
  } catch (e) {
    $app.innerHTML = `<main class="wrap"><div class="err" style="margin-top:2rem">${esc(e.message)}</div></main>`;
    return;
  }
  if (!lang) lang = me.role === 'owner' ? 'en' : 'ne';
  if (me.role === 'owner' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  document.documentElement.lang = me.role === 'owner' ? 'en' : lang;
  await render();
  // Keep the guard's screen fresh if it stays open.
  if (me.role !== 'owner') setInterval(() => !$sheet.innerHTML && viewSecurity(), 5 * 60 * 1000);
})();
