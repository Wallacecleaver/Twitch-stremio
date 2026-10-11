# Twitch pour Stremio

Addon Stremio hébergé sur Vercel : regarder des lives Twitch dans Stremio.

## Étape 1 (actuelle) — test de lecture
- `/manifest.json` : manifeste de l'addon
- `/test/<nom d'un streamer en direct>` : indique si Vercel obtient bien le flux du live
- Le catalogue « Lives populaires » apparaît quand `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` sont définies dans Vercel
  (application créée sur https://dev.twitch.tv/console)

## Suite prévue
Connexion par compte Twitch (suivis de chacun), catalogue des jeux, streamers par jeu.

La lecture des lives utilise l'interface interne de Twitch : méthode non officielle, qui peut cesser de fonctionner.

## Flux « sans pub » (relais)
Les flux « Twitch » passent par des relais : la liste de lecture est récupérée la liste de lecture auprès de relais tiers (même liste que le script Twitch HLS Proxy),
côté serveur : le lecteur ne contacte jamais le relais. Si aucun relais ne répond, repli sur le flux officiel.
- `/relais/<nom d'un streamer en direct>` : indique quels relais répondent depuis Vercel
- Variable `PROXIES` (facultative) : une adresse par ligne contenant `{channel}`, avec nom optionnel (`Nom | adresse`)

## Page de configuration (`/config`)

Chaque personne choisit un pseudo et ses réglages (qualité maximale, 60 i/s, relais sans pub, nombre de qualités fixes, audio seul, nom d'appareil). Elle obtient un lien d'installation personnel `/c/<pseudo>/<réglages>/manifest.json` : pas de compte, la configuration est dans l'adresse. Le pseudo apparaît dans le journal.

La page propose aussi un **test serveur** (la liste de lecture avance-t-elle, les segments arrivent-ils assez vite, y a-t-il des pubs) et un **lecteur de test** dans le navigateur qui envoie les blocages au journal.

## Dashboard d'administration (`/admin`)

Mot de passe dans la variable Vercel `ADMIN_PASSWORD`.

- Dashboard : lectures, part sans pub, appareils, incidents, graphique 7 jours, chaînes populaires, derniers incidents, système.
- Utilisateurs : pseudos, appareil, lectures, incidents, réglages, accès direct à leur journal.
- Relais : santé de chacun et test en direct.
- Journal : niveaux, contextes, filtre par utilisateur, recherche, pause, export CSV.
- Diagnostic : test de flux avec les réglages d'un utilisateur, sonde rapide.

Pour conserver stats, journal et utilisateurs, ajoute une base Upstash Redis (`UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`, ou `KV_REST_API_URL` et `KV_REST_API_TOKEN`). Sans elle, tout est gardé en mémoire et se vide régulièrement.

## 1440p (compte Twitch lié)

Twitch ne donne le 1440p qu'au site web avec un compte connecté. Sur `/config`, la personne colle la valeur de son cookie `auth-token` (twitch.tv) : elle est vérifiée auprès de Twitch, chiffrée en AES-256-GCM (clé : variable `SECRET`, sinon `ADMIN_PASSWORD`) et placée dans son lien d'installation. Rien n'est stocké côté serveur. Changer `SECRET` invalide tous les liens. Activer aussi « Autoriser le 1440p ».

**Mise à jour :** le compte Twitch se lie désormais dans le dashboard (onglet « Compte Twitch »), une seule fois pour tous les utilisateurs (jeton chiffré dans Upstash, ou variable `TWITCH_AUTH_TOKEN` sans base). Les tests (test serveur, lecteur de test, signalement) sont dans l'onglet Diagnostic du dashboard ; `/config` ne garde que le profil et les réglages.
