FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS web-build

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.mjs ./
COPY .openai ./.openai
COPY worker ./worker
COPY scripts/prepare-sites-build.mjs ./scripts/prepare-sites-build.mjs
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.13-slim@sha256:7ce4b6dfe35e55397b7cda544f8a13f191b7ae28dc5aad71fe664dbc9bc2623f AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/service \
    PORT=8080

WORKDIR /app
COPY service/requirements.lock /app/service/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/service/requirements.lock

RUN addgroup --system foundroll && adduser --system --ingroup foundroll foundroll
COPY service /app/service
COPY deployment /app/deployment
COPY NOTICE.md THIRD_PARTY_NOTICES.md /app/
COPY --from=web-build /build/dist/client /app/dist/client
RUN chown -R foundroll:foundroll /app

USER foundroll
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz', timeout=2)"

CMD ["python", "-m", "deployment.serve"]
