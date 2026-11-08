# TwitchIO : aucune dépendance npm, donc rien à installer.
FROM node:22-alpine
WORKDIR /app

COPY package.json ./
COPY index.js ./
COPY lib ./lib

# Données (data.json, sauvegardes) et .env généré : dans un volume, pour survivre aux mises à jour.
# ENV_FILE place le .env dans ce volume : le mot de passe et la clé générés au 1er démarrage sont conservés.
# NODE_OPTIONS : plafonne la mémoire JavaScript (le tas réel reste très en dessous), pour qu'une fuite ne mange pas le VPS.
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=160 \
    PORT=7000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    ENV_FILE=/app/data/.env
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data

USER node
EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/logo.svg" || exit 1

CMD ["node", "index.js"]
