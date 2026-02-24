import Link from 'next/link';
import { InterestForm } from '@/components/InterestForm';

const pillars = [
  {
    title: 'Governance-First by Design',
    detail: 'Citizen starts from institutional accountability, not speculative finance.',
  },
  {
    title: '80% Quorum Deterministic Finality',
    detail: 'Records are final when committed, with safe stall behavior under quorum loss.',
  },
  {
    title: 'Observer Node Transparency',
    detail: 'Citizens and auditors can verify directly from the network, not only government dashboards.',
  },
  {
    title: 'Non-Speculative Economics',
    detail: 'Builder fee credits and multisig controls align costs to service delivery.',
  },
];

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <p className="kicker">Citizen Protocol • Government Adoption Pitch</p>
        <Link className="admin-link" href="/admin/login">Admin login</Link>
        <h1>National-grade public ledger infrastructure, built for trust.</h1>
        <p>
          Deploy civic registries, audit trails, and governance records on a protocol built for
          deterministic finality, institutional accountability, and citizen-verifiable transparency.
        </p>
      </section>

      <section className="grid">
        {pillars.map((pillar) => (
          <article key={pillar.title} className="card">
            <h2>{pillar.title}</h2>
            <p>{pillar.detail}</p>
          </article>
        ))}
      </section>

      <section className="quote">
        <blockquote>
          “Citizen Protocol gives government a blockchain designed for public records—not DeFi
          speculation.”
        </blockquote>
      </section>

      <section className="cta">
        <div>
          <h2>Procurement-ready modernization starts here.</h2>
          <p>
            Engage our adoption team for a tailored implementation roadmap covering identity,
            registry, procurement audit, and governance workflows.
          </p>
        </div>
        <InterestForm />
      </section>
    </main>
  );
}
