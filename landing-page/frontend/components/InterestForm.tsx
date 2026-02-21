'use client';

import { FormEvent, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function InterestForm() {
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData.entries());

    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/interest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Submission failed');
      }

      setStatus('Thank you. Our adoption team will contact you shortly.');
      form.reset();
    } catch (error) {
      setStatus('Unable to submit at the moment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="interest-form" onSubmit={submit}>
      <h3>Start Government Adoption Track</h3>
      <input name="fullName" placeholder="Full name" required minLength={2} />
      <input name="institution" placeholder="Institution / Ministry" required minLength={2} />
      <input name="email" type="email" placeholder="Official email" required />
      <input name="country" placeholder="Country" required minLength={2} />
      <textarea name="missionNeed" placeholder="What national workflow do you want to modernize?" required />
      <button type="submit" disabled={loading}>{loading ? 'Submitting...' : 'Request Briefing'}</button>
      {status && <p className="status">{status}</p>}
    </form>
  );
}
