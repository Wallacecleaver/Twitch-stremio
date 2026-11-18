# TwitchIO

Addon Stremio hébergé sur ton PC : regarder des lives Twitch dans Stremio. [Node.js](https://nodejs.org) 18 ou plus.

## Lancer l'addon

1. Double-clique sur `start.bat` ou lance `npm ci --omit=dev` puis `npm start` dans un terminal.
2. Au premier lancement, un fichier `.env` est créé à côté de `index.js` avec un mot de passe pour le dashboard et une clé de chiffrement. Le mot de passe est aussi affiché dans la console.
3. Ouvre `http://localhost:7000/config`, choisis tes réglages, puis installe le lien obtenu dans Stremio.

Sur le même PC, Stremio accepte `http://localhost:7000`. Pour tes amis (ou Stremio sur un autre appareil), il faut une adresse **https** publique : un tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) vers le port 7000. Mets cette adresse dans le dashboard (Paramètres → Configuration → Adresse publique) du fichier `.env`, puis redémarre.

## Alertes de live

Sur `/alerte`, ajoute jusqu’à 12 chaînes par navigateur, puis active les notifications. Le serveur vérifie les directs environ toutes les minutes et envoie une notification quand une chaîne surveillée démarre un nouveau live. Le bouton « Envoyer un test » permet de vérifier la réception.

Les alertes arrivent même quand la page est fermée, tant que le navigateur et le système autorisent les notifications en arrière-plan. Utilise l’adresse HTTPS de l’addon. Sur iPhone ou iPad, ajoute la page à l’écran d’accueil avant d’activer les alertes. Les abonnements et la clé Push sont enregistrés dans le dossier de données.

L’onglet « Alertes » du dashboard permet de modifier le titre et l’introduction de la page, de mettre les envois en pause et de consulter le nombre de navigateurs abonnés et de chaînes surveillées. Les diffusions commencées pendant la pause ne déclenchent pas d’alerte à la reprise.

## Sur un VPS (Docker / WDook)

Le repo contient un `Dockerfile` (Node 22 Alpine) et un `.env.example`.

- **WDook** : « Nouveau projet » → choisis le repo ; les variables du `.env.example` sont préremplies, le port est `7000`. Laisse `ADMIN_PASSWORD` et `SECRET` vides : ils sont générés au premier démarrage (le mot de passe du dashboard est affiché dans les logs du conteneur, `docker logs <conteneur>`).
- **Docker seul** :
  ```bash
  docker build -t twitchio .
  docker run -d --name twitchio --restart unless-stopped -p 7000:7000 -v twitchio-data:/app/data twitchio
  ```
- Le dossier `/app/data` est un volume : il contient `data.json`, la copie de secours et le `.env` généré (variable `ENV_FILE`). Sans volume, tout est perdu à chaque mise à jour.
- Derrière Caddy (HTTPS), l'adresse publique est déduite de la requête : `PUBLIC_URL` est facultatif.
- Ressources : l'addon tourne avec ~60 Mo de RAM au repos. Tu peux limiter le conteneur (`--memory 256m --cpus 0.5`) sans problème. Le tas Node est déjà plafonné à 160 Mo dans l'image.
- Le Worker Cloudflare (`worker/`) se déploie à part, il n'est pas dans l'image.
- Mise à jour automatique : ajoute le webhook de WDook dans GitHub (repo → Settings → Webhooks, `application/json`, secret vide) ; chaque push sur `main` redéploie l'addon.

## Données (fichier JSON)

Tout est enregistré dans `data/data.json` : statistiques, journal, utilisateurs, profils (`/u/<id>`), réglages du site, logo et compte lié. Le fichier est relu à chaque démarrage, donc rien n'est perdu quand l'addon ou le PC redémarre.

