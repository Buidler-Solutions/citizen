export default function CountriesPage() {
  return (
    <section className="space-y-5">
      <div className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-slate-100 p-4">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
              <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2.5 2.5 0 002.5-2.5V3.935a3 3 0 00-5.5 0zM12 15v6m3-6v6m3-6v6m-9 6h18" />
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">Country Management</h3>
            <p className="mt-1 text-sm text-slate-600">Review country-level adoption and compliance status for Citizen rollout pipeline.</p>
          </div>
          <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8">
            <div className="flex flex-col items-center gap-2">
              <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-slate-500">Country management coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
