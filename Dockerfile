# Manifold chat-demo —— 运行零依赖，不需要 npm install
# 后端是 TS，由 Node 24 的 type stripping 直接执行（仅擦类型、无构建产物）。
# typescript / @types/node 仅是本地 devDependency（跑类型检查用），镜像里不装、也不需要。
FROM node:24-alpine

WORKDIR /app
COPY server.ts db.ts package.json ./
COPY public ./public

ENV PORT=8787
EXPOSE 8787

# 容器内健康检查：静态首页能 200 即认为存活
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/ > /dev/null || exit 1

CMD ["node", "server.ts"]