- Écriture atomique (fichier temporaire puis renommage), 2 secondes après le dernier changement, et à l'arrêt de l'addon.
- Copie de secours `data/data.bak.json` toutes les 10 minutes ; si `data.json` est illisible, la copie est restaurée.
- Pour changer de dossier : variable `DATA_DIR` dans `.env`.
- Pour sauvegarder ou déplacer l'addon : copie le dossier `data` et le fichier `.env`.

## Configuration

Tout se règle dans le dashboard : `/admin` → **Paramètres → Configuration** (Cloudflare et Worker, API Twitch, relais personnalisés, adresse publique, port, journal de diagnostic). Les valeurs sont enregistrées dans `data/data.json` ; les jetons et mots de passe y sont chiffrés avec `SECRET`. Le compte Twitch de l'administrateur se lie dans l'onglet **Diagnostic** (section « Mon compte Twitch »). L'activation de chaque relais se fait dans l'onglet **Relais**. Tout est pris en compte tout de suite, sauf `PORT` et `HOST` (au prochain démarrage).

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
- `/admin` : dashboard en 8 onglets : Dashboard (lectures, part sans pub, appareils, incidents, graphique 7 jours), Utilisateurs, Journal (export CSV), Relais (santé et activation), Vidéo (Cloudflare, clés d'accès), Diagnostic (test d'une chaîne, lecteur de test, compte Twitch lié), Page config (réglages de /config) et Paramètres (fonctionnalités, limites, maintenance, configuration du serveur)
- `/test/<nom d'un streamer en direct>` : indique si ce serveur obtient bien le flux du live
- `/relais/<nom d'un streamer en direct>` : indique quels relais répondent

## Sécurité

- **En-têtes** : l'addon envoie lui-même `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (en https) et une politique `Content-Security-Policy` sur `/config` et `/admin` : rien à ajouter dans le Caddyfile.
- **Connexion à un profil** : le mot de passe n'est plus gardé dans le navigateur. Après la connexion, le serveur renvoie un jeton de session aléatoire (10 minutes, renouvelé à chaque usage) ; c'est lui qui est gardé dans l'onglet. Mot de passe d'au moins 8 caractères pour un nouveau mot de passe (les anciens restent valables), stocké haché (scrypt), 8 essais ratés par profil et 20 par adresse toutes les 10 minutes.
- **Mot de passe oublié** : dans `/admin` → Utilisateurs, « Réinitialiser le mdp » affiche un **code à usage unique** (valable 24 h). La personne le tape à la place du mot de passe sur la page de connexion, puis en choisit un nouveau. Tant que le code n'est pas utilisé, le profil reste fermé : le lien d'installation seul ne donne plus accès aux réglages.
- **CORS** : `Access-Control-Allow-Origin: *` n'est envoyé que pour ce dont Stremio a besoin (manifeste, catalogues, flux, lecture), jamais pour `/api` ni `/admin`.
- **Clé d'accès** : `/api/akey` se vérifie en `POST` (la clé ne passe plus dans l'adresse, donc plus dans les journaux), avec une limite de 15 vérifications par minute et par adresse.

## Fonctionnement

La lecture des lives utilise l'interface interne de Twitch : méthode non officielle, qui peut cesser de fonctionner.

Les flux « sans pub » passent par des relais tiers (même liste que le script Twitch HLS Proxy), interrogés côté serveur : le lecteur ne contacte jamais le relais. Si aucun relais ne répond, repli sur le flux officiel.

### 1440p (compte Twitch lié)

Twitch ne donne le 1440p qu'au site web avec un compte connecté. Sur `/config`, la personne colle la valeur de son cookie `auth-token` (twitch.tv) : elle est vérifiée auprès de Twitch, chiffrée en AES-256-GCM (clé `SECRET`, sinon `ADMIN_PASSWORD`) et placée dans son lien d'installation. Les profils enregistrés (`/u/<id>`) gardent aussi ce jeton chiffré dans `data.json`. Changer `SECRET` invalide tous les liens. Activer aussi « Autoriser le 1440p ».
