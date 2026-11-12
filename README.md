# TwitchIO

Addon Stremio hébergé sur ton PC : regarder des lives Twitch dans Stremio. Aucune dépendance à installer, seulement [Node.js](https://nodejs.org) 18 ou plus.

## Lancer l'addon

1. Double-clique sur `start.bat` (ou `node index.js` dans un terminal).
2. Au premier lancement, un fichier `.env` est créé à côté de `index.js` avec un mot de passe pour le dashboard et une clé de chiffrement. Le mot de passe est aussi affiché dans la console.
3. Ouvre `http://localhost:7000/config`, choisis tes réglages, puis installe le lien obtenu dans Stremio.

Sur le même PC, Stremio accepte `http://localhost:7000`. Pour tes amis (ou Stremio sur un autre appareil), il faut une adresse **https** publique : un tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel…) vers le port 7000. Mets cette adresse dans le dashboard (Paramètres → Configuration → Adresse publique) du fichier `.env`, puis redémarre.

## Sur un VPS (Docker / WDook)

Le repo contient un `Dockerfile` (Node 22 Alpine, aucune dépendance) et un `.env.example`.

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

## Fonctionnement

La lecture des lives utilise l'interface interne de Twitch : méthode non officielle, qui peut cesser de fonctionner.

Les flux « sans pub » passent par des relais tiers (même liste que le script Twitch HLS Proxy), interrogés côté serveur : le lecteur ne contacte jamais le relais. Si aucun relais ne répond, repli sur le flux officiel.

### 1440p (compte Twitch lié)

Twitch ne donne le 1440p qu'au site web avec un compte connecté. Sur `/config`, la personne colle la valeur de son cookie `auth-token` (twitch.tv) : elle est vérifiée auprès de Twitch, chiffrée en AES-256-GCM (clé `SECRET`, sinon `ADMIN_PASSWORD`) et placée dans son lien d'installation. Les profils enregistrés (`/u/<id>`) gardent aussi ce jeton chiffré dans `data.json`. Changer `SECRET` invalide tous les liens. Activer aussi « Autoriser le 1440p ».

## Chat Twitch en sous-titres (expérimental)

Désactivé par défaut. `CHAT_SUBS=1` (ou le réglage « Chat Twitch en sous-titres » du dashboard) ajoute une piste **Chat Twitch** à la liste de lecture des lives : les messages arrivent comme des sous-titres WebVTT live, alignés sur la vidéo grâce au PTS d'un segment de référence (relu toutes les minutes).

- La connexion au chat (IRC anonyme, sans compte) n'existe que pendant qu'une personne lit la piste, et se coupe après 90 s d'inactivité. `CHAT_MAX_ROOMS` limite le nombre de chaînes en même temps.
- `/chat/<chaîne>/debug` : état de la connexion, messages reçus, recalage vidéo.
- `CHAT_DELAY_MS` règle le décalage entre le chat et l'image.
- Dépend du lecteur : la piste doit apparaître dans le menu des sous-titres.

Le chat est ajouté à **tous** les flux d'un live : « Auto » (liste principale) mais aussi chaque qualité fixe et l'audio seul, qui passent par `/q/…` (mini liste principale à une seule qualité, avec la piste de chat). Cela demande que `SECRET` (ou `ADMIN_PASSWORD`) soit défini, comme pour le mode ordinateur.

Réglages de diagnostic (dashboard › Configuration) : **Chat : messages de test** (un message factice toutes les 3 s, pour vérifier l'affichage même si le chat est calme) et **Chat : heure des messages** (« Absolu » par défaut, ou « Norme HLS » avec X-TIMESTAMP-MAP si le lecteur n'affiche rien).

Chaque personne choisit sur sa page **/config › Options** (« Chat Twitch intégré ») si elle veut la piste de chat ; le serveur doit l'autoriser (`CHAT_SUBS=1` ou « Autoriser le chat Twitch en sous-titres » dans le dashboard). Mise en page : texte seul, 8 lignes, sans émotes, en bas à gauche (ou à droite / centré, réglage « Chat : disposition »). Astuce : réduis la taille des sous-titres dans Stremio et augmente « Chat : largeur » en proportion (à 60 % de taille, ≈ 92).

