FROM mcr.microsoft.com/playwright:v1.65.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/pinmap-python \
    && /opt/pinmap-python/bin/pip install --no-cache-dir yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.py collect_link.mjs ./
COPY collector ./collector
RUN mkdir -p /app/data/media \
    && chown -R pwuser:pwuser /app/data

ENV PINMAP_BIND_HOST=0.0.0.0 \
    PINMAP_BROWSER_CHANNEL=bundled \
    PINMAP_YT_DLP_BIN=/opt/pinmap-python/bin/yt-dlp
USER pwuser
EXPOSE 8210
CMD ["sh", "-c", "exec python3 place_server.py serve --port ${PORT:-8210}"]
