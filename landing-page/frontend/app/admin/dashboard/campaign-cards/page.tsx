'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ChevronDown, LoaderCircle, Plus, Save, Trash2, X } from 'lucide-react';
import { Button, Input, Textarea } from '@/components/admin-ui';
import { ADMIN_TOKEN_KEY } from '@/components/admin-auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface CampaignCard {
  weight?: number;
  title: string;
  body: string;
}

interface FormSettingsResponse {
  campaignCards: CampaignCard[];
}

const DEFAULT_CARD: CampaignCard = {
  weight: 1,
  title: 'New campaign card',
  body: 'Explain one key value proposition of Citizen Protocol before users start filling the form.',
};

export default function CampaignCardsPage() {
  const router = useRouter();
  const [cards, setCards] = useState<CampaignCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newCard, setNewCard] = useState<CampaignCard>(DEFAULT_CARD);
  const [openCardIndex, setOpenCardIndex] = useState<number | null>(0);

  const normalizeWeights = (list: CampaignCard[]): CampaignCard[] => list.map((card, index) => ({ ...card, weight: index + 1 }));

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
          const sortedCards = [...data.campaignCards].sort((a, b) => (a.weight ?? Number.MAX_SAFE_INTEGER) - (b.weight ?? Number.MAX_SAFE_INTEGER));
          setCards(normalizeWeights(sortedCards));
          setOpenCardIndex(sortedCards.length > 0 ? 0 : null);
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

  const openAddModal = () => {
    setNewCard({ ...DEFAULT_CARD, weight: cards.length + 1 });
    setShowAddModal(true);
    setStatus('');
  };

  const closeAddModal = () => {
    setShowAddModal(false);
    setNewCard(DEFAULT_CARD);
  };

  const addCard = () => {
    if (!newCard.title.trim() || !newCard.body.trim()) {
      setStatus('Title and description are required to add a card.');
      return;
    }

    setCards((prev) => [...prev, {
      weight: prev.length + 1,
      title: newCard.title.trim(),
      body: newCard.body.trim(),
    }]);
    setOpenCardIndex(cards.length);
    closeAddModal();
    setStatus('Card added. Save cards to publish changes.');
  };

  const removeCard = (index: number) => {
    setCards((prev) => {
      const nextCards = normalizeWeights(prev.filter((_, cardIndex) => cardIndex !== index));

      setOpenCardIndex((current) => {
        if (current === null) return nextCards.length > 0 ? 0 : null;
        if (current === index) return nextCards.length > 0 ? Math.min(index, nextCards.length - 1) : null;
        if (current > index) return current - 1;
        return current;
      });

      return nextCards;
    });
  };

  const moveCard = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;

    setCards((prev) => {
      const reordered = [...prev];
      const [card] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, card);
      return normalizeWeights(reordered);
    });
  };

  const updateWeight = (index: number, nextWeightValue: string) => {
    const parsedWeight = Number.parseInt(nextWeightValue, 10);
    if (Number.isNaN(parsedWeight)) return;

    const boundedWeight = Math.min(cards.length, Math.max(1, parsedWeight));
    moveCard(index, boundedWeight - 1);
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
        campaignCards: cards.map((card, index) => ({
          weight: index + 1,
          title: card.title.trim(),
          body: card.body.trim(),
        })),
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

      setStatus('Info cards saved successfully.');
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
          <h2 className="text-2xl font-bold text-slate-900">Info Cards</h2>
          <p className="text-sm text-slate-600">
            Configure the educational cards shown before users fill the landing page form.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={openAddModal} variant="outline" className="gap-2">
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
            <div
              key={`${index}-${card.title}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex === null) return;
                moveCard(dragIndex, index);
                setDragIndex(null);
              }}
              onDragEnd={() => setDragIndex(null)}
              className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setOpenCardIndex((current) => (current === index ? null : index))}
                  className="flex flex-1 items-center justify-between gap-2 text-left"
                  aria-expanded={openCardIndex === index}
                >
                  <p className="text-sm font-semibold text-slate-500">Card {index + 1} · {card.title.trim() || 'Untitled card'}</p>
                  <ChevronDown className={`h-4 w-4 text-slate-500 transition ${openCardIndex === index ? 'rotate-180' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => removeCard(index)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-100"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>

              {openCardIndex === index && (
                <div className="space-y-4">
                  <Input
                    label="Weight"
                    type="number"
                    min={1}
                    max={cards.length}
                    value={String(card.weight)}
                    onChange={(event) => updateWeight(index, event.target.value)}
                    placeholder="1"
                  />
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
              )}
            </div>
          ))}
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 px-4" role="dialog" aria-modal="true" aria-label="Add campaign card">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Add Info Card</h3>
                <p className="text-sm text-slate-600">Create a new card for the landing page intro sequence.</p>
              </div>
              <button
                type="button"
                onClick={closeAddModal}
                className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close add card dialog"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-4">
              <Input
                label="Title"
                value={newCard.title}
                onChange={(event) => setNewCard((prev) => ({ ...prev, title: event.target.value }))}
                placeholder="Citizen Protocol in one line"
              />
              <Textarea
                label="Description"
                value={newCard.body}
                onChange={(event) => setNewCard((prev) => ({ ...prev, body: event.target.value }))}
                rows={4}
                placeholder="Explain one key value proposition before users continue to the form."
              />
            </div>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={closeAddModal}>Cancel</Button>
              <Button onClick={addCard} className="gap-2">
                <Plus className="h-4 w-4" /> Add card
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
