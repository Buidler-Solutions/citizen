FROM rust:1.86-bookworm AS builder

WORKDIR /src
COPY . .
RUN cargo build --release -p citizen-node

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/citizen
COPY --from=builder /src/target/release/citizen-node /usr/local/bin/citizen-node
COPY deploy/runtime-stack/config/node.docker.toml /etc/citizen/node.toml

EXPOSE 8080 9100 9200

ENTRYPOINT ["/usr/local/bin/citizen-node"]
CMD ["/etc/citizen/node.toml"]
