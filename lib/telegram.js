const BASE = 'https://api.telegram.org';

export async function sendMessage(text, parseMode = 'Markdown') {
  const res = await fetch(
    `${BASE}/bot${process.env.TG_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TG_CHAT_ID,
        text,
        parse_mode: parseMode,
      }),
    }
  );
  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}
