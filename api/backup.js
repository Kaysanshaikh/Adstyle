import * as core from '../lib/core.js';

/* GET /api/backup?pin=....  downloads every table as one JSON file */
export default async function handler(req, res) {
  try {
    await core.ensureSchema();
    if (!(await core.checkPin(String(req.query.pin || '')))) return res.status(401).send('Not authorised');
    const data = await core.backupAll();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="adstyle-backup-' + core.dateKey(new Date()) + '.json"');
    res.status(200).send(JSON.stringify(data, null, 1));
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
}
