export type Chapter = {
  id: string;
  title: string;
  description: string;
  startFrame: number;
  endFrame: number;
  orderIndex: number;
};

export const CHAPTERS: Chapter[] = [
  {
    id: 'introduction',
    title: 'Introduction to Citizen Protocol',
    description: 'A governance-first ledger for public truth, records, and institutional accountability.',
    startFrame: 0,
    endFrame: 79,
    orderIndex: 1,
  },
  {
    id: 'problem',
    title: 'Problem: Centralized Governance Systems',
    description: 'Legacy systems are fragmented, opaque, and prone to unilateral control.',
    startFrame: 80,
    endFrame: 159,
    orderIndex: 2,
  },
  {
    id: 'architecture',
    title: 'Architecture: Validator / Observer Model',
    description: 'Identity-anchored validators and independently verifiable observer nodes.',
    startFrame: 160,
    endFrame: 239,
    orderIndex: 3,
  },
  {
    id: 'consensus',
    title: 'Consensus Layer',
    description: 'Linear BFT consensus with deterministic finality at an 80% supermajority.',
    startFrame: 240,
    endFrame: 319,
    orderIndex: 4,
  },
  {
    id: 'runtime',
    title: 'Citizen Node Runtime',
    description: 'Modular runtime: networking, consensus, ledger, governance, and storage.',
    startFrame: 320,
    endFrame: 399,
    orderIndex: 5,
  },
  {
    id: 'integration',
    title: 'Government Integration Model',
    description: 'API-first adoption path for registries, audits, and civic workflows.',
    startFrame: 400,
    endFrame: 479,
    orderIndex: 6,
  },
  {
    id: 'roadmap',
    title: 'Roadmap',
    description: 'Phased rollout: builder tooling, governance hardening, and ecosystem growth.',
    startFrame: 480,
    endFrame: 559,
    orderIndex: 7,
  },
  {
    id: 'call-to-action',
    title: 'Call to Action',
    description: 'Join the validator and builder ecosystem to shape accountable digital infrastructure.',
    startFrame: 560,
    endFrame: 639,
    orderIndex: 8,
  },
];
