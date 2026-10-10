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
