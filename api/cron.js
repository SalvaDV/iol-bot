export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Skip weekends in ART timezone
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return res.json({ skipped: 'weekend' });
  }

  try {
    const { sendMessage } = await import('../lib/telegram.js');
    await sendMessage('🕐 *Análisis automático iniciado*\nEsperá 1-2 minutos para el reporte completo...');

    // Dispara el análisis IA de forma independiente
    fetch('https://iol-bot.vercel.app/api/analyze', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    try {
      const { sendMessage } = await import('../lib/telegram.js');
      await sendMessage(`❌ Error en análisis automático: ${err.message}`);
    } catch {}
    res.status(500).json({ error: err.message });
  }
}
