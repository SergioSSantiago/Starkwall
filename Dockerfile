# Torii service container (Sepolia)
# Deploy with Fly.io using the included fly.toml.

FROM ubuntu:24.04 AS fetch
ARG TORII_VERSION=1.8.15

RUN apt-get update   && apt-get install -y --no-install-recommends ca-certificates curl tar   && rm -rf /var/lib/apt/lists/*

# Torii releases are published under https://github.com/dojoengine/torii
RUN curl -L -o /tmp/torii.tgz       "https://github.com/dojoengine/torii/releases/download/v${TORII_VERSION}/torii_v${TORII_VERSION}_linux_amd64.tar.gz"   && tar -xzf /tmp/torii.tgz -C /usr/local/bin   && chmod +x /usr/local/bin/torii   && rm -f /tmp/torii.tgz

FROM ubuntu:24.04
RUN apt-get update   && apt-get install -y --no-install-recommends ca-certificates   && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /usr/local/bin/torii /usr/local/bin/torii
COPY contracts/torii_sepolia.toml /app/torii.toml

# Fly mounts the persistent volume at /data (see fly.toml).
RUN mkdir -p /data

EXPOSE 8080

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
CMD ["torii", "--config", "/app/torii.toml"]
