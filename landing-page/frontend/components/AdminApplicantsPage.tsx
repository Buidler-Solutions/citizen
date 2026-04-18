'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ADMIN_TOKEN_KEY } from './admin-auth';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, Badge, Button, Input } from './admin-ui';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type ApplicantRole = 'All' | 'Validator' | 'Observer' | 'Builder' | 'Unknown';

interface StatsResponse {
  totalInterestSubmissions: number;
}

interface InterestSubmission {
  id: string;
  fullName: string;
  institution: string;
  email: string;
  country: string;
  role?: string;
  missionNeed: string;
  walletPayloadHash?: string | null;
  createdAt: string;
}

async function parseErrorMessage(response: Response, fallback = 'Request failed'): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string | string[] };

    if (Array.isArray(payload.message) && payload.message.length > 0) {
      return payload.message.join(', ');
    }

    if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
      return payload.message;
    }
  } catch {
    // Ignore non-JSON responses.
  }

  return fallback;
}

function extractRole(submission: InterestSubmission): Exclude<ApplicantRole, 'All'> {
  const explicitRole = submission.role?.trim().toLowerCase();

  if (explicitRole === 'validator') {
    return 'Validator';
  }

  if (explicitRole === 'observer') {
    return 'Observer';
  }

  if (explicitRole === 'builder') {
    return 'Builder';
  }

  const roleMatch = submission.missionNeed.match(/^\s*\[(Validator|Observer|Builder)\]/i);

  if (!roleMatch) {
    return 'Unknown';
  }

  const normalized = roleMatch[1].toLowerCase();

  if (normalized === 'validator') {
    return 'Validator';
  }

  if (normalized === 'observer') {
    return 'Observer';
  }

  return 'Builder';
}

export function AdminApplicantsPage() {
  const router = useRouter();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [submissions, setSubmissions] = useState<InterestSubmission[]>([]);
  const [error, setError] = useState('');
  const [searchText, setSearchText] = useState('');
  const [countryQuery, setCountryQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<ApplicantRole>('All');
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const filteredSubmissions = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    const normalizedCountry = countryQuery.trim().toLowerCase();

    return submissions.filter((submission) => {
      const submissionRole = extractRole(submission);
      const roleMatches = roleFilter === 'All' ? true : submissionRole === roleFilter;
      const textMatches =
        normalizedSearch.length === 0
          ? true
          : submission.fullName.toLowerCase().includes(normalizedSearch) ||
            submission.email.toLowerCase().includes(normalizedSearch);
      const countryMatches =
        normalizedCountry.length === 0 ? true : submission.country.toLowerCase().includes(normalizedCountry);

      return roleMatches && textMatches && countryMatches;
    });
  }, [countryQuery, roleFilter, searchText, submissions]);

  const handleDelete = async (submissionId: string) => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const shouldDelete = window.confirm('Delete this submission permanently?');

    if (!shouldDelete) {
      return;
    }

    setError('');
    setDeletingId(submissionId);

    try {
      const encodedId = encodeURIComponent(submissionId);
      let response = await fetch(`${API_URL}/interest/submissions/${encodedId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        const deleteErrorMessage = await parseErrorMessage(response, 'Unable to delete submission');
        const shouldTryPostFallback =
          response.status === 405 || (response.status === 404 && /Cannot\s+DELETE/i.test(deleteErrorMessage));

        if (shouldTryPostFallback) {
          response = await fetch(`${API_URL}/interest/submissions/${encodedId}/delete`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });

          if (response.status === 404) {
            const postDeleteErrorMessage = await parseErrorMessage(response, 'Unable to delete submission');
            if (/Cannot\s+POST/i.test(postDeleteErrorMessage)) {
              response = await fetch(`${API_URL}/interest/submissions/${encodedId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
              });

              if (response.status === 404) {
                const legacyPostErrorMessage = await parseErrorMessage(response, 'Unable to delete submission');
                if (/Cannot\s+POST/i.test(legacyPostErrorMessage)) {
                  response = await fetch(`${API_URL}/interest/submissions/delete`, {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${token}`,
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ id: submissionId }),
                  });
                }
              }
            }
          }
        }
      }

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        throw new Error(await parseErrorMessage(response, 'Unable to delete submission'));
      }

      setSubmissions((previous) => previous.filter((submission) => submission.id !== submissionId));
      setStats((previous) => {
        if (!previous) {
          return previous;
        }

        return {
          ...previous,
          totalInterestSubmissions: Math.max(0, previous.totalInterestSubmissions - 1),
        };
      });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unknown delete error');
    } finally {
      setDeletingId(null);
    }
  };

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
            <CardDescription>Filter by role, name/email, and country.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-3 md:grid-cols-3">
            <div>
              <label htmlFor="roleFilter" className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-500">
                Role
              </label>
              <select
                id="roleFilter"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value as ApplicantRole)}
                className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400"
              >
                <option value="All">All roles</option>
                <option value="Validator">Validator</option>
                <option value="Observer">Observer</option>
                <option value="Builder">Builder</option>
                <option value="Unknown">Unknown</option>
              </select>
            </div>
            <div>
              <label htmlFor="searchText" className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-500">
                Name or email
              </label>
              <Input
                id="searchText"
                placeholder="Search submitter"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="countryQuery" className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-500">
                Country
              </label>
              <Input
                id="countryQuery"
                placeholder="Search country"
                value={countryQuery}
                onChange={(event) => setCountryQuery(event.target.value)}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border-2 border-slate-200">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead className="bg-gradient-to-r from-slate-50 to-slate-100 text-xs font-bold uppercase tracking-wider text-slate-600">
                  <tr>
                    <th className="px-5 py-3">Name</th>
                    <th className="px-5 py-3">Contact</th>
                    <th className="px-5 py-3">Role</th>
                    <th className="px-5 py-3">Location</th>
                    <th className="px-5 py-3">Commitment receipt</th>
                    <th className="px-5 py-3">Submitted</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSubmissions.map((submission) => {
                    const role = extractRole(submission);

                    return (
                      <tr
                        key={submission.id}
                        className="border-t-2 border-slate-100 bg-white transition-colors hover:bg-slate-50"
                      >
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
                          <Badge variant={role === 'Validator' ? 'success' : role === 'Builder' ? 'info' : 'default'}>
                            {role}
                          </Badge>
                        </td>
                        <td className="px-5 py-4">
                          <Badge variant="info">{submission.country}</Badge>
                        </td>
                        <td className="px-5 py-4">
                          {submission.walletPayloadHash ? (
                            <code className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                              {submission.walletPayloadHash}
                            </code>
                          ) : (
                            <span className="text-sm text-slate-400">Not provided</span>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <span className="text-sm font-semibold text-slate-600">
                            {new Date(submission.createdAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => handleDelete(submission.id)}
                            disabled={deletingId === submission.id}
                            className="text-red-600 hover:bg-red-50 hover:text-red-700"
                          >
                            {deletingId === submission.id ? 'Deleting…' : 'Delete'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                  {filteredSubmissions.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-12">
                        <div className="flex flex-col items-center gap-3">
                          <div className="rounded-full bg-slate-100 p-4">
                            <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                              <path
                                stroke="currentColor"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
                              />
                            </svg>
                          </div>
                          <p className="text-sm font-semibold text-slate-500">No matching applications</p>
                          <p className="text-sm text-slate-400">Try changing or clearing your filters</p>
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
