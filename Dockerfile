# Manifold chat-demo —— 零依赖 Node 应用，不需要 npm install
FROM node:24-alpine

WORKDIR /app
COPY server.js db.js package.json ./
COPY public ./public

ENV PORT=8787
EXPOSE 8787

# 容器内健康检查：静态首页能 200 即认为存活
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/ > /dev/null || exit 1

CMD ["node", "server.js"]
