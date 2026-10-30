# TwitchIO

Addon Stremio hébergé sur ton PC : regarder des lives Twitch dans Stremio. Aucune dépendance à installer, seulement [Node.js](https://nodejs.org) 18 ou plus.

## Lancer l'addon

1. Double-clique sur `start.bat` (ou `node index.js` dans un terminal).
2. Au premier lancement, un fichier `.env` est créé à côté de `index.js` avec un mot de passe pour le dashboard et une clé de chiffrement. Le mot de passe est aussi affiché dans la console.
3. Ouvre `http://localhost:7000/config`, choisis tes réglages, puis installe le lien obtenu dans Stremio.

Sur le même PC, Stremio accepte `http://localhost:7000`. Pour tes amis (ou Stremio sur un autre appareil), il faut une adresse **https** publique : un tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) vers le port 7000. Mets cette adresse dans le dashboard (Paramètres → Configuration → Adresse publique) du fichier `.env`, puis redémarre.

## Données (fichier JSON)

Tout est enregistré dans `data/data.json` : statistiques, journal, utilisateurs, profils (`/u/<id>`), réglages du site, logo et compte lié. Le fichier est relu à chaque démarrage, donc rien n'est perdu quand l'addon ou le PC redémarre.

- Écriture atomique (fichier temporaire puis renommage), 2 secondes après le dernier changement, et à l'arrêt de l'addon.
- Copie de secours `data/data.bak.json` toutes les 10 minutes ; si `data.json` est illisible, la copie est restaurée.
- Pour changer de dossier : variable `DATA_DIR` dans `.env`.
- Pour sauvegarder ou déplacer l'addon : copie le dossier `data` et le fichier `.env`.

## Configuration

Tout se règle dans le dashboard : `/admin` → **Paramètres → Configuration** (Cloudflare et Worker, API Twitch, relais personnalisés, adresse publique, port, journal de diagnostic). Les valeurs sont enregistrées dans `data/data.json` ; les jetons et mots de passe y sont chiffrés avec `SECRET`. Le compte Twitch de l'administrateur se lie dans l'onglet **Compte Twitch**. Tout est pris en compte tout de suite, sauf `PORT` et `HOST` (au prochain démarrage).

Au premier démarrage avec ce système, ce qui se trouvait déjà dans le `.env` est repris automatiquement : tu peux ensuite supprimer ces lignes du `.env`.

Le fichier `.env` ne garde que :

| Variable | Rôle |
|---|---|
| `ADMIN_PASSWORD` | mot de passe du dashboard `/admin` |
| `SECRET` | clé de chiffrement des jetons Twitch placés dans les liens et des jetons saisis dans le dashboard (la changer invalide ces liens, et il faut ressaisir les jetons) |
| `DATA_DIR` | facultatif : dossier de `data.json` (lu avant le dashboard) |

## Pages

- `/manifest.json` : manifeste de l'addon
- `/config` : chaque personne choisit un pseudo et ses réglages (qualité maximale, 60 i/s, relais sans pub, nombre de qualités fixes, audio seul, nom d'appareil) et obtient son lien d'installation. Elle peut aussi tester le serveur et lier son compte Twitch.
- `/admin` : dashboard (lectures, part sans pub, appareils, incidents, graphique 7 jours, utilisateurs, relais, journal avec export CSV, diagnostic, réglages du site, compte Twitch lié)
- `/test/<nom d'un streamer en direct>` : indique si ce serveur obtient bien le flux du live
- `/relais/<nom d'un streamer en direct>` : indique quels relais répondent

## Fonctionnement

La lecture des lives utilise l'interface interne de Twitch : méthode non officielle, qui peut cesser de fonctionner.

Les flux « sans pub » passent par des relais tiers (même liste que le script Twitch HLS Proxy), interrogés côté serveur : le lecteur ne contacte jamais le relais. Si aucun relais ne répond, repli sur le flux officiel.

### 1440p (compte Twitch lié)

Twitch ne donne le 1440p qu'au site web avec un compte connecté. Sur `/config`, la personne colle la valeur de son cookie `auth-token` (twitch.tv) : elle est vérifiée auprès de Twitch, chiffrée en AES-256-GCM (clé `SECRET`, sinon `ADMIN_PASSWORD`) et placée dans son lien d'installation. Les profils enregistrés (`/u/<id>`) gardent aussi ce jeton chiffré dans `data.json`. Changer `SECRET` invalide tous les liens. Activer aussi « Autoriser le 1440p ».
