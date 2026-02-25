'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from './admin-ui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface StatsResponse {
  totalInterestSubmissions: number;
}

interface InterestSubmission {
  id: string;
  fullName: string;
  institution: string;
  email: string;
  country: string;
  missionNeed: string;
  createdAt: string;
}

export function AdminApplicantsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [submissions, setSubmissions] = useState<InterestSubmission[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadDashboard = async () => {
      try {
        const [statsResponse, submissionsResponse] = await Promise.all([
          fetch(`${API_URL}/interest/stats`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API_URL}/interest/submissions`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);

        if (statsResponse.status === 401 || submissionsResponse.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!statsResponse.ok || !submissionsResponse.ok) {
          throw new Error('Unable to load applicants');
        }

        setStats((await statsResponse.json()) as StatsResponse);
        setSubmissions((await submissionsResponse.json()) as InterestSubmission[]);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown applicants error');
      }
    };

    loadDashboard();
  }, [router]);

  return (
    <section className="space-y-5">
      <Card gradient>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-semibold text-slate-700">Review new submissions and collaborate on approvals.</p>
            </div>
            <Badge variant="success">{stats?.totalInterestSubmissions ?? 0} TOTAL</Badge>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-xl border-2 border-red-200 bg-red-50 p-4 text-sm font-medium text-red-600">{error}</div>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Latest applications</CardTitle>
            <CardDescription>Newest submissions appear first.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border-2 border-slate-200">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead className="bg-gradient-to-r from-slate-50 to-slate-100 text-xs font-bold uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((submission) => (
                    <tr key={submission.id} className="border-t-2 border-slate-100 bg-white transition-colors hover:bg-slate-50">
                      <td className="px-5 py-4">
                        <p className="font-bold text-slate-900">{submission.fullName}</p>
                        <p className="mt-1 text-sm font-semibold text-slate-600">{submission.institution}</p>
                        <p className="mt-1 text-sm text-slate-500">{submission.missionNeed}</p>
                      </td>
                      <td className="px-5 py-4">
                        <a
                          href={`mailto:${submission.email}`}
                          className="font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {submission.email}
                        </a>
                      </td>
                      <td className="px-5 py-4">
                        <Badge variant="info">{submission.country}</Badge>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-sm font-semibold text-slate-600">{new Date(submission.createdAt).toLocaleDateString()}</span>
                      </td>
                    </tr>
                  ))}
                  {submissions.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-12">
                        <div className="flex flex-col items-center gap-3">
                          <div className="rounded-full bg-slate-100 p-4">
                            <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                              <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                            </svg>
                          </div>
                          <p className="text-sm font-semibold text-slate-500">No applications yet</p>
                          <p className="text-sm text-slate-400">Check back later for new submissions</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
