'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { Button, Input, Textarea } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface CampaignCard {
  title: string;
  body: string;
}

interface FormSettingsResponse {
  campaignCards: CampaignCard[];
}

const DEFAULT_CARD: CampaignCard = {
  title: 'New campaign card',
  body: 'Explain one key value proposition of Citizen Protocol before users start filling the form.',
};

export default function CampaignCardsPage() {
  const router = useRouter();
  const [cards, setCards] = useState<CampaignCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    const loadSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/form-settings`);

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace('/admin/login');
          return;
        }

        if (!response.ok) {
          throw new Error('Unable to load campaign cards');
        }

        const data = (await response.json()) as Partial<FormSettingsResponse>;
        if (Array.isArray(data.campaignCards)) {
          setCards(data.campaignCards);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unknown error while loading campaign cards');
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, [router]);

  const updateCard = (index: number, field: keyof CampaignCard, value: string) => {
    setCards((prev) => prev.map((card, cardIndex) => (cardIndex === index ? { ...card, [field]: value } : card)));
  };

  const addCard = () => {
    setCards((prev) => [...prev, { ...DEFAULT_CARD }]);
  };

  const removeCard = (index: number) => {
    setCards((prev) => prev.filter((_, cardIndex) => cardIndex !== index));
  };

  const saveCards = async () => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY);

    if (!token) {
      router.replace('/admin/login');
      return;
    }

    try {
      setSaving(true);
      setStatus('Saving campaign cards...');

      const payload = {
        campaignCards: cards.map((card) => ({ title: card.title.trim(), body: card.body.trim() })),
      };

      const response = await fetch(`${API_URL}/interest/form-settings`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        localStorage.removeItem(ADMIN_TOKEN_KEY);
        router.replace('/admin/login');
        return;
      }

      if (!response.ok) {
        throw new Error('Unable to save campaign cards');
      }

      setStatus('Campaign cards saved successfully.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unknown error while saving campaign cards');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoaderCircle className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Campaign Cards</h2>
          <p className="text-sm text-slate-600">
            Configure the educational cards shown before users fill the landing page form.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={addCard} variant="outline" className="gap-2">
            <Plus className="h-4 w-4" /> Add card
          </Button>
          <Button onClick={saveCards} disabled={saving} isLoading={saving} className="gap-2">
            <Save className="h-4 w-4" /> Save cards
          </Button>
        </div>
      </header>

      {status && (
        <p className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold ${status.includes('success') ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'}`}>
          <Check className="h-4 w-4" /> {status}
        </p>
      )}

      {cards.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
          <p className="text-sm text-slate-500">No cards configured. Add at least one card or leave empty to skip intro.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {cards.map((card, index) => (
            <div key={`${index}-${card.title}`} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-500">Card {index + 1}</p>
                <button
                  type="button"
                  onClick={() => removeCard(index)}
                  className="inline-flex items-center gap-1 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
              <Input
                label="Title"
                value={card.title}
                onChange={(event) => updateCard(index, 'title', event.target.value)}
                placeholder="Citizen Protocol in one line"
              />
              <Textarea
                label="Description"
                value={card.body}
                onChange={(event) => updateCard(index, 'body', event.target.value)}
                rows={4}
                placeholder="Explain why this protocol matters before users continue to the form."
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
