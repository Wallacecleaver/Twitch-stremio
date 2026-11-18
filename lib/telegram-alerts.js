'use strict';

function createTelegram(token = process.env.TELEGRAM_BOT_TOKEN || '', request = fetch) {
  const enabled = /^\d+:[A-Za-z0-9_-]{20,}$/.test(token);
  let username, offset = 0, polling = false, timer;

  async function call(method, body) {
    const response = await request('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Object.assign(new Error('Telegram a refusé la requête.'), { statusCode: data.error_code || response.status });
    return data.result;
  }
  async function link(code) {
    if (!enabled) throw new Error('Le bot Telegram n’est pas configuré.');
    if (!username) {
      const bot = await call('getMe', {});
      if (!/^[A-Za-z0-9_]{5,32}$/.test(bot?.username || '')) throw new Error('Bot Telegram introuvable.');
      username = bot.username;
    }
    return 'https://t.me/' + username + '?start=' + encodeURIComponent(code);
  }
  async function send(chat, text) {
    if (!enabled) throw new Error('Le bot Telegram n’est pas configuré.');
    return call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } });
  }
  async function poll(handle) {
    if (polling || !enabled) return;
    polling = true;
    try {
      const updates = await call('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      for (const update of updates) {
        const msg = update.message;
        const chat = msg?.chat;
        if (chat?.type === 'private' && Number.isSafeInteger(chat.id)) {
          const text = typeof msg.text === 'string' ? msg.text.trim() : '';
          const code = /^\/start ([A-Za-z0-9_-]{32})$/.exec(text)?.[1];
          if (code || text === '/stop') {
            const reply = await handle(String(chat.id), code);
            if (reply) await send(chat.id, reply).catch(() => {});
          }
        }
        offset = update.update_id + 1;
      }
    } finally { polling = false; }
  }
  function start(handle) {
    if (!enabled || timer) return;
    const run = () => poll(handle).catch(() => {});
    timer = setInterval(run, 5000);
    timer.unref();
    run();
  }
  return { enabled, link, send, start, poll };
}

module.exports = { createTelegram };
