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
