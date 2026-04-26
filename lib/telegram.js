const BASE = 'https://api.telegram.org';

export async function sendMessage(text, parseMode = 'Markdown') {
  if (!text?.trim()) return;

  const body = { chat_id: process.env.TG_CHAT_ID, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(`${BASE}/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Retry without parse_mode if markdown parsing fails
  if (!res.ok && parseMode) {
    const retry = await fetch(`${BASE}/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text }),
    });
    if (!retry.ok) throw new Error(`Telegram sendMessage failed: ${retry.status}`);
    return retry.json();
  }

  if (!res.ok) throw new Error(`Telegram sendMessage failed: ${res.status}`);
  return res.json();
}
