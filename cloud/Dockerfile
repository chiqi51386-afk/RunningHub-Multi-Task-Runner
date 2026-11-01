FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY cloud/package.json cloud/package-lock.json ./
RUN npm ci
COPY src/core ./src/core
COPY src/cloud ./src/cloud
COPY cloud/tsconfig.json ./cloud/tsconfig.json
RUN npx tsc -p cloud/tsconfig.json && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY bundled-workflows ./bundled-workflows
COPY prompt-skills ./prompt-skills
COPY THIRD_PARTY_LICENSES ./THIRD_PARTY_LICENSES
RUN mkdir /data && chown node:node /data
USER node
ENV RH_DATA_DIR=/data RH_BIND=0.0.0.0 RH_PORT=17863
EXPOSE 17863
VOLUME /data
CMD ["node", "dist/src/cloud/main.js"]
