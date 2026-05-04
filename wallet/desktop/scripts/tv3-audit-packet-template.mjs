#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'citizen-protocol/docs/evidence/wallet-backup-vault', `TV3_BRIDGE_AUDIT_PACKET_${new Date().toISOString().slice(0, 10)}.json`);

const packet = {
  contract: 'citizen.wallet.desktop.tv3.bridge-audit-packet.v1',
  generated_at: new Date().toISOString(),
  artifacts: {
    linux: { immutable_uri: 'https://example.invalid/linux-audit-packet' },
    macos: { immutable_uri: 'https://example.invalid/macos-audit-packet' },
    windows: { immutable_uri: 'https://example.invalid/windows-audit-packet' }
  },
  review: {
    owner_role: 'wallet-desktop-security-maintainer',
    signed_off_on: new Date().toISOString().slice(0, 10),
    notes: 'Replace placeholder URIs and sign-off metadata before publishing.'
  }
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, 'utf8');
console.log(`tv3-audit-packet-template: wrote ${outputPath}`);
