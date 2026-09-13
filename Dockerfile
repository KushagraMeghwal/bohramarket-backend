# Production image for the BohraMart Express backend.
FROM node:22-alpine

WORKDIR /usr/src/app

# Copy package files first so `npm ci` is cached across builds when only
# source code changes (not dependencies).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# node user/group already exist in the official node:alpine image.
USER node

# Cloud Run injects PORT at runtime; this is just documentation for `docker run`.
EXPOSE 8080

CMD ["npm", "start"]
