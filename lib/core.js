import { neon } from '@neondatabase/serverless';
import { put, del } from '@vercel/blob';

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL || '');
const TZ = process.env.APP_TZ || 'Asia/Kolkata';
const ORDER = ['IN', 'LUNCH_OUT', 'LUNCH_IN', 'OUT'];
const LABEL = { IN: 'IN', LUNCH_OUT: 'LUNCH OUT', LUNCH_IN: 'LUNCH IN', OUT: 'OUT' };
const DEFAULTS = {
  companyName: 'ADSTYLE', shiftHours: '8', lunchFallback: '0.5', weeklyOff: 'Sun',
  adminPin: process.env.ADMIN_PIN || '1947', cameraMode: 'native', dailyEmail: ''
};

/* ---------- database set-up: runs itself, nothing to paste anywhere ---------- */
let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = sql.transaction([
      sql`CREATE TABLE IF NOT EXISTS employees (emp_id text PRIMARY KEY, name text NOT NULL,
        active boolean NOT NULL DEFAULT true, monthly_salary numeric NOT NULL DEFAULT 0,
        tea_allowance numeric NOT NULL DEFAULT 0, shift_hours numeric NOT NULL DEFAULT 8,
        join_date text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '')`,
      sql`CREATE TABLE IF NOT EXISTS punches (id bigserial PRIMARY KEY, ts timestamptz NOT NULL,
        date_key text NOT NULL, emp_id text NOT NULL, name text NOT NULL, punch_type text NOT NULL,
        time_hhmm text NOT NULL, photo_url text NOT NULL DEFAULT '', photo_id text NOT NULL DEFAULT '',
        source text NOT NULL DEFAULT 'KIOSK', note text NOT NULL DEFAULT '')`,
      sql`CREATE UNIQUE INDEX IF NOT EXISTS punches_one_per_type ON punches (date_key, emp_id, punch_type)`,
      sql`CREATE INDEX IF NOT EXISTS punches_emp_date ON punches (emp_id, date_key)`,
      sql`CREATE TABLE IF NOT EXISTS day_status (date_key text NOT NULL, emp_id text NOT NULL,
        status text NOT NULL, note text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (date_key, emp_id))`,
      sql`CREATE TABLE IF NOT EXISTS advances (adv_id text PRIMARY KEY, date_key text NOT NULL,
        emp_id text NOT NULL, amount numeric NOT NULL, kind text NOT NULL DEFAULT 'MONTH',
        note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now())`,
      sql`CREATE TABLE IF NOT EXISTS payments (pay_id text PRIMARY KEY, date_key text NOT NULL,
        emp_id text NOT NULL, amount numeric NOT NULL, note text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now())`,
      sql`CREATE TABLE IF NOT EXISTS loan_recovery (month_key text NOT NULL, emp_id text NOT NULL,
        recovered numeric NOT NULL DEFAULT 0, note text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (month_key, emp_id))`,
      sql`CREATE TABLE IF NOT EXISTS month_settings (month_key text NOT NULL, emp_id text NOT NULL,
        weekly_off text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (month_key, emp_id))`,
      sql`CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL DEFAULT '')`,
      sql`CREATE TABLE IF NOT EXISTS audit_log (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(),
        action text NOT NULL, details text NOT NULL DEFAULT '')`
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}

/* ---------- date and time (the server clock only, in the factory's time zone) ---------- */
const fmtParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const P = d => Object.fromEntries(fmtParts.formatToParts(d).map(x => [x.type, x.value]));
export const dateKey = d => { const p = P(d); return `${p.year}-${p.month}-${p.day}`; };
export const hhmm = d => { const p = P(d); return `${p.hour}:${p.minute}`; };
const ddmmyy = dk => { const p = dk.split('-'); return `${p[2]}-${p[1]}-${p[0].slice(2)}`; };
const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const wd = dk => {
  const [y, m, d] = dk.split('-').map(Number);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const mins = t => { const p = String(t).split(':'); return +p[0] * 60 + +p[1]; };
const r2 = n => Math.round(n * 100) / 100;
const to12 = t => {
  if (!t) return '';
  const [h0, m] = String(t).split(':'); let h = +h0; const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (!h) h = 12; return `${h}:${m} ${ap}`;
};
const initials = n => { const p = String(n).trim().split(/\s+/); return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase(); };

async function log(action, details) {
  try { await sql`INSERT INTO audit_log (action, details) VALUES (${action}, ${details})`; } catch (e) {}
}

/* ---------- settings and login ---------- */
let sc = { t: 0, v: null };
export async function getSettings() {
  if (sc.v && Date.now() - sc.t < 5000) return sc.v;
  const rows = await sql`SELECT key, value FROM settings`;
  const v = { ...DEFAULTS };
  rows.forEach(r => { v[r.key] = r.value; });
  sc = { t: Date.now(), v };
  return v;
}
export async function saveSettings(obj) {
  for (const k of Object.keys(DEFAULTS)) {
    if (obj && k in obj) {
      await sql`INSERT INTO settings (key, value) VALUES (${k}, ${String(obj[k] ?? '')})
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    }
  }
  sc = { t: 0, v: null };
  await log('SETTINGS_SAVED', 'settings changed');
  return getSettings();
}
export async function checkPin(pin) {
  const s = await getSettings();
  return !!pin && String(pin) === String(s.adminPin);
}
export async function adminLogin(pin) {
  const ok = await checkPin(pin);
  if (!ok) await new Promise(r => setTimeout(r, 800));   // slows down guessing
  return ok;
}

/* ---------- employees ---------- */
const mapEmp = r => ({
  row: 0, empId: r.emp_id, name: r.name, active: r.active,
  monthlySalary: Number(r.monthly_salary) || 0, teaAllowance: Number(r.tea_allowance) || 0,
  shiftHours: Number(r.shift_hours) || 8, joinDate: r.join_date || '', notes: r.notes || ''
});
export async function getEmployees(activeOnly) {
  const rows = activeOnly
    ? await sql`SELECT * FROM employees WHERE active ORDER BY name`
    : await sql`SELECT * FROM employees ORDER BY name`;
  return rows.map(mapEmp);
}
export async function saveEmployee(e) {
  const id = e.empId || 'E' + Date.now();
  const name = String(e.name || '').toUpperCase().trim();
  await sql`INSERT INTO employees (emp_id, name, active, monthly_salary, tea_allowance, shift_hours, join_date, notes)
    VALUES (${id}, ${name}, ${!!e.active}, ${Number(e.monthlySalary) || 0}, ${Number(e.teaAllowance) || 0},
            ${Number(e.shiftHours) || 8}, ${e.joinDate || ''}, ${e.notes || ''})
    ON CONFLICT (emp_id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active,
      monthly_salary = EXCLUDED.monthly_salary, tea_allowance = EXCLUDED.tea_allowance,
      shift_hours = EXCLUDED.shift_hours, join_date = EXCLUDED.join_date, notes = EXCLUDED.notes`;
  await log(e.empId ? 'EMP_UPDATE' : 'EMP_ADD', id + ' ' + name);
  return getEmployees(false);
}

/* ---------- kiosk ---------- */
function statusOf(types, times) {
  if (types.includes('OUT')) return { key: 'out', label: 'Out ' + to12(times.OUT) };
  if (types.includes('LUNCH_IN')) return { key: 'back', label: 'Back ' + to12(times.LUNCH_IN) };
  if (types.includes('LUNCH_OUT')) return { key: 'lunch', label: 'At lunch' };
  if (types.includes('IN')) return { key: 'in', label: 'In ' + to12(times.IN) };
  return { key: 'notin', label: 'Not in' };
}
export async function getKioskState() {
  const s = await getSettings();
  const today = dateKey(new Date());
  const emps = await getEmployees(true);
  const rows = await sql`SELECT * FROM punches WHERE date_key = ${today} ORDER BY ts`;
  const by = {};
  rows.forEach(p => {
    const d = by[p.emp_id] || (by[p.emp_id] = { types: [], times: {}, photos: {} });
    d.types.push(p.punch_type); d.times[p.punch_type] = p.time_hhmm;
    if (p.photo_url && p.photo_url.startsWith('http')) d.photos[p.punch_type] = p.photo_url;
  });
  const list = emps.map(e => {
    const d = by[e.empId] || { types: [], times: {}, photos: {} };
    const next = ORDER.find(t => !d.types.includes(t)) || null;
    const st = statusOf(d.types, d.times);
    const shown = {}; ORDER.forEach(t => { shown[t] = d.times[t] ? to12(d.times[t]) : ''; });
    return {
      empId: e.empId, name: e.name, initials: initials(e.name), status: st.key, statusLabel: st.label,
      doneCount: d.types.length, next, nextLabel: next ? LABEL[next] : 'DAY COMPLETE',
      complete: !next, times: shown, photos: d.photos
    };
  });
  return {
    companyName: s.companyName, cameraMode: 'native',
    dateLabel: wd(today) + ', ' + ddmmyy(today), serverTime: to12(hhmm(new Date())), employees: list
  };
}

async function savePhoto(dataUrl, name, type, when) {
  const buf = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const safe = String(name).replace(/[^A-Za-z0-9_-]+/g, '-');
  const path = `photos/${dateKey(when)}/${safe}_${type}_${hhmm(when).replace(':', '')}.jpg`;
  const r = await put(path, buf, { access: 'public', contentType: 'image/jpeg', addRandomSuffix: true });
  return r.url;
}

export async function recordPunch(payload) {
  const now = new Date(), today = dateKey(now);
  const emp = (await getEmployees(true)).find(e => e.empId === payload.empId);
  if (!emp) return { ok: false, message: 'Employee not found or inactive.' };
  const mine = await sql`SELECT * FROM punches WHERE date_key = ${today} AND emp_id = ${emp.empId} ORDER BY ts`;
  const types = mine.map(p => p.punch_type);
  const next = ORDER.find(t => !types.includes(t));
  if (!next) return { ok: false, message: emp.name + ' has already done all four punches today.' };
  if (mine.length && now - new Date(mine[mine.length - 1].ts) < 60000) {
    return { ok: false, message: 'Last punch was under a minute ago. Please wait.' };
  }
  let url = '';
  if (payload.photoData) {
    try { url = await savePhoto(payload.photoData, emp.name, next, now); }
    catch (e) { url = 'PHOTO FAILED: ' + e.message; }
  }
  const ok = url.startsWith('http');
  const ins = await sql`INSERT INTO punches (ts, date_key, emp_id, name, punch_type, time_hhmm, photo_url, photo_id, source, note)
    VALUES (${now.toISOString()}, ${today}, ${emp.empId}, ${emp.name}, ${next}, ${hhmm(now)}, ${url}, ${ok ? url : ''}, 'KIOSK', '')
    ON CONFLICT (date_key, emp_id, punch_type) DO NOTHING RETURNING id`;
  if (!ins.length) return { ok: false, message: 'That punch was just recorded. Please refresh.' };
  const times = {}; mine.forEach(p => { times[p.punch_type] = p.time_hhmm; }); times[next] = hhmm(now);
  const newTypes = types.concat([next]);
  const st = statusOf(newTypes, times);
  return {
    ok: true, name: emp.name, punch: LABEL[next], punchType: next, photoUrl: ok ? url : '',
    time: to12(hhmm(now)), status: st.key, statusLabel: st.label,
    doneCount: newTypes.length, remaining: ORDER.length - newTypes.length
  };
}

/* ---------- weekly off, day status, corrections ---------- */
async function weeklyOffFor(empId, y, m) {
  const [r] = await sql`SELECT weekly_off FROM month_settings WHERE month_key = ${monthKey(y, m)} AND emp_id = ${empId}`;
  return r ? r.weekly_off : String((await getSettings()).weeklyOff || '');
}
export async function saveWeeklyOff(empId, y, m, off) {
  await sql`INSERT INTO month_settings (month_key, emp_id, weekly_off, updated_at)
    VALUES (${monthKey(y, m)}, ${empId}, ${off || ''}, now())
    ON CONFLICT (month_key, emp_id) DO UPDATE SET weekly_off = EXCLUDED.weekly_off, updated_at = now()`;
  await log('WEEKLY_OFF', `${empId} ${monthKey(y, m)} = ${off}`);
  return true;
}
async function dayStatusMap(y, m) {
  const rows = await sql`SELECT * FROM day_status WHERE date_key LIKE ${monthKey(y, m) + '%'}`;
  const map = {};
  rows.forEach(r => { map[`${r.date_key}|${r.emp_id}`] = { status: String(r.status).toUpperCase(), note: r.note || '' }; });
  return map;
}
export async function saveDayStatus(dk, empId, status, note) {
  const target = empId || 'ALL';
  const st = String(status || '').toUpperCase();
  if (!st) await sql`DELETE FROM day_status WHERE date_key = ${dk} AND emp_id = ${target}`;
  else await sql`INSERT INTO day_status (date_key, emp_id, status, note, updated_at)
    VALUES (${dk}, ${target}, ${st}, ${note || ''}, now())
    ON CONFLICT (date_key, emp_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_at = now()`;
  await log('DAY_STATUS', `${dk} ${target} = ${st}`);
  return true;
}
export async function adminSaveDay(dk, empId, times, status, note) {
  const emp = (await getEmployees(false)).find(e => e.empId === empId);
  if (!emp) throw new Error('Employee not found.');
  for (const type of ORDER) {
    if (!times || !(type in times)) continue;
    const t = times[type];
    if (!t) { await sql`DELETE FROM punches WHERE date_key = ${dk} AND emp_id = ${empId} AND punch_type = ${type}`; continue; }
    const ts = new Date(`${dk}T${t}:00Z`).toISOString();
    await sql`INSERT INTO punches (ts, date_key, emp_id, name, punch_type, time_hhmm, source, note)
      VALUES (${ts}, ${dk}, ${empId}, ${emp.name}, ${type}, ${t}, 'ADMIN', ${note || 'Manual entry'})
      ON CONFLICT (date_key, emp_id, punch_type)
      DO UPDATE SET time_hhmm = EXCLUDED.time_hhmm, ts = EXCLUDED.ts, note = EXCLUDED.note`;
  }
  await saveDayStatus(dk, empId, status, note);
  await log('DAY_EDIT', `${dk} ${emp.name}`);
  return true;
}
export async function deletePhoto(dk, empId, type) {
  const [r] = await sql`SELECT * FROM punches WHERE date_key = ${dk} AND emp_id = ${empId} AND punch_type = ${type}`;
  if (!r) throw new Error('That punch is no longer there.');
  let note = '';
  if (r.photo_id) { try { await del(r.photo_id); } catch (e) { note = ' (the stored file was already gone)'; } }
  await sql`UPDATE punches SET photo_url = '', photo_id = '' WHERE id = ${r.id}`;
  await log('PHOTO_DELETE', `${dk} ${empId} ${type}${note}`);
  return { ok: true, message: 'Photo deleted. The punch time is unchanged.' + note };
}

/* ---------- the day calculation ---------- */
export function computeDay(dk, emp, punches, smap, settings, todayKey, weeklyOff) {
  const by = {}; punches.forEach(p => { by[p.punch_type] = p; });
  const ov = smap[`${dk}|${emp.empId}`] || smap[`${dk}|ALL`] || null;
  const ovs = ov ? ov.status : '';
  const isHoliday = ovs === 'H' || ovs === 'HOLIDAY';
  const offs = String(weeklyOff || '').split(',').map(x => x.trim());
  const isWeekOff = offs.includes(wd(dk));
  const shift = emp.shiftHours || Number(settings.shiftHours) || 8;
  const fb = Number(settings.lunchFallback || 0.5);
  const g = t => (by[t] ? by[t].time_hhmm : '');
  const out = {
    dateKey: dk, dateLabel: ddmmyy(dk), weekday: wd(dk), isHoliday, isWeekOff,
    inTime: g('IN'), lunchOut: g('LUNCH_OUT'), lunchIn: g('LUNCH_IN'), outTime: g('OUT'),
    photos: {}, workingHour: '', overtime: '', shortfall: '', status: '', flag: '', lunchTaken: '',
    note: ov ? ov.note : ''
  };
  out.in12 = to12(out.inTime); out.lunchOut12 = to12(out.lunchOut);
  out.lunchIn12 = to12(out.lunchIn); out.out12 = to12(out.outTime);
  ORDER.forEach(t => { if (by[t] && by[t].photo_url) out.photos[t] = by[t].photo_url; });

  if (ovs === 'A' || ovs === 'ABSENT') { out.status = 'ABSENT'; return out; }
  const hasIn = !!out.inTime, hasOut = !!out.outTime;
  if (!hasIn && !hasOut) {
    if (isHoliday) out.status = 'HOLIDAY';
    else if (isWeekOff) out.status = 'WEEKLY OFF';
    else if (dk > todayKey) out.status = '';
    else if (emp.joinDate && dk < emp.joinDate) out.status = '';
    else out.status = 'ABSENT';
    return out;
  }
  if (hasIn && !hasOut) {
    out.status = dk === todayKey ? 'IN OFFICE' : 'NO PUNCH OUT';
    if (dk !== todayKey) out.flag = 'Missing OUT punch — needs correction';
    return out;
  }
  if (!hasIn && hasOut) {
    out.status = 'NO PUNCH IN'; out.flag = 'Missing IN punch — needs correction'; return out;
  }
  const hasLunch = !!(out.lunchOut && out.lunchIn);
  const seq = hasLunch ? [out.inTime, out.lunchOut, out.lunchIn, out.outTime] : [out.inTime, out.outTime];
  const m = []; let prev = -1, bad = false;
  for (const t of seq) {
    let v = mins(t);
    if (!isFinite(v)) { bad = true; break; }
    while (prev >= 0 && v < prev) v += 1440;      // a night shift runs past midnight
    m.push(v); prev = v;
  }
  let working;
  if (bad) working = NaN;
  else if (hasLunch) {
    working = r2(((m[1] - m[0]) + (m[3] - m[2])) / 60);
    out.lunchTaken = r2((m[2] - m[1]) / 60);
  } else {
    working = r2((m[1] - m[0]) / 60 - fb);
    out.flag = 'Lunch not punched — half an hour assumed';
  }
  if (!isFinite(working) || working < 0 || working > 18) {
    out.status = 'CHECK TIMES'; out.flag = 'These times do not add up — please correct this day';
    out.workingHour = ''; out.overtime = ''; out.shortfall = ''; out.lunchTaken = '';
    return out;
  }
  out.workingHour = working;
  if (isHoliday || isWeekOff) {
    out.status = isHoliday ? 'HOLIDAY WORKED' : 'WEEKLY OFF WORKED';
    out.overtime = working; out.shortfall = 0;
  } else {
    out.overtime = r2(working - shift);
    out.shortfall = working < shift ? r2(shift - working) : 0;
    out.status = working < shift ? 'SHORT TIME' : 'PRESENT';
  }
  return out;
}

/* ---------- month, loan, payments, salary ---------- */
async function monthGrid(empId, y, m) {
  y = +y; m = +m;
  const settings = await getSettings();
  const emp = (await getEmployees(false)).find(e => e.empId === empId);
  if (!emp) throw new Error('Employee not found.');
  const [weeklyOff, smap, rows] = await Promise.all([
    weeklyOffFor(empId, y, m), dayStatusMap(y, m),
    sql`SELECT * FROM punches WHERE emp_id = ${empId} AND date_key LIKE ${monthKey(y, m) + '%'}`
  ]);
  const by = {}; rows.forEach(p => { (by[p.date_key] || (by[p.date_key] = [])).push(p); });
  const today = dateKey(new Date()), days = [];
  for (let d = 1; d <= dim(y, m); d++) {
    const dk = `${monthKey(y, m)}-${String(d).padStart(2, '0')}`;
    days.push(computeDay(dk, emp, by[dk] || [], smap, settings, today, weeklyOff));
  }
  return { employee: emp, year: y, month: m, weeklyOff, days };
}
async function advanceRows(empId) {
  const rows = await sql`SELECT * FROM advances WHERE emp_id = ${empId} ORDER BY date_key, created_at`;
  return rows.map(r => ({
    advId: r.adv_id, date: r.date_key, label: ddmmyy(r.date_key), amount: Number(r.amount) || 0,
    kind: String(r.kind).toUpperCase() === 'LOAN' ? 'LOAN' : 'MONTH', note: r.note || ''
  }));
}
async function loanAccount(empId, y, m) {
  const mk = monthKey(y, m);
  const advs = await advanceRows(empId);
  const recs = await sql`SELECT month_key, recovered FROM loan_recovery WHERE emp_id = ${empId}`;
  let before = 0, thisM = 0, recBefore = 0, recovered = 0;
  advs.forEach(a => {
    if (a.kind !== 'LOAN') return;
    const k = a.date.slice(0, 7);
    if (k < mk) before += a.amount; else if (k === mk) thisM += a.amount;
  });
  recs.forEach(r => { const v = Number(r.recovered) || 0; if (r.month_key < mk) recBefore += v; else if (r.month_key === mk) recovered = v; });
  const opening = r2(before - recBefore);
  return { opening, newLoan: r2(thisM), recovered: r2(recovered), closing: r2(opening + thisM - recovered) };
}
export async function saveLoanRecovery(empId, y, m, amount, note) {
  await sql`INSERT INTO loan_recovery (month_key, emp_id, recovered, note, updated_at)
    VALUES (${monthKey(y, m)}, ${empId}, ${Number(amount) || 0}, ${note || ''}, now())
    ON CONFLICT (month_key, emp_id) DO UPDATE SET recovered = EXCLUDED.recovered, note = EXCLUDED.note, updated_at = now()`;
  await log('LOAN_RECOVERY', `${empId} ${monthKey(y, m)} = ${amount}`);
  return true;
}
async function getPayments(empId, y, m) {
  const rows = await sql`SELECT * FROM payments WHERE emp_id = ${empId} AND date_key LIKE ${monthKey(y, m) + '%'} ORDER BY date_key, created_at`;
  return rows.map(r => ({ payId: r.pay_id, date: r.date_key, label: ddmmyy(r.date_key), amount: Number(r.amount) || 0, note: r.note || '' }));
}
const newId = p => p + Date.now() + Math.floor(Math.random() * 100);
export async function savePayment(empId, dk, amount, note) {
  await sql`INSERT INTO payments (pay_id, date_key, emp_id, amount, note) VALUES (${newId('P')}, ${dk}, ${empId}, ${Number(amount) || 0}, ${note || ''})`;
  await log('PAYMENT_ADD', `${empId} ${dk} ${amount}`);
  return true;
}
export async function deletePayment(id) {
  const r = await sql`DELETE FROM payments WHERE pay_id = ${id} RETURNING pay_id`;
  await log('PAYMENT_DELETE', id);
  return r.length > 0;
}
export async function saveAdvance(empId, dk, amount, kind, note) {
  const k = String(kind).toUpperCase() === 'LOAN' ? 'LOAN' : 'MONTH';
  await sql`INSERT INTO advances (adv_id, date_key, emp_id, amount, kind, note) VALUES (${newId('A')}, ${dk}, ${empId}, ${Number(amount) || 0}, ${k}, ${note || ''})`;
  await log('ADVANCE_ADD', `${empId} ${dk} ${amount} ${k}`);
  return true;
}
export async function deleteAdvance(id) {
  const r = await sql`DELETE FROM advances WHERE adv_id = ${id} RETURNING adv_id`;
  await log('ADVANCE_DELETE', id);
  return r.length > 0;
}

export async function getSalary(empId, y, m) {
  y = +y; m = +m;
  const grid = await monthGrid(empId, y, m);
  const emp = grid.employee, shift = emp.shiftHours || 8;
  const perDay = emp.monthlySalary / 30, perHour = emp.monthlySalary / (30 * shift);
  let netOT = 0, shortHrs = 0, plus = 0, absent = 0, worked = 0, holidays = 0, weekOffs = 0, shortDays = 0, incomplete = 0, total = 0;
  grid.days.forEach(d => {
    if (d.overtime !== '') { netOT += Number(d.overtime); if (Number(d.overtime) > 0) plus += Number(d.overtime); }
    if (d.shortfall !== '') shortHrs += Number(d.shortfall);
    if (d.workingHour !== '') total += Number(d.workingHour);
    if (d.status === 'ABSENT') absent++;
    if (['PRESENT', 'SHORT TIME', 'HOLIDAY WORKED', 'WEEKLY OFF WORKED'].includes(d.status)) worked++;
    if (d.status === 'SHORT TIME') shortDays++;
    if (d.status === 'HOLIDAY') holidays++;
    if (d.status === 'WEEKLY OFF') weekOffs++;
    if (['NO PUNCH OUT', 'NO PUNCH IN', 'CHECK TIMES'].includes(d.status)) incomplete++;
  });
  netOT = r2(netOT);
  const otPay = r2(netOT * perHour), absDed = r2(perDay * absent), tea = emp.teaAllowance || 0;
  const totalSalary = r2(emp.monthlySalary + otPay + tea - absDed);
  const mk = monthKey(y, m);
  const advances = (await advanceRows(empId)).filter(a => a.date.startsWith(mk));
  const monthAdvance = r2(advances.reduce((s, a) => s + (a.kind === 'MONTH' ? a.amount : 0), 0));
  const loan = await loanAccount(empId, y, m);
  const payments = await getPayments(empId, y, m);
  const paid = r2(payments.reduce((s, p) => s + p.amount, 0));
  return {
    employee: emp, year: y, month: m, weeklyOff: grid.weeklyOff,
    monthLabel: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1))),
    stats: { workedDays: worked, absentDays: absent, weekOffs, holidays, shortDays, incompleteDays: incomplete,
             totalWorked: r2(total), netOT, plusHours: r2(plus), shortHours: r2(shortHrs) },
    pay: { basic: r2(emp.monthlySalary), shift, perHour: r2(perHour), perDay: r2(perDay), otHours: netOT, otPay, tea,
           absentDeduction: absDed, totalSalary, monthAdvance, loanRecovery: loan.recovered, paid,
           balance: r2(totalSalary - monthAdvance - loan.recovered - paid) },
    loan, advances, payments, days: grid.days
  };
}
export async function getAllSalaries(y, m) {
  const out = [];
  for (const e of await getEmployees(true)) {
    const s = await getSalary(e.empId, y, m);
    out.push({
      empId: e.empId, name: e.name, basic: s.pay.basic, otHours: s.pay.otHours, shortHours: s.stats.shortHours,
      otPay: s.pay.otPay, tea: s.pay.tea, absentDays: s.stats.absentDays, absentDed: s.pay.absentDeduction,
      totalSalary: s.pay.totalSalary, monthAdvance: s.pay.monthAdvance, loanRecovery: s.pay.loanRecovery,
      paid: s.pay.paid, balance: s.pay.balance, loanClosing: s.loan.closing
    });
  }
  return out;
}

/* ---------- admin dashboard ---------- */
export async function getTodayBoard(dk) {
  const settings = await getSettings();
  const todayKey = dateKey(new Date());
  dk = dk || todayKey;
  const [y, m] = dk.split('-').map(Number);
  const emps = await getEmployees(true);
  const smap = await dayStatusMap(y, m);
  const punches = await sql`SELECT * FROM punches WHERE date_key = ${dk}`;
  const by = {}; punches.forEach(p => { (by[p.emp_id] || (by[p.emp_id] = [])).push(p); });
  const rows = [];
  for (const e of emps) {
    const day = computeDay(dk, e, by[e.empId] || [], smap, settings, todayKey, await weeklyOffFor(e.empId, y, m));
    day.empId = e.empId; day.name = e.name; rows.push(day);
  }
  const bad = ['NO PUNCH OUT', 'NO PUNCH IN', 'CHECK TIMES'];
  return {
    dateKey: dk, dateLabel: wd(dk) + ', ' + ddmmyy(dk), isToday: dk === todayKey, rows,
    summary: {
      total: rows.length, present: rows.filter(r => r.inTime).length,
      inOffice: rows.filter(r => r.inTime && !r.outTime).length,
      absent: rows.filter(r => r.status === 'ABSENT').length,
      short: rows.filter(r => r.status === 'SHORT TIME').length,
      problem: rows.filter(r => bad.includes(r.status)).length
    },
    settings
  };
}
export async function getBootstrap(origin, pin) {
  const now = new Date(), p = P(now);
  return {
    settings: await getSettings(), employees: await getEmployees(false), today: dateKey(now),
    year: +p.year, month: +p.month, webAppUrl: origin + '/',
    sheetUrl: `${origin}/api/backup?pin=${encodeURIComponent(pin || '')}`, warning: ''
  };
}
export async function startFresh(pin) {
  if (!(await checkPin(pin))) return { ok: false, message: 'Wrong PIN. Nothing was changed.' };
  const counts = {};
  for (const [name, q] of [
    ['punches', () => sql`DELETE FROM punches RETURNING id`],
    ['day_status', () => sql`DELETE FROM day_status RETURNING date_key`],
    ['advances', () => sql`DELETE FROM advances RETURNING adv_id`],
    ['payments', () => sql`DELETE FROM payments RETURNING pay_id`],
    ['loan_recovery', () => sql`DELETE FROM loan_recovery RETURNING emp_id`],
    ['month_settings', () => sql`DELETE FROM month_settings RETURNING emp_id`]
  ]) counts[name] = (await q()).length;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await log('START_FRESH', `cleared ${total} rows: ${JSON.stringify(counts)}`);
  return { ok: true, cleared: counts, total, message: `The register is empty. ${total} rows cleared. Your staff list and settings are untouched. Photos stay in storage until you delete them there.` };
}

/* ---------- export and backup ---------- */
const csv = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export async function buildMonthCsv(y, m) {
  const rows = [];
  rows.push(['ADSTYLE — ATTENDANCE & SALARY', monthKey(y, m)].map(csv).join(','), '');
  rows.push(['Name', 'Basic', 'Net OT Hrs', 'Short Hrs', 'OT Pay', 'Tea', 'Absent Days', 'Absent Deduction',
    'Total Salary', 'Advance (month)', 'Loan Recovery', 'Paid', 'Balance', 'Loan Balance'].join(','));
  (await getAllSalaries(y, m)).forEach(s => rows.push([s.name, s.basic, s.otHours, s.shortHours, s.otPay, s.tea, s.absentDays,
    s.absentDed, s.totalSalary, s.monthAdvance, s.loanRecovery, s.paid, s.balance, s.loanClosing].map(csv).join(',')));
  rows.push('', 'DAY BY DAY', ['Name', 'Date', 'Day', 'IN', 'LUNCH OUT', 'LUNCH IN', 'OUT', 'Working Hr', 'OT / Short', 'Status'].join(','));
  for (const e of await getEmployees(true)) {
    (await monthGrid(e.empId, y, m)).days.forEach(d => {
      if (d.status) rows.push([e.name, d.dateLabel, d.weekday, d.in12, d.lunchOut12, d.lunchIn12, d.out12, d.workingHour, d.overtime, d.status].map(csv).join(','));
    });
  }
  return rows.join('\n');
}
export async function backupAll() {
  const out = { exportedAt: new Date().toISOString() };
  out.employees = await sql`SELECT * FROM employees`;
  out.punches = await sql`SELECT * FROM punches ORDER BY date_key, ts`;
  out.day_status = await sql`SELECT * FROM day_status`;
  out.advances = await sql`SELECT * FROM advances`;
  out.payments = await sql`SELECT * FROM payments`;
  out.loan_recovery = await sql`SELECT * FROM loan_recovery`;
  out.month_settings = await sql`SELECT * FROM month_settings`;
  out.settings = (await sql`SELECT key, value FROM settings`).filter(r => r.key !== 'adminPin');
  out.audit_log = await sql`SELECT * FROM audit_log ORDER BY id`;
  return out;
}
