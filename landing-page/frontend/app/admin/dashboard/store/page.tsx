export default function StorePage() {
  return (
    <section className="space-y-5">
      <div className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-slate-100 p-4">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
              <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">Store Management</h3>
            <p className="mt-1 text-sm text-slate-600">Publish and manage public assets and featured collateral for onboarding campaigns.</p>
          </div>
          <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8">
            <div className="flex flex-col items-center gap-2">
              <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-slate-500">Store management coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
