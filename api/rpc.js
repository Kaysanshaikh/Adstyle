import * as core from '../lib/core.js';

const PUBLIC = new Set(['getKioskState', 'recordPunch', 'adminLogin']);
const ADMIN = new Set([
  'getBootstrap', 'getTodayBoard', 'getSalary', 'getAllSalaries', 'getEmployees',
  'saveEmployee', 'saveSettings', 'saveDayStatus', 'adminSaveDay', 'deletePhoto',
  'savePayment', 'deletePayment', 'saveAdvance', 'deleteAdvance', 'saveLoanRecovery',
  'saveWeeklyOff', 'startFresh', 'buildMonthCsv'
]);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    await core.ensureSchema();
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const fn = body.fn, args = Array.isArray(body.args) ? body.args : [];
    if (!PUBLIC.has(fn) && !ADMIN.has(fn)) throw new Error('Unknown function');
    const pin = req.headers['x-admin-pin'] || '';
    if (ADMIN.has(fn) && !(await core.checkPin(pin))) {
      return res.status(401).json({ ok: false, error: 'Not authorised. Please log in again.' });
    }
    const origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host);
    const data = fn === 'getBootstrap' ? await core.getBootstrap(origin, pin) : await core[fn](...args);
    return res.status(200).json({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    return res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
}
