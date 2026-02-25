'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';

type Role = 'Validator' | 'Builder' | 'Observer';
type MotionDirection = 'forward' | 'backward';

interface StepConfig {
  name: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'email';
  minLength?: number;
}

interface CampaignCard {
  title: string;
  body: string;
}

interface PublicFormSettings {
  title: string;
  subtitle: string;
  validatorPrompt: string;
  builderPrompt: string;
  observerPrompt: string;
  campaignCards: CampaignCard[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const DEFAULT_CAMPAIGN_CARDS: CampaignCard[] = [
  {
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
    title: 'What we are solving',
    body: 'We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies.',
  },
];

const DEFAULT_SETTINGS: PublicFormSettings = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  validatorPrompt: 'I want to stress test the system as a Validator focused on...',
  builderPrompt: 'I want to build civic applications as a Builder for...',
  observerPrompt: 'I want to run audits as an Observer to improve...',
  campaignCards: DEFAULT_CAMPAIGN_CARDS,
};

const BASE_STEPS: StepConfig[] = [
  { name: 'fullName', label: 'What is your full name?', placeholder: 'Jane Doe', minLength: 2 },
  {
    name: 'institution',
    label: 'Which institution or organization do you represent?',
    placeholder: 'University, NGO, civic tech team, ministry, etc.',
    minLength: 2,
  },
  { name: 'email', label: 'What is your email?', placeholder: 'you@institution.org', type: 'email' },
  { name: 'country', label: 'Which country will you operate from?', placeholder: 'Country', minLength: 2 },
];

export function InterestForm() {
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [motionDirection, setMotionDirection] = useState<MotionDirection>('forward');
  const [settings, setSettings] = useState<PublicFormSettings>(DEFAULT_SETTINGS);
  const [showIntro, setShowIntro] = useState(true);
  const [introIndex, setIntroIndex] = useState(0);
  const [formValues, setFormValues] = useState<Record<string, string>>({
    fullName: '', institution: '', email: '', country: '', missionNeed: '',
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowIntro(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/form-settings`);
        if (!response.ok) return;
        const data = (await response.json()) as Partial<PublicFormSettings>;
        setSettings((prev) => {
          const merged: PublicFormSettings = { ...prev, ...data };
          if (!Array.isArray(data.campaignCards)) {
            merged.campaignCards = prev.campaignCards;
          }
          return merged;
        });
      } catch {
        // Keep defaults if settings endpoint is unavailable
      }
    };
    loadSettings();
  }, []);

  const introSlides = useMemo(
    () => settings.campaignCards.filter((card) => card.title.trim() && card.body.trim()),
    [settings.campaignCards],
  );

  useEffect(() => {
    if (introSlides.length === 0) {
      setShowIntro(false);
      return;
    }

    setIntroIndex((prev) => Math.min(prev, introSlides.length - 1));
  }, [introSlides.length]);

  const steps = useMemo<StepConfig[]>(() => {
    if (!role) return BASE_STEPS;

    const rolePrompts: Record<Role, string> = {
      Validator: settings.validatorPrompt,
      Builder: settings.builderPrompt,
      Observer: settings.observerPrompt,
    };

    return [...BASE_STEPS, {
      name: 'missionNeed',
      label: rolePrompts[role],
      placeholder: 'Describe your mission, scope, and outcomes you want to achieve.',
      minLength: 5,
    }];
  }, [role, settings.validatorPrompt, settings.builderPrompt, settings.observerPrompt]);

  const totalSteps = steps.length + 1;
  const currentStep = stepIndex === 0 ? null : steps[stepIndex - 1];
  const value = currentStep ? formValues[currentStep.name] ?? '' : '';

  const validateStep = () => {
    if (stepIndex === 0) {
      if (!role) {
        setStatus('Please choose Validator, Builder, or Observer to continue.');
        return false;
      }
      return true;
    }

    if (!currentStep) return false;
    const minLength = currentStep.minLength ?? 1;
    if (value.trim().length < minLength) {
      setStatus(`Please provide at least ${minLength} characters.`);
      return false;
    }
    return true;
  };

  const nextStep = () => {
    if (!validateStep()) return;
    setStatus('');
    setMotionDirection('forward');
    setStepIndex((prev) => Math.min(prev + 1, totalSteps - 1));
  };

  const previousStep = () => {
    setStatus('');
    setMotionDirection('backward');
    setStepIndex((prev) => Math.max(prev - 1, 0));
  };

  const submit = async () => {
    if (!role) {
      setStatus('Please choose Validator, Builder, or Observer to continue.');
      return;
    }

    const payload = {
      fullName: formValues.fullName.trim(),
      institution: formValues.institution.trim(),
      email: formValues.email.trim(),
      country: formValues.country.trim(),
      missionNeed: `[${role}] ${formValues.missionNeed.trim()}`,
    };

    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/interest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('Submission failed');

      setStatus('Thank you. Our adoption team will contact you shortly.');
      setRole(null);
      setStepIndex(0);
      setMotionDirection('forward');
      setFormValues({ fullName: '', institution: '', email: '', country: '', missionNeed: '' });
    } catch {
      setStatus('Unable to submit at the moment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stepIndex < totalSteps - 1) return nextStep();
    if (!validateStep()) return;
    await submit();
  };

  return (
    <form className="typeform-shell" onSubmit={onSubmit}>
      <header className="typeform-header">
        <p className="kicker">{settings.title}</p>
        <h1>{settings.subtitle}</h1>
      </header>

      {showIntro && introSlides.length > 0 ? (
        <>
          <p className="step-count">Info card {introIndex + 1} of {introSlides.length}</p>
          <div key={`intro-${introIndex}`} className={`typeform-step-motion ${motionDirection}`}>
            <section className="typeform-step intro-card">
              <h2>{introSlides[introIndex].title}</h2>
              <p>{introSlides[introIndex].body}</p>
            </section>
          </div>

          <div className="wizard-actions">
            <button
              type="button"
              onClick={() => {
                setMotionDirection('backward');
                setIntroIndex((prev) => Math.max(prev - 1, 0));
              }}
              disabled={introIndex === 0}
            >
              Previous card
            </button>
            <button
              type="button"
              onClick={() => {
                setMotionDirection('forward');
                if (introIndex === introSlides.length - 1) {
                  setShowIntro(false);
                  return;
                }
                setIntroIndex((prev) => Math.min(prev + 1, introSlides.length - 1));
              }}
            >
              {introIndex === introSlides.length - 1 ? 'Start form' : 'Next card'}
            </button>
          </div>
          <button type="button" className="escape-shortcut" onClick={() => setShowIntro(false)}>
            Skip campaign cards and fill form (Esc)
          </button>
        </>
      ) : (
        <>
          <p className="step-count">Step {stepIndex + 1} of {totalSteps}</p>

          <div key={`step-${stepIndex}`} className={`typeform-step-motion ${motionDirection}`}>
            {stepIndex === 0 ? (
              <section className="typeform-step">
                <h2>I want to participate as a...</h2>
                <div className="role-options-inline">
                  {(['Validator', 'Builder', 'Observer'] as Role[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={role === option ? 'role-option active' : 'role-option'}
                      onClick={() => {
                        setRole(option);
                        setStatus('');
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </section>
            ) : currentStep ? (
              <section className="typeform-step">
                <label htmlFor={currentStep.name}>{currentStep.label}</label>
                <input
                  id={currentStep.name}
                  type={currentStep.type ?? 'text'}
                  value={value}
                  placeholder={currentStep.placeholder}
                  onChange={(event) => {
                    setFormValues((prev) => ({ ...prev, [currentStep.name]: event.target.value }));
                    setStatus('');
                  }}
                  required
                  minLength={currentStep.minLength}
                  autoFocus
                />
              </section>
            ) : null}
          </div>

          <div className="wizard-actions">
            <button type="button" onClick={previousStep} disabled={stepIndex === 0 || loading}>Back</button>
            <button type="submit" disabled={loading}>
              {loading ? 'Submitting...' : stepIndex === totalSteps - 1 ? 'Submit' : 'Continue'}
            </button>
          </div>
        </>
      )}

      {status && <p className="status">{status}</p>}
    </form>
  );
}
