# Worker Cloudflare : morceaux vidéo hors de ton serveur

Ce Worker télécharge **à la place de l'addon** les listes de lecture (`/m/`) et les morceaux vidéo (`/s/`) pour les lecteurs qui en ont besoin (mpv/ffmpeg : Stremio PC, Nuvio…). L'addon ne fait plus passer aucune vidéo par ton serveur : il ne sert que la liste des sources et la liste principale.

Les adresses sont chiffrées par l'addon avec `SECRET` : le Worker n'est pas un relais ouvert, il ne sait ouvrir que ce que l'addon a chiffré.

## Installation

1. `cd worker`
2. `npx wrangler login`
3. `npx wrangler secret put SECRET` → colle **la même valeur** que `SECRET` dans le `.env` de l'addon (ou `ADMIN_PASSWORD` s'il n'y a pas de `SECRET`).
4. `npx wrangler deploy` → note l'adresse `https://twitchio-segments.<ton-compte>.workers.dev`.
5. Dans le `.env` de l'addon : `SEGMENTS_ORIGIN=https://twitchio-segments.<ton-compte>.workers.dev` (sans slash final), puis redémarre l'addon.
6. Dans `/config` → Options → « Téléchargement de la vidéo » : **Serveur externe (Cloudflare)** (ou « Automatique » : l'addon l'utilise dès qu'un lecteur mpv/ffmpeg est détecté).

Pour que plusieurs spectateurs d'une même chaîne partagent le même morceau (cache de la zone Cloudflare), utilise un domaine à toi (`routes` dans `wrangler.toml`) : le cache ne marche pas sur `*.workers.dev`.

## Coût (à vérifier sur la grille Cloudflare)

Pas de facturation de bande passante. Plan gratuit : 100 000 requêtes/jour. Plan payant : 5 $/mois, 10 M de requêtes incluses puis 0,30 $/M, plus 30 M ms de CPU incluses puis 0,02 $/M ms.
Un spectateur fait environ 1 requête par seconde (un morceau et une liste toutes les 2 s) : ≈ 3 600 par heure.

## Variables de l'addon

- `SEGMENTS_ORIGIN` : adresse du Worker.
- `SEGMENTS_ADDON=0` : interdit à l'addon de relayer lui-même les morceaux (route `/s/` fermée).
- `TWITCH_SEGMENTS_PROXY` : `0` = en mode « Automatique », jamais d'intermédiaire ; `1` = toujours.
- `DEBUG_HTTP=1` : une ligne de journal par requête dans la console (lecteur, statut, octets, durée ; « COUPÉ » si le lecteur abandonne).

## Suivre la consommation dans le dashboard

Onglet **Vidéo** du dashboard (`/admin`) : lectures par mode (Cloudflare, direct, serveur de l'addon), état du Worker, vidéo encore passée par ton serveur, profils par mode et conseils. Chaque lecture du journal indique aussi « vidéo via Cloudflare ✓ » (ou directe / via l'addon).

Pour y voir aussi les requêtes, les erreurs, le temps de CPU et le coût estimé du Worker, relie le dashboard à Cloudflare :

1. Cloudflare → **My Profile → API Tokens → Create Token** → modèle personnalisé, permission **Account → Account Analytics → Read**.
2. Dans le `.env` : `CF_API_TOKEN=` (le jeton) et `CF_ACCOUNT_ID=` (32 caractères, visibles dans l'adresse du tableau de bord Cloudflare). `CF_WORKER_NAME=` seulement si tu as renommé le Worker.
3. Redémarre l'addon. Les chiffres sont mis à jour toutes les 5 minutes.
