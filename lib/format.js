'use strict';
// Affichage des sources dans Stremio : chaque preset décide du nom (colonne de gauche) et des lignes (colonne de droite).
// Stremio n'accepte que du texte brut : tout passe par le contenu des lignes et les emojis. Lignes courtes (≈ 24 caractères).
const FORMATS = [
  { id: 'classique', label: 'Classique', desc: 'L\'affichage habituel : qualité, images par seconde et statut des pubs.' },
  { id: 'compact', label: 'Compact', desc: 'Une seule ligne par source : idéal sur TV ou téléphone.' },
  { id: 'detaille', label: 'Détaillé', desc: 'Chaque source indique aussi les spectateurs et le jeu en cours.' },
  { id: 'sans-emoji', label: 'Sans emoji', desc: 'Texte seul, pour les appareils qui affichent mal les emojis.' },
];
const IDS = FORMATS.map(f => f.id);
const DEFAULT = 'classique';

const tierOf = h => h >= 1440 ? 'Ultra HD' : h >= 1080 ? 'Full HD' : h >= 720 ? 'HD' : h >= 480 ? 'SD' : 'Éco';
const capTxt = cap => cap ? ' · max ' + cap + 'p' : ' · meilleure qualité';

// d : { kind: 'fixed' | 'auto' | 'audio', vod, short, rawName, h, fps, noAd (true / false / absent pour une rediffusion), viewers, game, cap }
function render(id, d) {
  const f = IDS.includes(id) ? id : DEFAULT, vod = !!d.vod, res = !!d.h, tier = tierOf(d.h || 0);
  const emoji = f !== 'sans-emoji', ad = d.noAd === undefined ? '' : d.noAd ? (emoji ? '🚫 Sans pub' : 'Sans pub') : (emoji ? '⚠️ Officiel · avec pubs' : 'Officiel · avec pubs');
  const name = (d.brand || 'TwitchIO') + '\n' + (d.kind === 'auto' ? 'Auto' : d.kind === 'audio' ? 'Audio' : d.short);
  const fpsTxt = d.fps ? ' · ' + d.fps + ' images/s' : '';
  const out = lines => ({ name, title: lines.filter(Boolean).join('\n') });
  const live = emoji ? '🔴 En direct' + (d.viewers ? ' · ' + d.viewers + ' 👁' : '') : 'En direct' + (d.viewers ? ' · ' + d.viewers + ' vues' : '');
  const game = d.game ? (emoji ? '🎮 ' : 'Jeu : ') + d.game : '';

  if (d.kind === 'audio') return out([emoji ? '🎧 Audio seul' : 'Audio seul', f === 'compact' ? '' : ad]);

  if (f === 'compact') {
    const short = d.noAd === undefined ? '' : d.noAd ? '🚫 Sans pub' : '⚠️ Avec pubs';
    if (d.kind === 'auto') return out([vod ? '📼 Rediffusion · Auto' : '🔴 ' + (d.viewers ? d.viewers + ' 👁 · ' : '') + short]);
    return out([vod ? '📼 ' + tier : res ? tier + ' · ' + short : '📺 ' + d.rawName]);
  }

  if (d.kind === 'auto') {
    if (vod) return out([emoji ? '📼 Rediffusion' : 'Rediffusion', (emoji ? '✨ Auto' : 'Auto') + capTxt(d.cap)]);
    return out([live, game, (emoji ? '✨ Auto' : 'Auto') + capTxt(d.cap), ad]);
  }

  // qualité fixe
  const q = res || vod ? (emoji ? '📺 ' : '') + tier + fpsTxt : (emoji ? '📺 ' : '') + d.rawName;
  if (vod) return out([emoji ? '📼 Rediffusion' : 'Rediffusion', q]);
  if (f === 'detaille') return out([live, q, game, ad]);
  return out([q, ad]);
}

// Exemples affichés dans la page de configuration (aperçu en direct)
function samples() {
  const base = { short: '1080p60', rawName: '1080p60', h: 1080, fps: 60, noAd: true, viewers: '12,3k', game: 'Just Chatting', cap: 0 };
  return FORMATS.map(f => ({ ...f, fixed: render(f.id, { ...base, kind: 'fixed' }), auto: render(f.id, { ...base, kind: 'auto' }) }));
}

module.exports = { FORMATS, IDS, DEFAULT, render, samples };
