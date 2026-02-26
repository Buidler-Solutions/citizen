'use client';

import { CSSProperties, FormEvent, useEffect, useMemo, useState } from 'react';

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
  weight?: number;
  title: string;
  body: string;
}

interface PublicFormSettings {
  title: string;
  subtitle: string;
  validatorPrompt: string;
  builderPrompt: string;
  observerPrompt: string;
  validatorThankYouNote: string;
  builderThankYouNote: string;
  observerThankYouNote: string;
  campaignCards: CampaignCard[];
}

const ISO_COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ', 'BA', 'BB', 'BD',
  'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY',
  'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM',
  'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY', 'HK', 'HM', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS',
  'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB',
  'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML',
  'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NF',
  'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN',
  'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH',
  'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG',
  'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

const COUNTRY_ALIASES = ['uk', 'u.k.', 'united kingdom', 'usa', 'u.s.a.', 'u.s.', 'us'];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (email: string) => {
  const normalizedEmail = email.trim();
  if (!EMAIL_PATTERN.test(normalizedEmail)) return false;

  const [localPart, domainPart] = normalizedEmail.split('@');
  if (!localPart || !domainPart) return false;
  if (localPart.length > 64 || domainPart.length > 255) return false;
  if (domainPart.includes('..')) return false;
  return domainPart.split('.').every((section) => section.length >= 2);
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const DEFAULT_CAMPAIGN_CARDS: CampaignCard[] = [
  {
    weight: 1,
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    weight: 2,
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
    weight: 3,
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
  validatorThankYouNote: 'Thank you for applying to run a Citizen Validator node. We have added you to the validator waitlist. Our team will review your submission and send onboarding updates, eligibility checks, and timeline details to your email.',
  builderThankYouNote: 'Thank you for joining as a Builder. You are now on our builder waitlist. We will share product updates, API access details, and onboarding milestones by email as new slots open.',
  observerThankYouNote: 'Thank you for registering as an Observer. We have added you to the observer waitlist. You will receive updates by email about review status, audit participation windows, and next steps.',
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

interface RotatingOnboardingTextProps {
  baseWord: string;
  rotatingWords: string[];
  intervalMs?: number;
}

function RotatingOnboardingText({
  baseWord,
  rotatingWords,
  intervalMs = 3000,
}: RotatingOnboardingTextProps) {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    if (rotatingWords.length <= 1) return undefined;

    const intervalId = window.setInterval(() => {
      setWordIndex((currentIndex) => (currentIndex + 1) % rotatingWords.length);
    }, intervalMs);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [intervalMs, rotatingWords.length]);

  if (rotatingWords.length === 0) return null;

  const longestWordLength = Math.max(...rotatingWords.map((word) => word.length));

  return (
    <h2 className="m-0 flex items-center justify-start gap-3 text-[clamp(2rem,4.8vw,3.7rem)] font-extrabold leading-[1.1] tracking-tight" aria-live="polite" aria-atomic="true">
      <span className="text-left text-slate-100">{baseWord}</span>{' '}
      <span className="min-w-[calc(var(--longest-word)*1ch)] text-left" style={{ '--longest-word': longestWordLength } as CSSProperties}>
        <span key={rotatingWords[wordIndex]} className="inline-block whitespace-nowrap font-bold text-cyan-300 [animation:onboardingWordSwap_520ms_cubic-bezier(0.22,0.61,0.36,1)] motion-reduce:animate-none">
          {rotatingWords[wordIndex]}
        </span>
      </span>
    </h2>
  );
}

export function InterestForm() {
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [motionDirection, setMotionDirection] = useState<MotionDirection>('forward');
  const [settings, setSettings] = useState<PublicFormSettings>(DEFAULT_SETTINGS);
  const [showOnboardingIntro, setShowOnboardingIntro] = useState(true);
  const [showIntro, setShowIntro] = useState(true);
  const [introIndex, setIntroIndex] = useState(0);
  const [formValues, setFormValues] = useState<Record<string, string>>({
    fullName: '', institution: '', email: '', country: '', missionNeed: '',
  });
  const [submittedThankYouNote, setSubmittedThankYouNote] = useState('');
  const [submittedRole, setSubmittedRole] = useState<Role | null>(null);

  const validCountryNames = useMemo(() => {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const countries = new Set<string>();

    ISO_COUNTRY_CODES.forEach((countryCode) => {
      const name = displayNames.of(countryCode);
      if (name) countries.add(name.trim().toLowerCase());
      countries.add(countryCode.toLowerCase());
    });

    COUNTRY_ALIASES.forEach((alias) => countries.add(alias));
    return countries;
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

  const introSlides = useMemo(() => settings.campaignCards
    .filter((card) => card.title.trim() && card.body.trim())
    .sort((a, b) => (a.weight ?? Number.MAX_SAFE_INTEGER) - (b.weight ?? Number.MAX_SAFE_INTEGER)), [settings.campaignCards]);

  useEffect(() => {
    if (showOnboardingIntro) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!showIntro || introSlides.length === 0) return;

      if (event.key === 'Escape') {
        setShowIntro(false);
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setMotionDirection('backward');
        setIntroIndex((prev) => Math.max(prev - 1, 0));
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setMotionDirection('forward');
        if (introIndex === introSlides.length - 1) {
          setShowIntro(false);
          return;
        }
        setIntroIndex((prev) => Math.min(prev + 1, introSlides.length - 1));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [introIndex, introSlides.length, showIntro, showOnboardingIntro]);

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

    if (currentStep.name === 'email' && !isValidEmail(value)) {
      setStatus('Please provide a valid email address.');
      return false;
    }

    if (currentStep.name === 'country') {
      const countryInput = value.trim().toLowerCase();
      if (!validCountryNames.has(countryInput)) {
        setStatus('Please enter a valid country name or ISO country code.');
        return false;
      }
    }

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
      if (!response.ok) {
        if (response.status === 409) {
          setStatus('This email already submitted the form. Please use a different email.');
          return;
        }
        throw new Error('Submission failed');
      }

      const selectedRole = role;
      const thankYouMessageByRole: Record<Role, string> = {
        Validator: settings.validatorThankYouNote,
        Builder: settings.builderThankYouNote,
        Observer: settings.observerThankYouNote,
      };

      setSubmittedThankYouNote(thankYouMessageByRole[selectedRole]);
      setSubmittedRole(selectedRole);
      setStatus('');
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


  const motionClass = motionDirection === 'forward'
    ? '[animation:slideInForward_420ms_cubic-bezier(0.22,0.61,0.36,1)]'
    : '[animation:slideInBackward_420ms_cubic-bezier(0.22,0.61,0.36,1)]';
  const primaryButtonClass = 'w-full cursor-pointer rounded-xl border-0 bg-linear-to-r from-blue-500 to-cyan-400 p-4 font-bold text-white transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(31,112,255,0.35)] hover:saturate-110 disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none';

  if (submittedThankYouNote) {
    return (
      <section className="grid min-h-[calc(100vh-180px)] place-content-center gap-6 rounded-3xl border border-blue-200/35 bg-slate-950/80 p-[clamp(1.2rem,4vw,3.2rem)] text-center" aria-live="polite">
        <p className="m-0 text-cyan-300">Submission received</p>
        <h2 className="m-0 text-[clamp(2rem,4vw,3.4rem)] leading-[1.15]">Thank you for joining as {submittedRole ?? 'a participant'}.</h2>
        <p className="m-0 mx-auto max-w-[760px] text-[clamp(1.12rem,2.2vw,1.5rem)] leading-[1.7] text-blue-100">{submittedThankYouNote}</p>
      </section>
    );
  }

  return (
    <form className="grid min-h-[calc(100vh-160px)] content-center gap-5 rounded-3xl border border-blue-200/35 bg-slate-950/80 p-[clamp(1.2rem,4vw,3.2rem)] max-[680px]:min-h-[calc(100vh-140px)]" onSubmit={onSubmit}>
      {showOnboardingIntro ? (
        <section className="grid min-h-[260px] content-center justify-items-start gap-6 text-left" aria-label="Onboarding introduction">
          <p className="m-0 text-[clamp(1rem,1.5vw,1.25rem)] font-semibold text-cyan-300">citizen-protocol-v0.1.0</p>
          <RotatingOnboardingText baseWord="Onboarding" rotatingWords={['Validator', 'Builder', 'Observer']} />
          <p className="m-0 text-[clamp(1.2rem,2.3vw,1.8rem)] font-extralight tracking-[0.02em] leading-[1.35] text-slate-200">
            We are seeking individuals interested in becoming Node Validators, dApp Builders, and Node Observers through this waitlist. Before participating, we encourage you to first understand the project’s vision, architecture, and objectives so you can contribute meaningfully to its growth and integrity.
          </p>
          <div className="grid grid-cols-[minmax(180px,280px)] gap-3">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setShowOnboardingIntro(false);
                setMotionDirection('forward');
              }}
            >
              Start
            </button>
          </div>
        </section>
      ) : showIntro && introSlides.length > 0 ? (
        <>
          <p className="m-0 text-cyan-300">Info card {introIndex + 1} of {introSlides.length}</p>
          <div key={`intro-${introIndex}`} className={`will-change-[transform,opacity,filter] ${motionClass} motion-reduce:animate-none`}>
            <section className="grid min-h-[260px] content-center gap-4">
              <h2 className="m-0 text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]">{introSlides[introIndex].title}</h2>
              <p className="m-0 text-[clamp(1.35rem,2.45vw,2rem)] font-semibold leading-[1.45] text-slate-200">{introSlides[introIndex].body}</p>
            </section>
          </div>

          <div className="grid gap-3 [grid-template-columns:1fr_1fr] max-[680px]:grid-cols-1">
            <button
              type="button"
              className={primaryButtonClass}
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
              className={primaryButtonClass}
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
          <button
            type="button"
            className="w-full cursor-pointer rounded-xl border border-dashed border-cyan-300/50 bg-blue-950/80 p-4 font-semibold text-cyan-300"
            onClick={() => setShowIntro(false)}
          >
            Skip campaign cards and fill form (Esc). Use ← / → to move between cards.
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-cyan-300">Step {stepIndex + 1} of {totalSteps}</p>

          <div key={`step-${stepIndex}`} className={`will-change-[transform,opacity,filter] ${motionClass} motion-reduce:animate-none`}>
            {stepIndex === 0 ? (
              <section className="grid gap-4">
                <h2 className="m-0 text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]">I want to participate as a...</h2>
                <div className="grid gap-3">
                  {(['Validator', 'Builder', 'Observer'] as Role[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`w-full rounded-xl border bg-blue-950/90 p-4 text-left ${role === option ? 'border-cyan-300 shadow-[0_0_0_1px_rgba(85,214,255,0.35)]' : 'border-blue-200/30'}`}
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
              <section className="grid gap-4">
                <label className="m-0 text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]" htmlFor={currentStep.name}>{currentStep.label}</label>
                <input
                  className="w-full rounded-xl border border-blue-200/30 bg-blue-950/90 p-4 text-[clamp(1.05rem,2.2vw,1.35rem)] text-slate-100"
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

          <div className="grid gap-3 [grid-template-columns:1fr_1fr] max-[680px]:grid-cols-1">
            <button className={primaryButtonClass} type="button" onClick={previousStep} disabled={stepIndex === 0 || loading}>Back</button>
            <button className={primaryButtonClass} type="submit" disabled={loading}>
              {loading ? 'Submitting...' : stepIndex === totalSteps - 1 ? 'Submit' : 'Continue'}
            </button>
          </div>
        </>
      )}

      {status && <p className="m-0 text-cyan-300">{status}</p>}
    </form>
  );
}
