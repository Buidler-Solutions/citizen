export default function ReportsPage() {
  return (
    <section className="space-y-5">
      <div className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-slate-100 p-4">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
              <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">Reports & Analytics</h3>
            <p className="mt-1 text-sm text-slate-600">Monitor weekly outcomes and produce export-ready operational performance snapshots.</p>
          </div>
          <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8">
            <div className="flex flex-col items-center gap-2">
              <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-slate-500">Reports coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
