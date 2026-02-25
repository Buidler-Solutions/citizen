import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  gradient?: boolean;
}

export function Card({ children, className = '', gradient = false }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white shadow-xl ${
        gradient
          ? 'bg-gradient-to-br from-slate-50 to-white'
          : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = '' }: CardHeaderProps) {
  return <div className={`border-b border-slate-200 bg-slate-50 px-6 py-5 ${className}`}>{children}</div>;
}

interface CardTitleProps {
  children: ReactNode;
  className?: string;
}

export function CardTitle({ children, className = '' }: CardTitleProps) {
  return <h3 className={`text-lg font-bold text-slate-900 ${className}`}>{children}</h3>;
}

interface CardDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function CardDescription({ children, className = '' }: CardDescriptionProps) {
  return <p className={`mt-1 text-sm text-slate-600 ${className}`}>{children}</p>;
}

interface CardContentProps {
  children: ReactNode;
  className?: string;
}

export function CardContent({ children, className = '' }: CardContentProps) {
  return <div className={`p-6 ${className}`}>{children}</div>;
}
