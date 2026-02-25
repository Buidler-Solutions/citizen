'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Download, CheckCircle, LoaderCircle, Mail } from 'lucide-react';
import { Button, Input, Card, CardHeader, CardTitle, CardDescription, CardContent, Badge } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface InterestSubmission {
  id: string;
  fullName: string;
  institution: string;
  email: string;
  country: string;
  missionNeed: string;
  createdAt: string;
}

interface StatsResponse {
  totalInterestSubmissions: number;
}

export default function SubmissionsPage() {
  const router = useRouter();
  const [submissions, setSubmissions] = useState<InterestSubmission[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadData = async () => {
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
          throw new Error('Unable to load submissions');
        }

        setStats(await statsResponse.json());
        setSubmissions(await submissionsResponse.json());
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [router]);

  const filteredSubmissions = submissions.filter((submission) => {
    const matchesSearch =
      submission.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      submission.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      submission.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = selectedStatus === 'all';
    return matchesSearch && matchesStatus;
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoaderCircle className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-600">{error}</div>
    );
  }

  return (
    <div className="space-y-6">
      <Card gradient>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="overflow-hidden rounded-xl border border-blue-200 bg-gradient-to-br from-blue-500/10 to-blue-600/5 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-blue-700">Total Submissions</p>
                  <p className="mt-1 text-4xl font-black text-blue-900">{stats?.totalInterestSubmissions ?? 0}</p>
                </div>
                <div className="rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 p-3 text-white shadow-lg shadow-blue-500/30">
                  <CheckCircle className="h-6 w-6" />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Submissions</CardTitle>
              <CardDescription>Review and manage all submitted interest forms</CardDescription>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Search submissions..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b-2 border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100">
                    <th className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Name</th>
                    <th className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Email</th>
                    <th className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Institution</th>
                    <th className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Country</th>
                    <th className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-600">Date</th>
                    <th className="px-5 py-3 text-center text-xs font-bold uppercase tracking-wider text-slate-600">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredSubmissions.map((submission) => (
                    <tr key={submission.id} className="bg-white transition-colors hover:bg-slate-50">
                      <td className="px-5 py-4">
                        <p className="font-bold text-slate-900">{submission.fullName}</p>
                        <p className="mt-1 text-sm text-slate-600">{submission.missionNeed.substring(0, 50)}...</p>
                      </td>
                      <td className="px-5 py-4">
                        <a
                          href={`mailto:${submission.email}`}
                          className="text-sm font-medium text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {submission.email}
                        </a>
                      </td>
                      <td className="px-5 py-4">
                        <Badge variant="info">{submission.institution}</Badge>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-sm font-semibold text-slate-700">{submission.country}</span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-sm font-semibold text-slate-600">{formatDate(submission.createdAt)}</span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-center gap-2">
                          <a
                            href={`mailto:${submission.email}`}
                            className="rounded-lg bg-blue-50 p-2 text-blue-600 transition hover:bg-blue-100"
                            title="Email applicant"
                          >
                            <Mail className="h-4 w-4" />
                          </a>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredSubmissions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-12 text-center">
                        <div className="flex flex-col items-center gap-3">
                          <div className="rounded-full bg-slate-100 p-4">
                            <Search className="h-8 w-8 text-slate-400" />
                          </div>
                          <p className="text-sm font-semibold text-slate-500">No submissions found</p>
                          <p className="text-sm text-slate-400">Try adjusting your search or check back later</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t-2 border-slate-200 bg-slate-50 px-5 py-3">
              <p className="text-sm text-slate-600">
                Showing <span className="font-bold text-slate-900">{filteredSubmissions.length}</span> of{' '}
                <span className="font-bold text-slate-900">{submissions.length}</span> submissions
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
