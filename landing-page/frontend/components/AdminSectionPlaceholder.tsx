import { ReactNode } from 'react';

interface AdminSectionPlaceholderProps {
  title: string;
  description: string;
  children?: ReactNode;
}

export function AdminSectionPlaceholder({ title, description, children }: AdminSectionPlaceholderProps) {
  return (
    <section className="space-y-3">
      <h3 className="text-2xl font-bold">{title}</h3>
      <p className="max-w-3xl text-slate-600">{description}</p>
      {children ?? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-slate-500">
          This section now has its own dedicated page in the multi-page admin console.
        </div>
      )}
    </section>
  );
}
