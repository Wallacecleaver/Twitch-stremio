'use strict';

const TOKEN_FORMAT = /^\d{1,20}:[A-Za-z0-9_-]{20,120}$/;
const COMMANDS = [
  { command: 'start', description: 'Ouvrir les alertes TwitchIO' },
  { command: 'statut', description: 'Voir tes chaînes surveillées' },
  { command: 'aide', description: 'Afficher l’aide' },
  { command: 'stop', description: 'Désactiver tes alertes Telegram' },
];
function createTelegram(source = () => process.env.TELEGRAM_BOT_TOKEN || '', request = fetch) {
  const current = typeof source === 'function' ? source : () => source;
  const idOf = token => TOKEN_FORMAT.test(token) ? token.split(':')[0] : '';
  let knownToken, username, offset = 0, polling = false, timer;
  let nextCommandSetup = 0;

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
    if (knownToken !== token) { knownToken = token; username = ''; offset = 0; nextCommandSetup = 0; }
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
  async function send(chat, { text, buttons }, expectedBot) {
    const token = current();
    if (!TOKEN_FORMAT.test(token) || (expectedBot && idOf(token) !== expectedBot)) throw new Error('Le bot Telegram a changé.');
    return call(token, 'sendMessage', {
      chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      reply_markup: buttons?.length ? { inline_keyboard: [buttons] } : undefined,
    });
  }
  function setupCommands(token) {
    if (Date.now() < nextCommandSetup) return;
    nextCommandSetup = Date.now() + 60000;
    call(token, 'setMyCommands', { commands: COMMANDS, scope: { type: 'all_private_chats' } })
      .then(() => { if (token === knownToken) nextCommandSetup = Infinity; }, () => {});
  }
  async function poll(handle) {
    if (polling || !idOf(current())) return;
    polling = true;
    const token = sync();
    const id = idOf(token);
    try {
      setupCommands(token);
      const updates = await call(token, 'getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
      for (const update of updates) {
        if (current() !== token) break;
        const msg = update.message;
        const chat = msg?.chat;
        if (chat?.type === 'private' && Number.isSafeInteger(chat.id)) {
          const text = typeof msg.text === 'string' ? msg.text.trim() : '';
          const match = /^\/(start|statut|aide|stop)(?:\s+(\S+))?$/.exec(text);
          if (match && (match[1] === 'start' || !match[2])) {
            const reply = await handle(String(chat.id), match[1], match[2], id);
            if (reply && current() === token) await send(String(chat.id), reply, id).catch(() => {});
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
