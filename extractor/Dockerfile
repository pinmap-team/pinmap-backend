FROM mcr.microsoft.com/playwright:v1.65.0-noble AS whisper-build

# Pin the Korean-capable multilingual model and the CLI independently of the app build.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v1.9.5 https://github.com/ggml-org/whisper.cpp.git /tmp/whisper.cpp \
    && test "$(git -C /tmp/whisper.cpp rev-parse HEAD)" = d1be6fde11ac6e0407606b4e42fe72d34add8037 \
    && cmake -S /tmp/whisper.cpp -B /tmp/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release \
      -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF \
    && cmake --build /tmp/whisper.cpp/build --target whisper-cli --parallel 2
RUN mkdir -p /opt/pinmap-models \
    && curl --fail --location --retry 5 --retry-all-errors \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
      --output /opt/pinmap-models/ggml-base.bin \
    && echo '465707469ff3a37a2b9b8d8f89f2f99de7299dac  /opt/pinmap-models/ggml-base.bin' | sha1sum --check

FROM mcr.microsoft.com/playwright:v1.65.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg tesseract-ocr tesseract-ocr-kor tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/pinmap-python \
    && /opt/pinmap-python/bin/pip install --no-cache-dir yt-dlp 'scrapling[fetchers]==0.5.1' 'cryptography>=44,<47'
COPY --from=whisper-build /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /opt/pinmap-models/ggml-base.bin /opt/pinmap-models/ggml-base.bin
RUN ldd /usr/local/bin/whisper-cli | (! grep -q 'not found') \
    && test -s /opt/pinmap-models/ggml-base.bin
RUN ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 2 /tmp/pinmap-whisper-smoke.wav \
    && whisper-cli -m /opt/pinmap-models/ggml-base.bin -l ko -oj -of /tmp/pinmap-whisper-smoke \
      /tmp/pinmap-whisper-smoke.wav >/tmp/pinmap-whisper-smoke.log 2>&1 \
    && python3 -c 'import json; assert isinstance(json.load(open("/tmp/pinmap-whisper-smoke.json"))["transcription"], list)' \
    && rm -f /tmp/pinmap-whisper-smoke.wav /tmp/pinmap-whisper-smoke.json /tmp/pinmap-whisper-smoke.log

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY *.py collect_link.mjs categories.json ./
COPY production-keys.enc.json ./
COPY collector ./collector
RUN mkdir -p /app/data/media \
    && chown -R pwuser:pwuser /app/data

ENV OMP_THREAD_LIMIT=1 \
    PINMAP_BIND_HOST=0.0.0.0 \
    PINMAP_BROWSER_CHANNEL=bundled \
    PINMAP_YT_DLP_BIN=/opt/pinmap-python/bin/yt-dlp \
    PINMAP_WHISPER_MODEL=/opt/pinmap-models/ggml-base.bin
USER pwuser
EXPOSE 8210
CMD ["sh", "-c", "exec /opt/pinmap-python/bin/python place_server.py serve --port ${PORT:-8210}"]
