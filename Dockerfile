FROM node:20-alpine

ENV NODE_ENV=production \
	PORT=8080

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY src ./src

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["npm", "start"]

