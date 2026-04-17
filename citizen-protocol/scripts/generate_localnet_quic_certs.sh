#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/config/localnet/certs"
FRESH=0

if [[ "${1:-}" == "--fresh" ]]; then
  FRESH=1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate localnet QUIC certificates" >&2
  exit 1
fi

if [[ "$FRESH" -eq 1 ]]; then
  rm -rf "$CERT_DIR"
fi
mkdir -p "$CERT_DIR"

if [[ -f "${CERT_DIR}/ca.der" && -f "${CERT_DIR}/ca.key.der" && "$FRESH" -eq 0 ]]; then
  echo "[localnet-certs] existing CA/material found in ${CERT_DIR}; skipping regeneration"
  exit 0
fi

echo "[localnet-certs] generating fresh localnet CA and validator certificates"

openssl genpkey -algorithm Ed25519 -out "${CERT_DIR}/ca.key" >/dev/null 2>&1
openssl pkey -in "${CERT_DIR}/ca.key" -outform DER -out "${CERT_DIR}/ca.key.der" >/dev/null 2>&1
openssl req -x509 \
  -new \
  -key "${CERT_DIR}/ca.key" \
  -out "${CERT_DIR}/ca.crt" \
  -subj "/CN=citizen-localnet-ca" \
  -days 3650 >/dev/null 2>&1
openssl x509 -in "${CERT_DIR}/ca.crt" -outform DER -out "${CERT_DIR}/ca.der" >/dev/null 2>&1

cat >"${CERT_DIR}/v3.ext" <<'EOF'
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth, clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = citizen.local
DNS.2 = citizen
IP.1 = 127.0.0.1
EOF

for validator in validator-alpha validator-beta validator-gamma; do
  openssl genpkey -algorithm Ed25519 -out "${CERT_DIR}/${validator}.key" >/dev/null 2>&1
  openssl pkey \
    -in "${CERT_DIR}/${validator}.key" \
    -outform DER \
    -out "${CERT_DIR}/${validator}.key.der" >/dev/null 2>&1
  openssl req \
    -new \
    -key "${CERT_DIR}/${validator}.key" \
    -out "${CERT_DIR}/${validator}.csr" \
    -subj "/CN=${validator}" >/dev/null 2>&1
  openssl x509 \
    -req \
    -in "${CERT_DIR}/${validator}.csr" \
    -CA "${CERT_DIR}/ca.crt" \
    -CAkey "${CERT_DIR}/ca.key" \
    -CAcreateserial \
    -out "${CERT_DIR}/${validator}.crt" \
    -days 365 \
    -extfile "${CERT_DIR}/v3.ext" >/dev/null 2>&1
  openssl x509 \
    -in "${CERT_DIR}/${validator}.crt" \
    -outform DER \
    -out "${CERT_DIR}/${validator}.der" >/dev/null 2>&1
done

rm -f "${CERT_DIR}"/*.csr "${CERT_DIR}/v3.ext" "${CERT_DIR}/ca.srl" "${CERT_DIR}"/*.crt "${CERT_DIR}"/*.key
echo "[localnet-certs] certificates written to ${CERT_DIR}"
