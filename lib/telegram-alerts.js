'use strict';

const TOKEN_FORMAT = /^\d{1,20}:[A-Za-z0-9_-]{20,120}$/;
function createTelegram(source = () => process.env.TELEGRAM_BOT_TOKEN || '', request = fetch) {
  const current = typeof source === 'function' ? source : () => source;
  const idOf = token => TOKEN_FORMAT.test(token) ? token.split(':')[0] : '';
  let knownToken, username, offset = 0, polling = false, timer;

  async function call(token, method, body) {
    const response = await request('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw Object.assign(new Error('Telegram a refusé la requête.'), { statusCode: data.error_code || response.status });
    return data.result;
  }
  async function identify(token) {
    if (!TOKEN_FORMAT.test(token)) throw new Error('Format du jeton BotFather invalide.');
    const bot = await call(token, 'getMe', {});
    if (!/^[A-Za-z0-9_]{5,32}$/.test(bot?.username || '')) throw new Error('Bot Telegram introuvable.');
    return bot.username;
  }
  async function verify(token = current()) {
    const name = await identify(token);
    const webhook = await call(token, 'getWebhookInfo', {});
    if (webhook?.url) throw Object.assign(new Error('Webhook Telegram actif.'), { code: 'TELEGRAM_WEBHOOK' });
    return name;
  }
  function sync() {
    const token = current();
    if (knownToken !== token) { knownToken = token; username = ''; offset = 0; }
    return token;
  }
  async function link(code) {
    const token = sync();
    if (!username) {
      const name = await identify(token);
      if (token !== current()) throw new Error('Le bot Telegram a changé.');
      username = name;
    }
    return 'https://t.me/' + username + '?start=' + encodeURIComponent(code);
  }
  async function send(chat, text, expectedBot) {
    const token = current();
    if (!TOKEN_FORMAT.test(token) || (expectedBot && idOf(token) !== expectedBot)) throw new Error('Le bot Telegram a changé.');
    return call(token, 'sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } });
  }
  async function poll(handle) {
    if (polling || !idOf(current())) return;
    polling = true;
    const token = sync();
    const id = idOf(token);
    try {
      const updates = await call(token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      for (const update of updates) {
        if (current() !== token) break;
        const msg = update.message;
        const chat = msg?.chat;
        if (chat?.type === 'private' && Number.isSafeInteger(chat.id)) {
          const text = typeof msg.text === 'string' ? msg.text.trim() : '';
          const code = /^\/start ([A-Za-z0-9_-]{32})$/.exec(text)?.[1];
          if (code || text === '/stop') {
            const reply = await handle(String(chat.id), code, id);
            if (reply && current() === token) await send(chat.id, reply, id).catch(() => {});
          }
        }
        if (knownToken !== token || current() !== token) break;
        offset = update.update_id + 1;
      }
    } finally { polling = false; }
  }
  function start(handle) {
    if (timer) return;
    const run = () => poll(handle).catch(() => {});
    timer = setInterval(run, 5000);
    timer.unref();
    run();
  }
  return { get enabled() { return !!idOf(current()); }, get botId() { return idOf(current()); }, verify, link, send, start, poll };
}

module.exports = { createTelegram, TOKEN_FORMAT };