## Chat incrusté dans la vidéo (expérimental)

Sur `/config › Options`, « Chat Twitch » propose **Incrusté dans la vidéo** : une source « Chat » s'ajoute pour chaque qualité de la liste (jamais de 1440p). Le serveur lit le live avec **ffmpeg**, dessine le chat en panneau translucide en bas à droite (pseudos colorés, messages qui défilent) et ré-encode en HLS. Comme le chat est dans l'image, ça marche dans tous les lecteurs.

- À activer côté serveur : `CHAT_BURN=1` (ou « Autoriser le chat incrusté » dans le dashboard) et **ffmpeg** (déjà dans le `Dockerfile`).
- Pensé pour un petit serveur : un seul ffmpeg par chaîne (partagé entre tous ceux qui la regardent, arrêté 20 s après le dernier lecteur), x264 `ultrafast`, 30 images/s au plus, 720p au plus (`BURN_HEIGHT`, les qualités au-dessus retombent sur 720p), priorité basse, segments écrits en mémoire (`/dev/shm`).
- Budget de processeur : `BURN_BUDGET` (défaut 1,2, en « flux 720p30 » ; 480p ≈ 0,45, 360p ≈ 0,25) et `BURN_MAX` (défaut 3 chaînes). Au-delà, un nouveau flux avec chat est refusé plutôt que de ralentir tout le monde. Qui arrive sur une chaîne déjà en cours rejoint le flux existant, même avec une autre qualité.
- Réglages : `BURN_PANEL` (hauteur du panneau en %, défaut 50), `BURN_SIDE=left`, `BURN_PRESET=superfast` (meilleure image, ≈ 40 % de processeur en plus).
- **Synchro sur l'image** : l'image `k` du panneau (4 par seconde, envoyée en vidéo brute à ffmpeg) est calée sur l'heure de capture de l'image vidéo qu'elle recouvre, lue dans les `EXT-X-PROGRAM-DATE-TIME` de la liste Twitch (ffmpeg indique le premier segment qu'il ouvre). Les messages sont datés avec l'heure d'envoi de Twitch (`tmi-sent-ts`), la même horloge. Un message apparaît sur l'image qui précède son envoi de `CHAT_DELAY_MS` (défaut 6000) : la réaction tombe sur l'action. Une image n'est envoyée qu'une fois tous les messages qu'elle doit montrer arrivés (latence IRC mesurée), donc rien de manqué. Sans dates dans la liste (certains relais), repli sur l'horloge du serveur avec `BURN_DELAY_MS` (défaut 8000) ; `BURN_SYNC=0` force ce mode. L'état (mode, retard sur le direct, sauts de date) est dans `/burn/debug`.
- **Démarrage** : ffmpeg part `BURN_START` segments en arrière du direct (défaut 4, de 3 à 6) et analyse moins le flux au départ ; plus en arrière = la vidéo apparaît plus vite (les premiers segments n'attendent pas leurs messages), au prix d'un léger retard de plus. Tant qu'aucun message n'est arrivé, le panneau reste transparent.
- **1080p** : `BURN_HEIGHT=1080` (ou « Chat incrusté : qualité maximale » du dashboard) ajoute la source « Chat 1080p » (30 images/s ; une source en 60 i/s est ramenée à 30). Un flux 1080p30 compte 2,25 dans le budget (≈ un cœur de plus qu'un 720p) : `BURN_BUDGET` passe alors à 2,4 par défaut (à régler selon ton serveur). Le panneau est dessiné à la taille native avec un atlas de police 26 px (`lib/assets/chatfont26.json`, régénérable avec `python3 tools/make-chatfont.py 26 lib/assets/chatfont26.json`), donc net comme en 720p.
- Texte seul pour l'instant (les émotes sont retirées). `/burn/debug` montre les flux en cours, le budget utilisé et les derniers messages de ffmpeg.
- Le texte est dessiné à partir d'un atlas de glyphes pré-rendus de la police **Inter** (SIL OFL 1.1), régénérable avec `python3 tools/make-chatfont.py`.
