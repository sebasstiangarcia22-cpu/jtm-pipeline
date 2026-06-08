// Dashboard logic: read production rankings from Supabase and render them.
const cfg = window.JTM_CONFIG || {};
const statusEl = document.getElementById('status');

const money = (n) => {
  const v = Number(n) || 0;
  const s = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? '-' + s : s;
};
const netCell = (n) => `<td class="num ${Number(n) < 0 ? 'neg' : 'pos'}">${money(n)}</td>`;

function table(rows, cols) {
  if (!rows || !rows.length) return '<div class="state">No data yet.</div>';
  const head = cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('');
  const body = rows.map((r, i) => '<tr>' + cols.map((c) => c.render(r, i)).join('') + '</tr>').join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function load() {
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
    statusEl.textContent = 'config missing';
    document.getElementById('bdm').innerHTML =
      '<div class="state">Falta configurar la URL y la llave en <code>config.js</code>.</div>';
    document.getElementById('ib').innerHTML = '';
    return;
  }

  const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const { data: bdm, error: e1 } = await db.rpc('public_bdm_ranking');
  const { data: ib,  error: e2 } = await db.rpc('public_ib_ranking');

  if (e1 || e2) {
    statusEl.textContent = 'error';
    document.getElementById('bdm').innerHTML =
      `<div class="state neg">${(e1 || e2).message}</div>`;
    return;
  }
  statusEl.textContent = 'live';

  // KPIs
  const { data: kpi } = await db.rpc('public_kpis');
  if (kpi && kpi[0]) {
    const k = kpi[0];
    document.getElementById('kpis').innerHTML = [
      ['Total Net', money(k.total_net), Number(k.total_net) < 0 ? 'neg' : 'pos'],
      ['This Month', money(k.month_net), Number(k.month_net) < 0 ? 'neg' : 'pos'],
      ['Total FTDs', k.total_ftds, ''],
      ['Deposits', k.deposits_n, ''],
    ].map(([lbl, val, cls]) =>
      `<div class="kpi"><div class="kpi-val ${cls}">${val}</div><div class="kpi-lbl">${lbl}</div></div>`).join('');
  }

  // Monthly cards
  const { data: months } = await db.rpc('public_monthly');
  const monthsEl = document.getElementById('months');
  if (months && months.length) {
    const curYm = new Date().toISOString().slice(0, 7);
    const bestNet = Math.max(...months.map((m) => Number(m.net)));
    monthsEl.innerHTML = months.map((m) => {
      const cls = m.ym === curYm ? 'current' : (Number(m.net) === bestNet ? 'best' : '');
      const amtCls = Number(m.net) < 0 ? 'neg' : 'pos';
      return `<div class="month-card ${cls}">
        <div class="mc-label">${m.label}</div>
        <div class="mc-amount ${amtCls}">${money(m.net)}</div>
        <div class="mc-meta">${m.deposits_n} deps · ${m.ftds} FTDs</div>
        <div class="mc-gross">Gross ${money(m.deposits)}</div>
      </div>`;
    }).join('');
  } else {
    monthsEl.innerHTML = '<div class="state">No monthly data.</div>';
  }

  document.getElementById('bdm').innerHTML = table(bdm, [
    { label: '#', render: (r, i) => `<td>${i + 1}</td>` },
    { label: 'Commercial', render: (r) => `<td>${r.bdm}</td>` },
    { label: 'Role', render: (r) => r.active === false
        ? `<td><span class="badge former">FORMER</span></td>`
        : `<td><span class="badge">${r.role.toUpperCase()}</span></td>` },
    { label: 'Deposits', num: true, render: (r) => `<td class="num">${r.deposits_n}</td>` },
    { label: 'FTDs', num: true, render: (r) => `<td class="num">${r.ftds}</td>` },
    { label: 'Gross USD', num: true, render: (r) => `<td class="num gross">${money(r.deposits)}</td>` },
    { label: 'Net USD', num: true, render: (r) => netCell(r.net) },
  ]);

  document.getElementById('ib').innerHTML = table(ib, [
    { label: '#', render: (r, i) => `<td>${i + 1}</td>` },
    { label: 'IB', render: (r) => `<td>${r.ib}</td>` },
    { label: 'BDM', render: (r) => `<td><span class="badge">${r.bdm || '—'}</span></td>` },
    { label: 'Clients', num: true, render: (r) => `<td class="num">${r.clients}</td>` },
    { label: 'Deposits', num: true, render: (r) => `<td class="num">${r.deposits_n}</td>` },
    { label: 'FTDs', num: true, render: (r) => `<td class="num">${r.ftds}</td>` },
    { label: 'Net USD', num: true, render: (r) => netCell(r.net) },
  ]);

  // Deposit register (searchable)
  const { data: reg } = await db.rpc('public_register');
  const regEl = document.getElementById('register');
  const renderReg = (q = '') => {
    const needle = q.toLowerCase();
    const rows = (reg || []).filter((r) =>
      !needle || [r.client, r.bdm, r.source, r.country, r.ib].some((v) => (v || '').toLowerCase().includes(needle)));
    const note = rows.length > 100
      ? `<div class="reg-note">Showing first 100 of ${rows.length} — refine your search to narrow.</div>` : '';
    regEl.innerHTML = table(rows.slice(0, 100), [
      { label: 'Date', render: (r) => `<td>${r.date}</td>` },
      { label: 'Client', render: (r) => `<td>${r.client}</td>` },
      { label: 'BDM', render: (r) => `<td>${r.bdm || '—'}</td>` },
      { label: 'Type', render: (r) => `<td>${r.type === 'withdrawal' ? 'Withdrawal' : 'Deposit'}</td>` },
      { label: 'Source', render: (r) => `<td>${r.ib ? 'IB ' + r.ib.replace(/ \(IB\)$/, '') : (r.source || '—')}</td>` },
      { label: 'Country', render: (r) => `<td>${r.country || '—'}</td>` },
      { label: 'FTD', render: (r) => `<td>${r.is_ftd ? '<span class="ftd-yes">✓</span>' : ''}</td>` },
      { label: 'Amount', num: true, render: (r) => netCell(r.amount) },
    ]) + note;
  };
  renderReg();
  document.getElementById('reg-search').addEventListener('input', (e) => renderReg(e.target.value));
}

load().catch((e) => { statusEl.textContent = 'error'; console.error(e); });
