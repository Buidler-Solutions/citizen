'use client';

import { CSSProperties, ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { AsciinemaModal } from '@/components/AsciinemaModal';
import { ensureGsap } from '@/lib/gsapLoader';

type RoleId = string;
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
  eyebrow: string;
  title: string;
  body: string;
}

interface RoleOption {
  id: string;
  label: string;
  prompt: string;
  thankYouNote: string;
  weight?: number;
}

interface PublicFormSettings {
  title: string;
  subtitle: string;
  attachmentMode: 'optional' | 'required';
  roles: RoleOption[];
  campaignCards: CampaignCard[];
}

interface SignedSubmissionContract {
  submitModel: 'frontend_signed_backend_relay';
  relayMode: 'database_only' | 'database_plus_network_relay' | 'invalid_relay_configuration';
  consent: {
    backendPersistence: string;
    networkRelay: string;
  };
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
const ASCIINEMA_SHORTCODE_PATTERN = /\[asciinema:([a-zA-Z0-9_-]+)(?:\|([^\]]+))?\]/g;
const HASH_FORMAT = /^sha256:[a-f0-9]{64}$/i;

type WalletProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type CitizenPayloadSignature = {
  requestId?: string;
  signer?: string;
  verifyingKey?: string;
  signature?: string;
  payloadHash?: string;
  signingPayload?: string;
  algorithm?: string;
  signatureScope?: 'payload_hash_v1' | 'canonical_payload_v1';
};

type WalletEncryptionReader = {
  readerDid?: string;
  publicKeyHex?: string;
};

type SignedSubmissionEnvelope = {
  walletRequestId: string;
  payload: {
    fullName: string;
    institution: string;
    email: string;
    country: string;
    role: string;
    missionNeed: string;
    attachmentName?: string;
    attachmentMimeType?: string;
    attachmentSha256?: string;
    attachmentBase64?: string;
  };
  walletSignerDid: string;
  walletVerifyingKey: string;
  walletSignature: string;
  walletPayloadHash: string;
  walletSigningPayload: string;
  walletAlgorithm: string;
  walletSignatureScope: 'payload_hash_v1' | 'canonical_payload_v1';
  walletReaderDid?: string;
  walletReaderX25519PublicKey?: string;
};

type SubmissionCreateResponse = {
  walletPayloadHash?: string;
};

const normalizeShortcodeToken = (token: string): string => token
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/^-+|-+$/g, '');

