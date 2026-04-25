export const config = { runtime: 'nodejs', maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel cron sends Authorization: Bearer {CRON_SECRET}
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
    const { runAnalysis } = await import('../lib/analysis.js');
    const { savePendingSignal } = await import('../lib/supabase.js');

    const signal = await runAnalysis();
    if (signal) await savePendingSignal({ ...signal, status: 'pending' });

    res.json({ ok: true, signal: !!signal });
  } catch (err) {
    try {
      const { sendMessage } = await import('../lib/telegram.js');
      await sendMessage(`❌ Error en análisis automático: ${err.message}`);
    } catch {}
    res.status(500).json({ error: err.message });
  }
}
