'use strict';
const crypto = require('crypto');
const store = require('./store');
const PASS = process.env.ADMIN_PASSWORD || '';
const sig = () => crypto.createHmac('sha256', PASS).update('twitch-admin-v1').digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = req => Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).map(c => c.split(/=(.*)/s).slice(0, 2)));
const authed = req => !!PASS && safeEq(cookieOf(req).adm || '', sig());
const body = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => r(b)); });
const fails = new Map(); // anti force brute : 8 essais / 10 min / adresse

module.exports = function admin({ send, json, relayReport, probe, config }) {
  return async function (req, res, seg) {
    if (seg[0] !== 'admin') return false;
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
    const secure = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'X-Frame-Options': 'DENY' };
    if (!PASS) return send(res, 200, 'text/html; charset=utf-8', PAGE_SETUP, secure), true;

    if (seg[1] === 'login' && req.method === 'POST') {
      const f = fails.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - f.t > 6e5) { f.n = 0; f.t = Date.now(); }
      if (f.n >= 8) return json(res, { ok: false, error: 'Trop d\'essais, réessaie dans quelques minutes.' }), true;
      let pw = ''; try { pw = JSON.parse(await body(req)).password || ''; } catch { /* vide */ }
      if (!safeEq(pw, PASS)) { f.n++; fails.set(ip, f); return json(res, { ok: false, error: 'Mot de passe incorrect.' }), true; }
      fails.delete(ip);
      return json(res, { ok: true }, { 'Set-Cookie': 'adm=' + sig() + '; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000' }), true;
    }
    if (seg[1] === 'logout') return send(res, 302, 'text/plain', '', { Location: '/admin', 'Set-Cookie': 'adm=; Path=/admin; Max-Age=0' }), true;
    if (!authed(req)) return send(res, 200, 'text/html; charset=utf-8', PAGE_LOGIN, secure), true;

    if (!seg[1]) return send(res, 200, 'text/html; charset=utf-8', PAGE, secure), true;
    if (seg[1] !== 'api') return send(res, 404, 'text/plain', 'Introuvable'), true;
    const q = new URL(req.url, 'http://x').searchParams;
    try {
      if (seg[2] === 'state') return json(res, { ...(await store.snapshot(Number(q.get('n')) || 300)), config: config(), now: Date.now(), up: process.uptime() }), true;
      if (seg[2] === 'relays') return json(res, await relayReport(String(q.get('channel') || '').toLowerCase())), true;
      if (seg[2] === 'probe') return json(res, await probe(String(q.get('channel') || '').toLowerCase())), true;
      if (seg[2] === 'reset' && req.method === 'POST') { await store.reset(q.get('what') === 'logs' ? 'logs' : 'all'); return json(res, { ok: true }), true; }
    } catch (e) { return json(res, { error: e.message }), true; }
    return json(res, { error: 'inconnu' }), true;
  };
};

const CSS = `:root{--bg:#0e0e10;--p:#18181b;--p2:#1f1f23;--b:#2d2d33;--t:#efeff1;--m:#a1a1aa;--a:#9147ff;--ok:#22c55e;--ko:#ef4444;--w:#f59e0b}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--a)}h1,h2,h3{margin:0}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}`;

const PAGE_SETUP = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Dashboard Twitch</title><style>${CSS}
body{display:grid;place-items:center;min-height:100vh;padding:16px}.c{max-width:480px;background:var(--p);border:1px solid var(--b);border-radius:12px;padding:24px}code{background:var(--p2);padding:2px 6px;border-radius:4px}</style>
<div class=c><h2>Dashboard non activé</h2><p style="color:var(--m)">Ajoute une variable d'environnement <code>ADMIN_PASSWORD</code> dans Vercel (Settings → Environment Variables), puis redéploie. Choisis un mot de passe long.</p></div>`;

const PAGE_LOGIN = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Connexion · Dashboard Twitch</title><style>${CSS}
body{display:grid;place-items:center;min-height:100vh;padding:16px}form{width:100%;max-width:340px;background:var(--p);border:1px solid var(--b);border-radius:12px;padding:24px;display:grid;gap:14px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--b);background:var(--p2);color:var(--t)}button{background:var(--a);border-color:var(--a);font-weight:600;cursor:pointer}#e{color:var(--ko);min-height:1.2em;font-size:13px}</style>
<form id=f><h2>🟣 Dashboard Twitch</h2><input id=pw type=password placeholder="Mot de passe" autofocus autocomplete=current-password><button>Se connecter</button><div id=e></div></form>
<script>f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/admin/login',{method:'POST',body:JSON.stringify({password:pw.value})}).then(r=>r.json());r.ok?location.reload():(document.getElementById('e').textContent=r.error)}</script>`;

