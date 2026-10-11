'use strict';
// Chiffre le jeton Twitch d'une personne (AES-256-GCM) pour qu'il puisse voyager dans son lien d'installation sans être lisible.
// Clé : variable SECRET (sinon ADMIN_PASSWORD). Changer cette variable invalide tous les liens déjà créés.
const crypto = require('crypto');
const secret = () => process.env.SECRET || process.env.ADMIN_PASSWORD || '';
const key = () => crypto.createHash('sha256').update('twitch-seal-v1|' + secret()).digest();
const available = () => !!secret();
function seal(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function open(sealed) {
  try {
    const b = Buffer.from(String(sealed), 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
module.exports = { seal, open, available };
