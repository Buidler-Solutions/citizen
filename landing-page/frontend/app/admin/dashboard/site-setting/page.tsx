export default function SiteSettingPage() {
  return (
    <section className="space-y-5">
      <div className="overflow-hidden rounded-2xl border-2 border-slate-200 bg-gradient-to-br from-white to-slate-50 p-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-slate-100 p-4">
            <svg className="h-12 w-12 text-slate-400" fill="none" viewBox="0 0 24 24">
              <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 4.961-1.414l2.448 2.448a1.724 1.724 0 01-.065 2.505l-2.448 2.448c-.94 1.543-.826 3.31 1.414 4.961 1.095 1.095 2.472 2.49 2.505 2.505l-2.448 2.448a1.724 1.724 0 01-2.505-.065c-1.543.94-3.31.826-4.961-1.414-1.095-1.095-2.49-2.472-2.505-2.505l2.448-2.448a1.724 1.724 0 01.065-2.505l2.448-2.448c.94-1.543.826-3.31-1.414-4.961a1.724 1.724 0 01-2.505.065l-2.448 2.448c1.543-.94 3.31-.826 4.961 1.414 1.095 1.095 2.49 2.472 2.505 2.505l2.448-2.448a1.724 1.724 0 01-.065-2.505l-2.448-2.448z" />
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">Site Settings</h3>
            <p className="mt-1 text-sm text-slate-600">Configure dashboard branding and shared administration defaults for all console sections.</p>
          </div>
          <div className="rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-8">
            <div className="flex flex-col items-center gap-2">
              <svg className="h-8 w-8 text-slate-400" fill="none" viewBox="0 0 24 24">
                <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-slate-500">Site settings coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
