export type Chapter = {
  id: string;
  title: string;
  description: string;
  content?: string;
  startFrame: number;
  endFrame: number;
  orderIndex: number;
};

export const CHAPTERS: Chapter[] = [
  {
    id: 'introduction',
    title: 'Introduction to Citizen Protocol',
    description: 'A governance-first ledger for public truth, records, and institutional accountability.',
    content: '',
    startFrame: 0,
    endFrame: 79,
    orderIndex: 1,
  },
  {
    id: 'problem',
    title: 'Problem: Centralized Governance Systems',
    description: 'Legacy systems are fragmented, opaque, and prone to unilateral control.',
    content: '',
    startFrame: 80,
    endFrame: 159,
    orderIndex: 2,
  },
  {
    id: 'architecture',
    title: 'Architecture: Validator / Observer Model',
    description: 'Identity-anchored validators and independently verifiable observer nodes.',
    content: '',
    startFrame: 160,
    endFrame: 239,
    orderIndex: 3,
  },
  {
    id: 'consensus',
    title: 'Consensus Layer',
    description: 'Linear BFT consensus with deterministic finality at an 80% supermajority.',
    content: '',
    startFrame: 240,
    endFrame: 319,
    orderIndex: 4,
  },
  {
    id: 'runtime',
    title: 'Citizen Node Runtime',
    description: 'Modular runtime: networking, consensus, ledger, governance, and storage.',
    content: '',
    startFrame: 320,
    endFrame: 399,
    orderIndex: 5,
  },
  {
    id: 'integration',
    title: 'Government Integration Model',
    description: 'API-first adoption path for registries, audits, and civic workflows.',
    content: '',
    startFrame: 400,
    endFrame: 479,
    orderIndex: 6,
  },
  {
    id: 'roadmap',
    title: 'Roadmap',
    description: 'Phased rollout: builder tooling, governance hardening, and ecosystem growth.',
    content: '',
    startFrame: 480,
    endFrame: 559,
    orderIndex: 7,
  },
  {
    id: 'call-to-action',
    title: 'Call to Action',
    description: 'Join the validator and builder ecosystem to shape accountable digital infrastructure.',
    content: '',
    startFrame: 560,
    endFrame: 639,
    orderIndex: 8,
  },
];