const PAGE = `<!doctype html><html lang=fr><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Dashboard Twitch</title><style>${CSS}
header{position:sticky;top:0;z-index:5;background:rgba(14,14,16,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--b);display:flex;align-items:center;gap:16px;padding:10px 16px;flex-wrap:wrap}
header h1{font-size:16px}nav{display:flex;gap:4px;flex:1;overflow-x:auto}nav button{background:none;border:0;color:var(--m);padding:8px 12px;border-radius:8px;font:inherit;cursor:pointer;white-space:nowrap}nav button.on{background:var(--p2);color:var(--t)}
.r{display:flex;gap:10px;align-items:center;color:var(--m);font-size:12px}.r a{text-decoration:none}main{max-width:1180px;margin:0 auto;padding:16px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}.card{background:var(--p);border:1px solid var(--b);border-radius:12px;padding:16px}
.card .l{color:var(--m);font-size:12px;text-transform:uppercase;letter-spacing:.04em}.card .v{font-size:28px;font-weight:700;margin-top:4px}.card .s{color:var(--m);font-size:12px;margin-top:2px}
.two{display:grid;gap:12px;grid-template-columns:2fr 1fr;margin-top:12px}@media(max-width:800px){.two{grid-template-columns:1fr}}
h3{font-size:13px;color:var(--m);text-transform:uppercase;letter-spacing:.04em;margin-bottom:12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--b);vertical-align:top}th{color:var(--m);font-weight:500;font-size:12px}tr:last-child td{border:0}.tw{overflow-x:auto}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;background:var(--p2);border:1px solid var(--b)}.ok{color:var(--ok);border-color:#14532d}.ko{color:var(--ko);border-color:#7f1d1d}.wa{color:var(--w);border-color:#78350f}
.bar{height:6px;border-radius:3px;background:var(--p2);overflow:hidden;min-width:70px}.bar i{display:block;height:100%;background:var(--ok)}
.tools{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}input,select,button.b{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--b);background:var(--p2);color:var(--t)}button.b{cursor:pointer}button.b.pr{background:var(--a);border-color:var(--a);font-weight:600}button.b.dg{color:var(--ko)}
.log{display:grid;grid-template-columns:130px 78px 1fr;gap:10px;padding:6px 10px;border-bottom:1px solid var(--b)}@media(max-width:700px){.log{grid-template-columns:1fr}}.log .t{color:var(--m)}
.banner{background:#3b2a05;border:1px solid #78350f;color:#fcd34d;padding:10px 14px;border-radius:10px;margin-bottom:12px}
.chart{display:flex;align-items:flex-end;gap:8px;height:140px}.chart div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;gap:4px;font-size:11px;color:var(--m)}.chart i{display:block;width:100%;background:var(--a);border-radius:4px 4px 0 0;min-height:2px}
pre{background:var(--p2);border:1px solid var(--b);border-radius:8px;padding:12px;overflow:auto;max-height:420px;margin:0}.sec{display:none}.sec.on{display:block}.mt{margin-top:12px}.dim{color:var(--m)}
</style>
<header><h1>🟣 Twitch · Dashboard</h1><nav id=nav></nav><div class=r><span id=upd>…</span><label><input type=checkbox id=auto checked> auto</label><a href="/admin/logout">Déconnexion</a></div></header>
<main>
<div id=ban></div>
<section class="sec on" id=s-over>
 <div class=grid id=kpi></div>
 <div class=two><div class=card><h3>Lectures demandées · 7 jours</h3><div class=chart id=chart></div></div><div class=card><h3>Chaînes les plus lancées</h3><div class=tw id=top></div></div></div>
 <div class="card mt"><h3>Répartition des lectures</h3><div id=mix></div></div>
</section>
<section class=sec id=s-rel>
 <div class=card><h3>Santé des relais (sur les vraies lectures)</h3><div class=tw id=relstats></div></div>
 <div class="card mt"><h3>Tester les relais en direct</h3><div class=tools><input id=rch placeholder="nom d'un streamer en live" size=26><button class="b pr" id=rgo>Tester</button></div><div class=tw id=relout class=dim>Entre une chaîne en direct puis lance le test.</div></div>
</section>
<section class=sec id=s-log>
 <div class=tools><select id=lk><option value="">Tout</option><option>stream</option><option>play</option><option>catalog</option><option>install</option><option>erreur</option></select><input id=lq placeholder="Filtrer (chaîne, relais…)" size=24><button class="b dg" id=lclr>Vider le journal</button></div>
 <div class=card style="padding:0" id=logs></div>
</section>
<section class=sec id=s-tool>
 <div class=card><h3>Diagnostic d'une chaîne</h3><div class=tools><input id=pch placeholder="nom d'un streamer" size=26><button class="b pr" id=pgo>Analyser</button></div><pre id=pout class=mono>Résultat ici.</pre></div>
</section>
<section class=sec id=s-cfg>
 <div class=card><h3>Configuration</h3><div class=tw id=cfg></div></div>
 <div class="card mt"><h3>Zone sensible</h3><button class="b dg" id=rall>Réinitialiser toutes les statistiques et le journal</button></div>
</section>
</main>
<script>
const $=s=>document.querySelector(s),TABS=[['over','Vue d\\'ensemble'],['rel','Relais'],['log','Journal'],['tool','Diagnostic'],['cfg','Configuration']];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n=x=>Number(x||0).toLocaleString('fr-FR'),pct=(a,b)=>b?Math.round(100*a/b)+' %':'–';
let S=null,cur=localStorage.tab||'over';
nav.innerHTML=TABS.map(([k,l])=>'<button data-k='+k+'>'+l+'</button>').join('');
function show(k){cur=k;try{localStorage.tab=k}catch{}document.querySelectorAll('.sec').forEach(e=>e.classList.toggle('on',e.id==='s-'+k));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.k===k))}
nav.onclick=e=>e.target.dataset.k&&show(e.target.dataset.k);show(cur);
const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<60?s+' s':s<3600?Math.round(s/60)+' min':s<86400?Math.round(s/3600)+' h':Math.round(s/86400)+' j'};
async function api(p,o){const r=await fetch('/admin/api/'+p,o);if(r.status===200&&r.headers.get('content-type').includes('html')){location.reload();return{}}return r.json()}
function render(){
 const st=S.stats,g=k=>st[k]||0,D=S.days;
 ban.innerHTML=(S.persistent?'':'<div class=banner>⚠️ Stockage temporaire : les stats et le journal se remettent à zéro régulièrement. Ajoute une base Upstash (variables <b>UPSTASH_REDIS_REST_URL</b> et <b>UPSTASH_REDIS_REST_TOKEN</b>) pour les conserver.</div>')+(S.lastError?'<div class=banner>Erreur de stockage : '+esc(S.lastError)+'</div>':'');
 kpi.innerHTML=[['Demandes de lecture',n(g('stream')),n(g('play'))+' lectures « auto » démarrées'],['Sans pub (relais)',pct(g('stream_relay'),g('stream_relay')+g('stream_official')),n(g('stream_relay'))+' relais · '+n(g('stream_official'))+' officiel'],
  ['Appareils aujourd\\'hui',n(S.uniq[S.uniq.length-1]),'7 jours : '+n(Math.max(...S.uniq))+' max / jour'],['Chaînes hors ligne',n(g('stream_offline')),'demandes sans live'],['Erreurs',n(g('err')),pct(g('err'),g('req'))+' des requêtes'],['Requêtes',n(g('req')),'depuis le début / reset']]
  .map(([l,v,s])=>'<div class=card><div class=l>'+l+'</div><div class=v>'+v+'</div><div class=s>'+s+'</div></div>').join('');
 const vals=D.map(d=>g('d:'+d+':stream')),mx=Math.max(1,...vals);
 chart.innerHTML=D.map((d,i)=>'<div><span>'+n(vals[i])+'</span><i style="height:'+Math.round(vals[i]/mx*100)+'px"></i><span>'+d.slice(8)+'/'+d.slice(5,7)+'</span></div>').join('');
 top.innerHTML=S.top.length?'<table>'+S.top.map(([c,v])=>'<tr><td>'+esc(c)+'</td><td style="text-align:right">'+n(v)+'</td></tr>').join('')+'</table>':'<span class=dim>Aucune donnée.</span>';
 const tot=g('stream_relay')+g('stream_official')+g('stream_offline')||1;
 mix.innerHTML=[['Relais sans pub','stream_relay','var(--ok)'],['Flux officiel (repli)','stream_official','var(--w)'],['Hors ligne','stream_offline','var(--m)']].map(([l,k,c])=>'<div style="margin:8px 0"><div style="display:flex;justify-content:space-between"><span>'+l+'</span><span class=dim>'+n(g(k))+' · '+pct(g(k),tot)+'</span></div><div class=bar style="height:8px"><i style="width:'+Math.round(100*g(k)/tot)+'%;background:'+c+'"></i></div></div>').join('');
 const names=[...new Set(S.config.relais.map(r=>r.name))];
 relstats.innerHTML='<table><tr><th>Relais</th><th>Réussite</th><th></th><th>Latence moy.</th><th>Essais</th><th>Gagnant</th></tr>'+names.map(nm=>{const ok=g('r|'+nm+'|ok'),ko=g('r|'+nm+'|fail'),t=ok+ko,ms=ok?Math.round(g('r|'+nm+'|ms')/ok):0,p=t?Math.round(100*ok/t):0;
  return '<tr><td>'+esc(nm)+'</td><td><span class="pill '+(!t?'':p>=70?'ok':p>=30?'wa':'ko')+'">'+(t?p+' %':'–')+'</span></td><td><div class=bar><i style="width:'+p+'%"></i></div></td><td>'+(ms?ms+' ms':'–')+'</td><td>'+n(t)+'</td><td>'+n(g('r|'+nm+'|win'))+'</td></tr>'}).join('')+'</table>';
 const lk=$('#lk').value,lq=$('#lq').value.toLowerCase();
 const rows=S.logs.filter(l=>(!lk||l.k===lk)&&(!lq||JSON.stringify(l).toLowerCase().includes(lq)));
 logs.innerHTML=rows.length?rows.map(l=>{const {t,k,...r}=l;return '<div class=log><span class="t mono" title="'+new Date(t).toLocaleString('fr-FR')+'">'+new Date(t).toLocaleTimeString('fr-FR')+' · '+ago(t)+'</span><span><span class="pill '+(k==='erreur'?'ko':k==='stream'||k==='play'?'ok':'')+'">'+esc(k)+'</span></span><span class=mono>'+Object.entries(r).map(([a,b])=>'<span class=dim>'+esc(a)+'=</span>'+esc(b)).join(' ')+'</span></div>'}).join(''):'<div style="padding:16px" class=dim>Aucune entrée.</div>';
 cfg.innerHTML='<table>'+S.config.rows.map(([k,v,ok])=>'<tr><td>'+esc(k)+'</td><td><span class="pill '+(ok===true?'ok':ok===false?'ko':'')+'">'+esc(v)+'</span></td></tr>').join('')+'</table>';
 upd.textContent='maj '+new Date().toLocaleTimeString('fr-FR')+' · serveur actif depuis '+Math.round(S.up/60)+' min';
}
async function load(){try{S=await api('state');if(S.stats)render()}catch(e){upd.textContent='erreur : '+e.message}}
$('#lk').onchange=$('#lq').oninput=()=>S&&render();
$('#lclr').onclick=async()=>{if(confirm('Vider le journal ?')){await api('reset?what=logs',{method:'POST'});load()}};
$('#rall').onclick=async()=>{if(confirm('Tout remettre à zéro ?')){await api('reset?what=all',{method:'POST'});load()}};
$('#rgo').onclick=async()=>{const c=$('#rch').value.trim();if(!c)return;relout.textContent='Test en cours…';const r=await api('relays?channel='+encodeURIComponent(c));
 if(r.erreur)return relout.textContent=r.erreur;
 relout.innerHTML='<p>'+r.relais_valides+' / '+r.sur+' relais valides'+(r.flux_officiel&&r.flux_officiel.hors_ligne?' · <b class=ko>chaîne hors ligne</b>':'')+'</p><table><tr><th>Relais</th><th>État</th><th>Temps</th><th>Segments</th><th>Pubs</th></tr>'+r.detail.map(d=>'<tr><td>'+esc(d.relais)+'</td><td><span class="pill '+(d.ok?'ok':'ko')+'">'+(d.ok?'OK':esc(d.erreur))+'</span></td><td>'+(d.ms?d.ms+' ms':'')+'</td><td class=mono>'+esc(d.hote_segments||'')+'</td><td>'+(d.pubs_detectees===undefined?'':d.pubs_detectees?'<span class="pill ko">oui</span>':'<span class="pill ok">non</span>')+'</td></tr>').join('')+'</table>'+(r.flux_officiel&&r.flux_officiel.officiel?'<p class=dim>Flux officiel : pubs '+(r.flux_officiel.officiel.pubs_detectees?'<b class=ko>détectées</b>':'non détectées')+' · segments '+esc(r.flux_officiel.officiel.hote_segments||'?')+'</p>':'');load()};
$('#pgo').onclick=async()=>{const c=$('#pch').value.trim();if(!c)return;pout.textContent='Analyse…';pout.textContent=JSON.stringify(await api('probe?channel='+encodeURIComponent(c)),null,2);load()};
load();setInterval(()=>$('#auto').checked&&load(),10000);
</script></html>`;
