interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function Textarea({ label, error, className = '', ...props }: TextareaProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="mb-2 block text-sm font-bold text-slate-900">
          {label}
        </label>
      )}
      <textarea
        className={`w-full rounded-xl border-2 border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-900 transition-all duration-200 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 focus:outline-none resize-none disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? 'border-red-300 focus:border-red-500 focus:ring-red-500/10' : ''
        } ${className}`}
        {...props}
      />
      {error && (
        <p className="mt-1.5 text-sm font-medium text-red-600">{error}</p>
      )}
    </div>
  );
}
