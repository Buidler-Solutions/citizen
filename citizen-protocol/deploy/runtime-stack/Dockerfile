FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/citizen
COPY ../bin/citizen-node /usr/local/bin/citizen-node
COPY ../config/node.toml /etc/citizen/node.toml

EXPOSE 8080 9100 9200

ENTRYPOINT ["/usr/local/bin/citizen-node"]
CMD ["/etc/citizen/node.toml"]
