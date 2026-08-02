FROM rust:1.86-bookworm AS builder

WORKDIR /src
COPY . .
RUN cargo build --release -p citizen-node

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 10001 citizen \
    && useradd --system --uid 10001 --gid citizen --home-dir /opt/citizen --no-create-home --shell /usr/sbin/nologin citizen

WORKDIR /opt/citizen
COPY --from=builder /src/target/release/citizen-node /usr/local/bin/citizen-node
COPY deploy/runtime-stack/config/node.docker.toml /etc/citizen/node.toml
RUN mkdir -p /var/lib/citizen && chown -R citizen:citizen /var/lib/citizen /etc/citizen

USER citizen

EXPOSE 8080 9100 9200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/citizen-node", "--health-check"]

ENTRYPOINT ["/usr/local/bin/citizen-node"]
CMD ["/etc/citizen/node.toml"]