const toAbsoluteUrl = (url: string) => {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${API_URL}${url}`;
  return `${API_URL}/${url}`;
};

const extractShortcodeToken = (value: string): string | null => {
  const match = ASCIINEMA_SHORTCODE_PATTERN.exec(value);
  ASCIINEMA_SHORTCODE_PATTERN.lastIndex = 0;

  if (!match) {
    return null;
  }

  const normalizedToken = normalizeShortcodeToken(match[1]);
  return normalizedToken || null;
};

const extractShortcodeLabel = (value: string): string | null => {
  const match = ASCIINEMA_SHORTCODE_PATTERN.exec(value);
  ASCIINEMA_SHORTCODE_PATTERN.lastIndex = 0;

  if (!match) {
    return null;
  }

  const label = match[2]?.trim();
  return label || null;
};

const renderInlineShortcodeText = (
  value: string,
  hasRecording: boolean,
  onOpenRecording: () => void,
  defaultLinkLabel: string,
) => {
  ASCIINEMA_SHORTCODE_PATTERN.lastIndex = 0;
  const segments = value.split(ASCIINEMA_SHORTCODE_PATTERN);

  if (segments.length === 1) {
    return value;
  }

  const parts: Array<string | ReactNode> = [];

  for (let index = 0; index < segments.length; index += 3) {
    const textSegment = segments[index];
    const shortcodeLabel = segments[index + 2]?.trim();

    if (textSegment) {
      parts.push(textSegment);
    }

    if (index + 1 >= segments.length || !hasRecording) {
      continue;
    }

    parts.push(
      <a
        key={`asciinema-link-${index}`}
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onOpenRecording();
        }}
        className="mx-1 inline-flex items-center rounded-md border border-cyan-400/60 bg-cyan-500/10 px-2 py-0.5 align-middle text-[0.8em] font-semibold text-cyan-200 no-underline transition-colors hover:border-cyan-300 hover:bg-cyan-400/20 hover:text-cyan-100"
      >
        ▶ {shortcodeLabel || defaultLinkLabel}
      </a>,
    );
  }

  return parts;
};

const DEFAULT_CAMPAIGN_CARDS: CampaignCard[] = [
  {
    weight: 1,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'Citizen Protocol in one line',
    body: 'A governance-first blockchain for public truth, accountability, and tamper-evident civic records.',
  },
  {
    weight: 2,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'Why this project exists',
    body: 'Critical public records are fragmented and hard to trust. Citizen Protocol creates one auditable source of truth for civic systems.',
  },
  {
    weight: 3,
    eyebrow: 'citizen-protocol-v0.1.0',
    title: 'What we are solving',
    body: 'We reduce record fraud, strengthen governance transparency, and improve institutional trust across agencies.',
  },
];

const DEFAULT_ROLES: RoleOption[] = [
  {
    id: 'validator',
    label: 'Validator',
    prompt: 'I want to stress test the system as a Validator focused on...',
    thankYouNote: 'Thank you for applying to run a Citizen Validator node. We have added you to the validator waitlist. Our team will review your submission and send onboarding updates, eligibility checks, and timeline details to your email.',
    weight: 1,
  },
  {
    id: 'builder',
    label: 'Builder',
    prompt: 'I want to build civic applications as a Builder for...',
    thankYouNote: 'Thank you for joining as a Builder. You are now on our builder waitlist. We will share product updates, API access details, and onboarding milestones by email as new slots open.',
    weight: 2,
  },
  {
    id: 'observer',
    label: 'Observer',
    prompt: 'I want to run audits as an Observer to improve...',
    thankYouNote: 'Thank you for registering as an Observer. We have added you to the observer waitlist. You will receive updates by email about review status, audit participation windows, and next steps.',
    weight: 3,
  },
];

const DEFAULT_SETTINGS: PublicFormSettings = {
  title: 'Build Public Truth with Citizen',
  subtitle: 'Validator · Builder · Observer onboarding',
  attachmentMode: 'optional',
  roles: DEFAULT_ROLES,
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
    <h2 className="font-display m-0 flex items-center justify-start gap-3 text-[clamp(1.8rem,4.8vw,3.7rem)] font-extrabold leading-[1.1] tracking-tight" aria-live="polite" aria-atomic="true">
      <span className="text-left text-slate-100">{baseWord}</span>{' '}
      <span className="min-w-[calc(var(--longest-word)*1ch)] text-left" style={{ '--longest-word': longestWordLength } as CSSProperties}>
        <span key={rotatingWords[wordIndex]} className="font-display inline-block whitespace-nowrap font-bold text-cyan-300 [animation:onboardingWordSwap_520ms_cubic-bezier(0.22,0.61,0.36,1)] motion-reduce:animate-none">
          {rotatingWords[wordIndex]}
        </span>
      </span>
    </h2>
  );
}

export function InterestForm() {
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [roleId, setRoleId] = useState<RoleId | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [motionDirection, setMotionDirection] = useState<MotionDirection>('forward');
  const [settings, setSettings] = useState<PublicFormSettings>(DEFAULT_SETTINGS);
  const [showOnboardingIntro, setShowOnboardingIntro] = useState(true);
  const [showIntro, setShowIntro] = useState(true);
  const [introIndex, setIntroIndex] = useState(0);
  const [formValues, setFormValues] = useState<Record<string, string>>({
    fullName: '', institution: '', email: '', country: '', missionNeed: '',
  });
  const [attachment, setAttachment] = useState<{ name: string; mimeType: string; sha256: string; base64: string } | null>(null);
  const [submittedThankYouNote, setSubmittedThankYouNote] = useState('');
  const [submittedRole, setSubmittedRole] = useState<string | null>(null);
  const [isAsciinemaOpen, setIsAsciinemaOpen] = useState(false);
  const [signedSubmission, setSignedSubmission] = useState<SignedSubmissionEnvelope | null>(null);
  const [submissionReceiptHash, setSubmissionReceiptHash] = useState<string | null>(null);
  const [shortcodeMap, setShortcodeMap] = useState<Record<string, string>>({});
  const [signedSubmissionContract, setSignedSubmissionContract] = useState<SignedSubmissionContract | null>(null);
  const stageContainerRef = useRef<HTMLElement | null>(null);
  const stageContentRef = useRef<HTMLElement | null>(null);
  const setStageContainerRef = (node: HTMLElement | null) => {
    stageContainerRef.current = node;
  };
  const setStageContentRef = (node: HTMLElement | null) => {
    stageContentRef.current = node;
  };

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
        setSettings((prev) => ({
          title: data.title ?? prev.title,
          subtitle: data.subtitle ?? prev.subtitle,
          attachmentMode: data.attachmentMode === 'required' ? 'required' : 'optional',
          campaignCards: Array.isArray(data.campaignCards)
            ? data.campaignCards.map((card, index) => ({
              weight: card.weight ?? index + 1,
              eyebrow: card.eyebrow?.trim() || 'citizen-protocol-v0.1.0',
              title: card.title ?? '',
              body: card.body ?? '',
            }))
            : prev.campaignCards,
          roles: Array.isArray(data.roles) && data.roles.length > 0 ? data.roles : prev.roles,
        }));
      } catch {
        // Keep defaults if settings endpoint is unavailable
      }
    };
    loadSettings();
  }, []);


  useEffect(() => {
    const loadAsciinemaRecordings = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/asciinema-recordings/public`);
        if (!response.ok) return;

        const recordings = (await response.json()) as Record<string, string>;
        const normalizedMap = Object.entries(recordings).reduce<Record<string, string>>((accumulator, [shortcode, castUrl]) => {
          const normalizedShortcode = normalizeShortcodeToken(shortcode);
          if (!normalizedShortcode || !castUrl?.trim()) {
            return accumulator;
          }

          accumulator[normalizedShortcode] = toAbsoluteUrl(castUrl);
          return accumulator;
        }, {});

        setShortcodeMap(normalizedMap);
      } catch {
        // Keep empty recording map if endpoint is unavailable
      }
    };

    void loadAsciinemaRecordings();
  }, []);

  useEffect(() => {
    const loadSignedSubmissionContract = async () => {
      try {
        const response = await fetch(`${API_URL}/interest/signed-submission-contract`);
        if (!response.ok) return;
        const contract = (await response.json()) as SignedSubmissionContract;
        setSignedSubmissionContract(contract);
      } catch {
        // Keep defaults if contract endpoint is unavailable
      }
    };

    void loadSignedSubmissionContract();
  }, []);

  const introSlides = useMemo(() => settings.campaignCards
    .filter((card) => card.eyebrow.trim() && card.title.trim() && card.body.trim())
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


  const activeIntroCard = introSlides[introIndex];
  const activeIntroShortcode = useMemo(() => {
    const shortcodeFromBody = extractShortcodeToken(activeIntroCard?.body ?? '');
    const shortcodeFromTitle = extractShortcodeToken(activeIntroCard?.title ?? '');
    return shortcodeFromBody ?? shortcodeFromTitle;
  }, [activeIntroCard]);

  const resolvedIntroRecording = activeIntroShortcode ? shortcodeMap[activeIntroShortcode] : '';
  const activeIntroLabel = useMemo(() => {
    const labelFromBody = extractShortcodeLabel(activeIntroCard?.body ?? '');
    const labelFromTitle = extractShortcodeLabel(activeIntroCard?.title ?? '');
    return labelFromBody ?? labelFromTitle ?? 'Watch terminal';
  }, [activeIntroCard]);

  const availableRoles = useMemo(() => {
    if (settings.roles.length > 0) {
      return [...settings.roles]
        .sort((a, b) => (a.weight ?? Number.MAX_SAFE_INTEGER) - (b.weight ?? Number.MAX_SAFE_INTEGER));
    }

    return DEFAULT_ROLES;
  }, [settings.roles]);

  const selectedRoleOption = availableRoles.find((option) => option.id === roleId) ?? null;

  const steps = useMemo<StepConfig[]>(() => {
    if (!selectedRoleOption) return BASE_STEPS;

    return [...BASE_STEPS, {
      name: 'missionNeed',
      label: selectedRoleOption.prompt,
      placeholder: 'Describe your mission, scope, and outcomes you want to achieve.',
      minLength: 5,
    }];
  }, [selectedRoleOption]);

  const totalSteps = steps.length + 1;
  const currentStep = stepIndex === 0 ? null : steps[stepIndex - 1];
  const value = currentStep ? formValues[currentStep.name] ?? '' : '';

  const validateStep = () => {
    if (stepIndex === 0) {
      if (!roleId) {
        setStatus('Please choose a role to continue.');
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

  const buildPayload = () => ({
    fullName: formValues.fullName.trim(),
    institution: formValues.institution.trim(),
    email: formValues.email.trim(),
    country: formValues.country.trim(),
    role: roleId ?? '',
    missionNeed: formValues.missionNeed.trim(),
    ...(attachment ? {
      attachmentName: attachment.name,
      attachmentMimeType: attachment.mimeType,
      attachmentSha256: attachment.sha256,
      attachmentBase64: attachment.base64,
    } : {}),
  });

  const signSubmission = async (): Promise<SignedSubmissionEnvelope | null> => {
    if (!roleId) {
      setStatus('Please choose a role to continue.');
      return null;
    }

    const payload = buildPayload();
    if (settings.attachmentMode === 'required' && !payload.attachmentBase64) {
      setStatus('Please attach a file before signing this submission.');
      return null;
    }

    const protocolSigningPayload = {
      schema_version: '1.0.0',
      namespace: 'onboarding.interest',
      action: 'SUBMIT_ONBOARDING_INTEREST',
      object_id: payload.email.toLowerCase(),
      payload,
      submitted_at: new Date().toISOString(),
    };

    try {
      setLoading(true);
      setStatus('Waiting for wallet signature approval...');
      const providerCandidate = window as typeof window & { citizen?: WalletProvider; ctzn?: WalletProvider };
      const provider = providerCandidate.citizen ?? providerCandidate.ctzn;
      if (!provider || typeof provider.request !== 'function') {
        setStatus('Citizen wallet extension not detected. Install/unlock wallet to submit securely.');
        return null;
      }

      const signResult = await provider.request({
        method: 'ctzn_signCitizenTx',
        params: [protocolSigningPayload],
      }) as CitizenPayloadSignature;

      const walletReaderResult = await provider.request({
        method: 'ctzn_getEncryptionPublicKey',
      }).catch(() => null) as WalletEncryptionReader | null;

      if (
        !signResult
        || typeof signResult.requestId !== 'string'
        || typeof signResult.signer !== 'string'
        || typeof signResult.verifyingKey !== 'string'
        || typeof signResult.signature !== 'string'
        || typeof signResult.signingPayload !== 'string'
        || typeof signResult.payloadHash !== 'string'
        || !HASH_FORMAT.test(signResult.payloadHash)
      ) {
        setStatus('Wallet signing response was invalid. Please retry and approve the signature request.');
        return null;
      }
      if (signResult.algorithm && signResult.algorithm.toLowerCase() !== 'ed25519') {
        setStatus('Wallet signer must use Ed25519 for onboarding payload signatures.');
        return null;
      }

      const signedEnvelope: SignedSubmissionEnvelope = {
        walletRequestId: signResult.requestId,
        payload,
        walletSignerDid: signResult.signer,
        walletVerifyingKey: signResult.verifyingKey,
        walletSignature: signResult.signature,
        walletPayloadHash: signResult.payloadHash,
        walletSigningPayload: signResult.signingPayload,
        walletAlgorithm: signResult.algorithm ?? 'ed25519',
        walletSignatureScope: signResult.signatureScope === 'canonical_payload_v1' ? 'canonical_payload_v1' : 'payload_hash_v1',
        walletReaderDid: walletReaderResult?.readerDid,
        walletReaderX25519PublicKey: walletReaderResult?.publicKeyHex,
      };

      setSignedSubmission(signedEnvelope);
      setStatus('Submission signed. Review and click "Submit signed form" to continue.');
      return signedEnvelope;
    } catch {
      setStatus('Wallet signing failed. Please retry and approve signature in extension.');
      return null;
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (!roleId) {
      setStatus('Please choose a role to continue.');
      return;
    }

    const latestPayload = buildPayload();
    const envelopeToSubmit = signedSubmission;
    if (!envelopeToSubmit) {
      setStatus('Please sign the submission before sending it to the backend relay.');
      return;
    }

    const payloadChangedSinceSign = JSON.stringify(latestPayload) !== JSON.stringify(envelopeToSubmit.payload);
    if (payloadChangedSinceSign) {
      setSignedSubmission(null);
      setStatus('Form changed after signing. Please sign again before submitting.');
      return;
    }

    try {
      setLoading(true);
      const response = await fetch(`${API_URL}/interest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...envelopeToSubmit.payload,
          walletSignerDid: envelopeToSubmit.walletSignerDid,
          walletVerifyingKey: envelopeToSubmit.walletVerifyingKey,
          walletSignature: envelopeToSubmit.walletSignature,
          walletPayloadHash: envelopeToSubmit.walletPayloadHash,
          walletSigningPayload: envelopeToSubmit.walletSigningPayload,
          walletAlgorithm: envelopeToSubmit.walletAlgorithm,
          walletSignatureScope: envelopeToSubmit.walletSignatureScope,
          walletReaderDid: envelopeToSubmit.walletReaderDid,
          walletReaderX25519PublicKey: envelopeToSubmit.walletReaderX25519PublicKey,
          attachmentName: envelopeToSubmit.payload.attachmentName,
          attachmentMimeType: envelopeToSubmit.payload.attachmentMimeType,
          attachmentSha256: envelopeToSubmit.payload.attachmentSha256,
          attachmentBase64: envelopeToSubmit.payload.attachmentBase64,
        }),
      });
      if (!response.ok) {
        if (response.status === 413) {
          setStatus('Attachment payload is too large for current backend limits. Use a smaller file or increase backend MAX_REQUEST_BODY_SIZE.');
          return;
        }
        if (response.status === 409) {
          setStatus('This email already submitted the form. Please use a different email.');
          return;
        }
        if (response.status === 400) {
          const details = await response.json().catch(() => null) as { message?: string | string[] } | null;
          const message = Array.isArray(details?.message) ? details?.message.join(', ') : details?.message;
          setStatus(message || 'Submission rejected due to invalid signed payload.');
          return;
        }
        throw new Error('Submission failed');
      }
      const submitted = await response.json().catch(() => null) as SubmissionCreateResponse | null;
      const receiptHash = submitted?.walletPayloadHash ?? envelopeToSubmit.walletPayloadHash;
      let walletConfirmationSynced = false;
      const providerCandidate = window as typeof window & { citizen?: WalletProvider; ctzn?: WalletProvider };
      const provider = providerCandidate.citizen ?? providerCandidate.ctzn;
      if (provider && typeof provider.request === 'function') {
        try {
          await provider.request({
            method: 'ctzn_confirmCitizenTxSubmission',
            params: [{
              requestId: envelopeToSubmit.walletRequestId,
              receiptHash,
            }],
          });
          walletConfirmationSynced = true;
        } catch {
          walletConfirmationSynced = false;
        }
      }

      const selectedRole = selectedRoleOption?.label ?? roleId;
      const thankYouMessage = selectedRoleOption?.thankYouNote ?? '';

      setSubmittedThankYouNote(thankYouMessage);
      setSubmittedRole(selectedRole);
      setSubmissionReceiptHash(receiptHash);
      setStatus(
        walletConfirmationSynced
          ? ''
          : 'Submission saved, but wallet activity sync did not complete. Keep the extension open and retry.',
      );
      setRoleId(null);
      setSignedSubmission(null);
      setAttachment(null);
      setStepIndex(0);
      setMotionDirection('forward');
      setFormValues({ fullName: '', institution: '', email: '', country: '', missionNeed: '' });
    } catch {
      setStatus('Unable to submit at the moment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const onboardingRoleLabels = availableRoles.map((option) => option.label);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stepIndex < totalSteps - 1) return nextStep();
    if (!validateStep()) return;
    if (signedSubmission) {
      await submit();
      return;
    }
    await signSubmission();
  };

  const onAttachmentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      setAttachment(null);
      setSignedSubmission(null);
      return;
    }
    if (file.size > 150 * 1024) {
      setStatus('Attachment must be 150KB or smaller for wallet-signed simulation flow.');
      event.target.value = '';
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashHex = Array.from(new Uint8Array(hashBuffer)).map((value) => value.toString(16).padStart(2, '0')).join('');
    let binary = '';
    bytes.forEach((value) => {
      binary += String.fromCharCode(value);
    });
    const base64 = btoa(binary);
    setAttachment({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      sha256: `sha256:${hashHex}`,
      base64,
    });
    setSignedSubmission(null);
    setStatus('');
  };


  const primaryButtonClass = 'w-full cursor-pointer rounded-xl bg-white/10 backdrop-blur-md border border-white/20 p-4 font-bold text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-white/20 hover:shadow-[0_8px_30px_rgba(255,255,255,0.15)] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none';


  useEffect(() => {
    if (!stageContainerRef.current || !stageContentRef.current) return undefined;

    let cleanup = () => {};
    let isCancelled = false;

    void ensureGsap()
      .then(() => {
        if (isCancelled || !window.gsap || !stageContainerRef.current || !stageContentRef.current) return;

        const travelY = motionDirection === 'forward' ? 34 : -34;
        const context = window.gsap.context(() => {
          window.gsap?.fromTo(stageContainerRef.current,
            { autoAlpha: 0, y: travelY, filter: 'blur(8px)' },
            {
              autoAlpha: 1,
              y: 0,
              filter: 'blur(0px)',
              duration: 0.55,
              ease: 'power3.out',
            });

          window.gsap?.fromTo(stageContentRef.current?.querySelectorAll('[data-stage-item]') ?? [],
            { autoAlpha: 0, y: 18 },
            {
              autoAlpha: 1,
              y: 0,
              duration: 0.5,
              ease: 'power2.out',
              stagger: 0.05,
              delay: 0.08,
            });
        }, stageContainerRef.current);

        cleanup = () => context.revert();
      })
      .catch(() => {
        // Fall back to static rendering when GSAP cannot be loaded.
      });

    return () => {
      isCancelled = true;
      cleanup();
    };
  }, [motionDirection, stepIndex, introIndex, showOnboardingIntro, showIntro]);

  if (submittedThankYouNote) {
    return (
      <section className="onboarding-typography grid min-h-[calc(100vh-180px)] place-content-center gap-6 bg-slate-950/0 p-[clamp(1.2rem,4vw,3.2rem)] text-left" aria-live="polite">
        <p className="m-0 text-cyan-300">Submission received</p>
        <h2 className="font-display m-0 text-[clamp(2rem,3.4vw,3.4rem)] leading-[1.15]">Thank you for interest on Testnet as {submittedRole ?? 'a participant'}.</h2>
        <p className="m-0 mx-auto text-[clamp(1.12rem,2.2vw,1.5rem)] leading-[1.7] text-blue-100">{submittedThankYouNote}</p>
        {submissionReceiptHash ? (
          <p className="m-0 text-sm text-cyan-200">
            Commitment receipt hash: <code>{submissionReceiptHash}</code>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form className="onboarding-typography grid min-h-[calc(100vh-160px)] content-center bg-slate-950/0 p-[clamp(1.2rem,4vw,3.2rem)] max-[680px]:min-h-[calc(100vh-140px)]" onSubmit={onSubmit}>
      {showOnboardingIntro ? (
        <section ref={setStageContainerRef} className="grid min-h-[260px] content-center justify-items-start text-left mt-8" aria-label="Onboarding introduction">
          <div ref={setStageContentRef} className="contents">
          <p data-stage-item className="font-display mb-4 text-[clamp(1rem,1.5vw,1.25rem)] font-semibold tracking-[0.14em] text-cyan-300 mt-4">{activeIntroCard?.eyebrow ?? 'citizen-protocol-v0.1.0'}</p>
          <RotatingOnboardingText baseWord="Onboarding" rotatingWords={onboardingRoleLabels} />
          <p className="font-onboarding-lead text-[clamp(1.2rem,2.3vw,1.8rem)] font-light leading-[1.15] text-slate-200 mt-1 mb-4 ">
            Citizen Protocol is opening its initial waitlist for individuals committed to contributing to a governance-focused blockchain infrastructure.
          </p>
          <p className="font-onboarding-lead text-[clamp(1.2rem,2.3vw,1.8rem)] font-light leading-[1.15] text-slate-200">
            Participants are expected to engage with the protocol not only as users, but as stewards of its integrity and evolution.
          </p>
          <p className="font-onboarding-lead m-0 text-[clamp(1.2rem,2.3vw,1.8rem)] font-light leading-[1.15] text-slate-200 mt-4 mb-6">
            Prior to onboarding, it is essential to review and understand the project&rsquo;s vision, system architecture, and operational objectives. Informed participation is fundamental to maintaining transparency, resilience, and institutional-grade trust within the network.
          </p>
          <div data-stage-item className="grid grid-cols-[minmax(180px,280px)] justify-self-center gap-3 mb-6">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setShowOnboardingIntro(false);
                setMotionDirection('forward');
              }}
            >
              → Start
            </button>
          </div>
          </div>
        </section>
      ) : showIntro && introSlides.length > 0 ? (
        <>
          <div className="mt-8 mb-0 flex flex-wrap items-center justify-between gap-3 text-cyan-300">
            <p className="font-display m-0 text-[clamp(1rem,1.5vw,1.25rem)] font-semibold tracking-[0.14em] text-cyan-300">{activeIntroCard?.eyebrow ?? 'citizen-protocol-v0.1.0'}</p>
            <div className="px-4 py-2 text-center text-cyan-300">
              <p className="m-0 text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">Info card</p>
              <div className="mt-1 flex items-baseline justify-end gap-2">
                <p className="font-display m-0 text-[clamp(1.4rem,2vw,2rem)] font-bold leading-none text-cyan-200">{introIndex + 1}</p>
                <p className="m-0 text-xs tracking-[0.16em] text-cyan-300/70">of {introSlides.length}</p>
              </div>
            </div>
          </div>
          <div key={`intro-${introIndex}`} ref={setStageContainerRef} className="will-change-[transform,opacity,filter]">
            <section ref={setStageContentRef} className="grid content-center">
              <h2 data-stage-item className="font-display mb-4 text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]">
                {renderInlineShortcodeText(introSlides[introIndex].title, Boolean(resolvedIntroRecording), () => setIsAsciinemaOpen(true), activeIntroLabel)}
              </h2>
              <p data-stage-item className="font-onboarding-lead mb-8 text-[clamp(1.2rem,2.3vw,1.8rem)] font-light leading-[1.15] text-slate-200">
                {renderInlineShortcodeText(introSlides[introIndex].body, Boolean(resolvedIntroRecording), () => setIsAsciinemaOpen(true), activeIntroLabel)}
              </p>
            </section>
          </div>

          <div data-stage-item className="grid gap-3 [grid-template-columns:1fr_1fr] max-[680px]:grid-cols-1">
            <button
              type="button"
              className={primaryButtonClass}
              onClick={() => {
                setMotionDirection('backward');
                setIntroIndex((prev) => Math.max(prev - 1, 0));
              }}
              disabled={introIndex === 0}
            >
              ← Previous card
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
              {introIndex === introSlides.length - 1 ? 'Start form' : 'Next card →'}
            </button>
          </div>
          <p
            className="w-full pt-2 text-center font-semibold text-cyan-300"
            aria-live="polite"
          >
            Skip info-cards and fill form (Esc). Use ← / → to move between cards.
          </p>
        </>
      ) : (
        <>
          <p data-stage-item className="mt-8 text-cyan-300">Step {stepIndex + 1} of {totalSteps}</p>

          <div key={`step-${stepIndex}`} ref={setStageContainerRef} className="will-change-[transform,opacity,filter]">
            {stepIndex === 0 ? (
              <section ref={setStageContentRef} data-stage-item className="grid gap-4">
                <h2 className="font-display text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]">I want to participate as a...</h2>
                <div className="mb-8 grid gap-3">
                  {availableRoles.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`font-display w-full rounded-xl border bg-blue-950/90 p-4 text-left text-[1.05rem] ${roleId === option.id ? 'border-cyan-300 shadow-[0_0_0_1px_rgba(85,214,255,0.35)]' : 'border-blue-200/30'}`}
                      onClick={() => {
                        setRoleId(option.id);
                        setSignedSubmission(null);
                        setStatus('');
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            ) : currentStep ? (
              <section ref={setStageContentRef} data-stage-item className="grid gap-4">
                <label className="font-display m-0 text-[clamp(1.6rem,3.5vw,2.8rem)] font-bold leading-[1.2]" htmlFor={currentStep.name}>{currentStep.label}</label>
                <input
                  className="mb-6 w-full rounded-xl border border-blue-200/30 bg-blue-950/90 p-4 text-[clamp(1.05rem,2.2vw,1.35rem)] text-slate-100"
                  id={currentStep.name}
                  type={currentStep.type ?? 'text'}
                  value={value}
                  placeholder={currentStep.placeholder}
                  onChange={(event) => {
                    setFormValues((prev) => ({ ...prev, [currentStep.name]: event.target.value }));
                    setSignedSubmission(null);
                    setStatus('');
                  }}
                  required
                  minLength={currentStep.minLength}
                  autoFocus
                />
              </section>
            ) : null}
          </div>

          <div data-stage-item className="grid gap-3 [grid-template-columns:1fr_1fr] max-[680px]:grid-cols-1">
            <button className={primaryButtonClass} type="button" onClick={previousStep} disabled={stepIndex === 0 || loading}>Back</button>
            <button className={primaryButtonClass} type="submit" disabled={loading}>
              {loading
                ? 'Processing...'
                : stepIndex === totalSteps - 1
                  ? (signedSubmission ? 'Submit signed form' : 'Sign submission')
                  : 'Continue'}
            </button>
          </div>
          {stepIndex === totalSteps - 1 ? (
            <div data-stage-item className="rounded-xl border border-cyan-300/40 bg-cyan-500/10 p-4 text-sm text-cyan-100">
              <p className="m-0 mb-2 font-semibold">Attachment option ({settings.attachmentMode})</p>
              <input
                type="file"
                className="mb-2 block w-full cursor-pointer rounded-lg border border-cyan-200/30 bg-slate-900/40 p-2 text-xs text-cyan-100"
                onChange={onAttachmentChange}
                required={settings.attachmentMode === 'required'}
              />
              {attachment ? (
                <p className="mb-2 mt-0 text-xs text-cyan-200">
                  Attached: {attachment.name} · {attachment.mimeType} · {attachment.sha256}
                </p>
              ) : null}
              <p className="m-0 font-semibold">Submission consent</p>
              <p className="mb-2 mt-1">
                {signedSubmissionContract?.consent.backendPersistence
                  ?? 'The onboarding payload and wallet signature metadata are persisted by the onboarding backend.'}
              </p>
              <p className="m-0">
                {signedSubmissionContract?.consent.networkRelay
                  ?? 'Citizen relay behavior is determined by backend configuration and enforced server-side.'}
              </p>
            </div>
          ) : null}
        </>
      )}

      {status && <p className="m-0 text-cyan-300">{status}</p>}
      <AsciinemaModal
        isOpen={isAsciinemaOpen}
        recordingUrl={activeIntroShortcode ? `[asciinema:${activeIntroShortcode}]` : resolvedIntroRecording}
        modalTitle={activeIntroLabel}
        shortcodeMap={shortcodeMap}
        onClose={() => setIsAsciinemaOpen(false)}
      />
    </form>
  );
}
