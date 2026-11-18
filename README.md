# TwitchIO

Addon [Stremio](https://www.stremio.com) pour regarder des lives Twitch, avec une page d'**alertes de live** (notifications navigateur et Telegram) et un dashboard d'administration. Il tourne sur ton PC ou sur un VPS. [Node.js](https://nodejs.org) 18 ou plus.

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Démarrage rapide](#démarrage-rapide)
- [Alertes de live](#alertes-de-live)
- [Déploiement sur un VPS (Docker / WDook)](#déploiement-sur-un-vps-docker--wdook)
- [Worker Cloudflare (vidéo hors de ton serveur)](#worker-cloudflare-vidéo-hors-de-ton-serveur)
- [Configuration](#configuration)
- [Pages et adresses](#pages-et-adresses)
- [Sécurité](#sécurité)
- [Données](#données)
- [Fonctionnement et limites](#fonctionnement-et-limites)

## Fonctionnalités

**Dans Stremio**

- Catalogues : *Lives par jeu*, *Lives en français*, *Lives* (recherche), *Rediffusions*, et, avec un compte Twitch lié, *Mes chaînes suivies* et *Mes rediffusions*.
- Fiche d'une chaîne : liens vers Twitch, le catalogue du jeu en cours et le Discord ; durée et date des rediffusions dans la description.
- Flux **sans pub** via des relais, avec repli automatique sur le flux officiel.
- Réglages personnels sur `/config` : qualité maximale, 60 i/s, 1440p, relais sans pub, nombre de qualités, audio seul, nom d'appareil, mode de téléchargement de la vidéo.
- Chat Twitch en sous-titres ou incrusté dans la vidéo (expérimental, voir `.env.example`).
- Option `AUDIO_SINGLE` : une seule piste audio sur Stremio PC et Nuvio desktop (au lieu de « Track 1 … Track 5 »).

**Alertes de live** (`/alerte`)

- Notifications Web Push et/ou Telegram quand une chaîne démarre un live, page fermée.
- Découverte (tendance en français, populaires), recherche de streamers, fiche et calendrier d'un streamer, import de tes suivis.
- Réglages par navigateur : **sourdine** par chaîne et **heures calmes**.

**Administration** (`/admin`)

- Statistiques, utilisateurs, journal, santé des relais, suivi du Worker Cloudflare, clés d'accès, gestion des alertes et de la configuration.

## Démarrage rapide

1. Double-clique sur `start.bat`, ou lance `npm ci --omit=dev` puis `npm start`.
2. Au premier lancement, un fichier `.env` est créé à côté de `index.js` avec un mot de passe pour le dashboard et une clé de chiffrement. Le mot de passe est aussi affiché dans la console.
3. Ouvre `http://localhost:7000/config`, choisis tes réglages, puis installe le lien obtenu dans Stremio.

Sur le même PC, Stremio accepte `http://localhost:7000`. Pour tes amis (ou Stremio sur un autre appareil), il faut une adresse **https** publique : un tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) vers le port 7000. Mets cette adresse dans le dashboard (Paramètres → Configuration → Adresse publique), puis redémarre.

## Alertes de live

Sur `/alerte`, ajoute jusqu'à 12 chaînes par navigateur, puis active les notifications. Le serveur vérifie les directs environ toutes les minutes et envoie une notification quand une chaîne surveillée démarre un nouveau live. Elle indique le jeu et le titre du live. Le bouton « Envoyer un test » permet de vérifier la réception.

### Ajouter des chaînes

- Recherche un streamer par pseudo ou colle le lien de sa chaîne Twitch.
- La découverte affiche « Tendance en français » et « Populaires sur Twitch ».
- Ouvre une fiche streamer pour voir son calendrier publié sur Twitch et l'ajouter à tes alertes.
- Dans « Mes suivis », connecte-toi avec l'identifiant ou le lien d'installation et le mot de passe de ton profil TwitchIO. Si un compte Twitch est lié à ce profil, sélectionne les suivis à ajouter. Tes choix sont enregistrés pour ce navigateur quand tu actives ou mets à jour les notifications.

### Sourdine et heures calmes

Une fois les alertes actives, deux réglages affinent ce que tu reçois :

- **Sourdine** : le bouton à côté d'une chaîne coupe ses alertes sans la retirer de ta liste.
- **Heures calmes** : aucune alerte entre deux heures (heure de ton navigateur, le fuseau est mémorisé).

Les lives démarrés pendant une sourdine ou des heures calmes sont marqués comme vus : tu n'es pas notifié en retard quand tu réactives les alertes. Ces réglages valent pour le navigateur et pour Telegram.

### Telegram

1. Crée un bot dédié dans [BotFather](https://t.me/BotFather).
2. Renseigne `TELEGRAM_BOT_TOKEN` dans les variables du VPS, puis redéploie.
3. Sur `/alerte`, choisis tes chaînes, clique sur « Connecter Telegram », ouvre le bot et appuie sur « Démarrer ».

Telegram peut être utilisé seul ou avec les notifications du navigateur. Pour arrêter depuis le bot, envoie `/stop`. Le bot doit être dédié à TwitchIO, qui reçoit ses messages via `getUpdates`.

### Notifications du navigateur

Les alertes arrivent même quand la page est fermée, tant que le navigateur et le système autorisent les notifications en arrière-plan. Utilise l'adresse HTTPS de l'addon. Sur iPhone ou iPad, ajoute la page à l'écran d'accueil avant d'activer les alertes. Les abonnements et la clé Push sont enregistrés dans le dossier de données.

### Côté administrateur

L'onglet « Alertes » du dashboard permet de modifier le titre et l'introduction de la page, de mettre les envois en pause et de consulter le nombre de navigateurs abonnés et de chaînes surveillées. Les diffusions commencées pendant la pause ne déclenchent pas d'alerte à la reprise.

Limites actuelles du serveur : 200 navigateurs, 12 chaînes par navigateur, 150 chaînes surveillées au total.

## Déploiement sur un VPS (Docker / WDook)

Le repo contient un `Dockerfile` (Node 22 Alpine) et un `.env.example`.

- **WDook** : « Nouveau projet » → choisis le repo ; les variables du `.env.example` sont préremplies, le port est `7000`. Laisse `ADMIN_PASSWORD` et `SECRET` vides : ils sont générés au premier démarrage (le mot de passe du dashboard est affiché dans les logs du conteneur, `docker logs <conteneur>`).
- **Docker seul** :
  ```bash
  docker build -t twitchio .
  docker run -d --name twitchio --restart unless-stopped -p 7000:7000 -v twitchio-data:/app/data twitchio
  ```
- `/app/data` est un volume : il contient `data.json`, la copie de secours et le `.env` généré (variable `ENV_FILE`). Sans volume, tout est perdu à chaque mise à jour.
- Derrière Caddy (HTTPS), l'adresse publique est déduite de la requête : `PUBLIC_URL` est facultatif.
- Ressources : environ 60 Mo de RAM au repos. Tu peux limiter le conteneur (`--memory 256m --cpus 0.5`). Le tas Node est déjà plafonné à 160 Mo dans l'image.
- Le conteneur ne contient pas `curl` : le contrôle de santé utilise `wget`.
- Mise à jour automatique : ajoute le webhook de WDook dans GitHub (repo → Settings → Webhooks, `application/json`, secret vide) ; chaque push sur `main` redéploie l'addon.

## Worker Cloudflare (vidéo hors de ton serveur)

Pour que ton serveur ne télécharge pas les morceaux vidéo (bande passante), le Worker du dossier `worker/` le fait à sa place pour les lecteurs mpv/ffmpeg (Stremio PC, Nuvio…). Les adresses sont chiffrées par l'addon avec `SECRET` : le Worker n'est pas un relais ouvert.

Dans `/config` → Options → « Téléchargement de la vidéo » :

| Mode | Qui télécharge la vidéo |
|---|---|
| Automatique | le Worker dès qu'un lecteur mpv/ffmpeg est détecté |
| Direct | le lecteur, directement chez Twitch |
| Serveur externe (Cloudflare) | le Worker |
| Via le serveur de l'addon | ton serveur, avec une **clé d'accès** (dashboard → Vidéo) |

Installation, déploiement automatique par GitHub Actions, coût et suivi de la consommation : voir [`worker/README.md`](worker/README.md). Si le Worker ne répond pas, vérifie que son `SECRET` est identique à celui de l'addon.

## Configuration

Presque tout se règle dans le dashboard : `/admin` → **Paramètres → Configuration** (Cloudflare et Worker, API Twitch, relais personnalisés, adresse publique, port, journal de diagnostic). Les valeurs sont enregistrées dans `data/data.json` ; les jetons et mots de passe y sont chiffrés avec `SECRET`. Le compte Twitch de l'administrateur se lie dans l'onglet **Diagnostic**, l'activation de chaque relais dans l'onglet **Relais**. Tout est pris en compte tout de suite, sauf `PORT` et `HOST` (au prochain démarrage).

Le fichier `.env` ne garde que :

| Variable | Rôle |
|---|---|
| `ADMIN_PASSWORD` | mot de passe du dashboard `/admin` |
| `SECRET` | clé de chiffrement des jetons Twitch placés dans les liens et des jetons saisis dans le dashboard (la changer invalide ces liens, et il faut ressaisir les jetons) |
| `DATA_DIR` | facultatif : dossier de `data.json` (lu avant le dashboard) |
| `TELEGRAM_BOT_TOKEN` | facultatif : bot Telegram des alertes |

Variables facultatives du `.env.example` : `PORT`, `PUBLIC_URL`, `SAVE_DELAY_MS`, et les réglages expérimentaux du chat (`CHAT_SUBS`, `CHAT_DELAY_MS`, `CHAT_MAX_ROOMS`, `CHAT_BURN`, `BURN_*`).

Au premier démarrage avec ce système, ce qui se trouvait déjà dans le `.env` est repris automatiquement : tu peux ensuite supprimer ces lignes.

## Pages et adresses

| Adresse | Rôle |
|---|---|
| `/config` | chaque personne choisit un pseudo et ses réglages, obtient son lien d'installation, teste le serveur et lie son compte Twitch |
| `/alerte` | alertes de live, découverte et recherche de streamers |
| `/admin` | dashboard d'administration (onglets Dashboard, Utilisateurs, Journal, Relais, Vidéo, Diagnostic, Page config, Paramètres, Alertes) |
| `/manifest.json` | manifeste de l'addon |
| `/u/<id>` | profil enregistré (réglages protégés par mot de passe) |
| `/test/<streamer>` | indique si ce serveur obtient bien le flux d'un live |
| `/relais/<streamer>` | indique quels relais répondent |

## Sécurité

- **En-têtes** : l'addon envoie lui-même `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (en https) et une `Content-Security-Policy` sur `/config`, `/alerte` et `/admin` : rien à ajouter dans le Caddyfile.
- **Connexion à un profil** : le mot de passe n'est pas gardé dans le navigateur. Après la connexion, le serveur renvoie un jeton de session aléatoire (10 minutes, renouvelé à chaque usage). Mot de passe d'au moins 8 caractères pour un nouveau mot de passe, stocké haché (scrypt), 8 essais ratés par profil et 20 par adresse toutes les 10 minutes.
- **Mot de passe oublié** : dans `/admin` → Utilisateurs, « Réinitialiser le mdp » affiche un **code à usage unique** (valable 24 h). La personne le tape à la place du mot de passe, puis en choisit un nouveau. Tant que le code n'est pas utilisé, le profil reste fermé.
- **CORS** : `Access-Control-Allow-Origin: *` n'est envoyé que pour ce dont Stremio a besoin (manifeste, catalogues, flux, lecture), jamais pour `/api` ni `/admin`.
- **Clé d'accès** : `/api/akey` se vérifie en `POST` (la clé ne passe pas dans l'adresse, donc pas dans les journaux), avec 15 vérifications par minute et par adresse.
- **Alertes** : les abonnements Push doivent venir des services Push connus (FCM, Mozilla, Apple, Windows) ; les requêtes sont limitées par adresse.
- **Cookie `auth-token`** : il donne accès au compte Twitch. Ne le partage jamais, et ne partage pas un lien d'installation qui contient un jeton lié.

## Données

Tout est enregistré dans `data/data.json` : statistiques, journal, utilisateurs, profils, réglages du site, abonnements aux alertes, logo et compte lié. Le fichier est relu à chaque démarrage.

- Écriture atomique (fichier temporaire puis renommage), peu après le dernier changement, et à l'arrêt de l'addon.
- Copie de secours `data/data.bak.json` toutes les 10 minutes ; si `data.json` est illisible, la copie est restaurée.
- Pour changer de dossier : variable `DATA_DIR`.
- Pour sauvegarder ou déplacer l'addon : copie le dossier `data` et le fichier `.env`.
- Les abonnements d'alerte sont des données personnelles (adresse Push, identifiant Telegram) : « Désactiver » sur `/alerte` ou `/stop` sur Telegram les supprime du serveur.

## Fonctionnement et limites

La lecture des lives utilise l'interface interne de Twitch : méthode **non officielle**, qui peut cesser de fonctionner.

Les flux « sans pub » passent par des relais tiers (même liste que le script Twitch HLS Proxy), interrogés côté serveur : le lecteur ne contacte jamais le relais. Si un relais répond 403 pour une chaîne, il est écarté 10 minutes pour cette chaîne et l'addon passe au suivant, puis au flux officiel.

### 1440p (compte Twitch lié)

Twitch ne donne le 1440p qu'au site web avec un compte connecté. Sur `/config`, la personne colle la valeur de son cookie `auth-token` (twitch.tv) : elle est vérifiée auprès de Twitch, chiffrée en AES-256-GCM (clé `SECRET`, sinon `ADMIN_PASSWORD`) et placée dans son lien d'installation. Les profils enregistrés gardent aussi ce jeton chiffré dans `data.json`. Changer `SECRET` invalide tous les liens. Activer aussi « Autoriser le 1440p ».
