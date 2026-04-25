import { runAdvisor } from '../lib/advisor.js';
import { sendMessage } from '../lib/telegram.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  if (now.getDay() === 0 || now.getDay() === 6) {
    return res.json({ skipped: 'weekend' });
  }

  try {
    await sendMessage('🕐 *Análisis automático iniciado* — esperá ~40 segundos...');
    await runAdvisor();
    res.json({ ok: true });
  } catch (err) {
    await sendMessage(`❌ Error en análisis automático: ${err.message}`).catch(() => {});
    res.status(500).json({ error: err.message });
  }
}
