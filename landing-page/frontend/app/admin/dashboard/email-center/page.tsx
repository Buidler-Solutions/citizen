"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckSquare, Mail, Send, Settings2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { ADMIN_TOKEN_KEY } from "@/components/admin-auth";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
} from "@/components/admin-ui";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type AudienceMode = "all" | "role" | "selected";

interface SmtpSettingsResponse {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  replyTo: string;
  defaultBcc: string;
  rejectUnauthorized: boolean;
  resolvedSource?: string;
  transportStatus?: {
    configured: boolean;
    strict: boolean;
    nodemailerInstalled: boolean;
    source: "database" | "environment" | "default";
    mode: "smtp" | "logged";
    issues: string[];
  };
}

interface TemplateListItem {
  type: string;
  subject: string;
  html: string;
  placeholders: string[];
}

interface TemplateDetails extends TemplateListItem {
  source: "default" | "database";
}

interface AudienceRecipient {
  id: string;
  email: string;
  fullName: string;
  institution: string;
  role: string;
}

interface UpdateExecutionPlan {
  mode: "synchronous-inline";
  recommendedMode: "synchronous-inline" | "queued-worker";
  maxRecipientsPerRequest: number;
  queueRecommendedThreshold: number;
  queueRecommended: boolean;
  audienceCount: number;
  warning: string | null;
}

interface NotificationHistoryItem {
  id: string;
  leadId: string | null;
  templateType: string;
  recipientEmail: string;
  recipientName: string;
  subjectSnapshot: string;
  status: "sent" | "failed" | "logged";
  channel: string;
  audienceMode: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}


const OPERATOR_UAT_STORAGE_KEY = "citizen-email-center-operator-uat";

const OPERATOR_UAT_STEPS = [
  {
    id: "smtp-readiness",
    label: "Review SMTP transport readiness",
    description:
      "Confirm the email center shows the current SMTP source, readiness mode, and any validation issues before sending mail.",
  },
  {
    id: "smtp-update-test",
    label: "Update SMTP settings and send a test",
    description:
      "Adjust the relay settings from the dashboard, save them, and trigger a test message to a controlled recipient.",
  },
  {
    id: "template-edit-reset",
    label: "Edit and reset email templates",
    description:
      "Load a template, change the subject/body, save the override, then reset it back to the code default.",
  },
  {
    id: "history-review",
    label: "Review notification history",
    description:
      "Use the audit log cards to confirm recipient, template, status, timestamps, and any delivery errors without developer help.",
  },
  {
    id: "preview-send-update",
    label: "Preview and send onboarding updates",
    description:
      "Use only the onboarding update composer to preview the audience, inspect the rendered body, and send a controlled update.",
  },
  {
    id: "sync-warning",
    label: "Acknowledge sync execution warning",
    description:
      "Review the phase-1 synchronous delivery warning, queue recommendation threshold, and per-request recipient cap messaging.",
  },
] as const;

type OperatorUatStepId = (typeof OPERATOR_UAT_STEPS)[number]["id"];
type OperatorUatState = Record<OperatorUatStepId, boolean>;

type OperatorUatTouchedState = Partial<Record<OperatorUatStepId, string>>;

const EMPTY_OPERATOR_UAT_STATE: OperatorUatState = {
  "smtp-readiness": false,
  "smtp-update-test": false,
  "template-edit-reset": false,
  "history-review": false,
  "preview-send-update": false,
  "sync-warning": false,
};

const EMPTY_SMTP: SmtpSettingsResponse = {
  host: "",
  port: 587,
  secure: false,
  username: "",
  password: "",
  fromAddress: "",
  replyTo: "",
  defaultBcc: "",
  rejectUnauthorized: true,
};

export default function EmailCenterPage() {
  const router = useRouter();
  const [smtp, setSmtp] = useState<SmtpSettingsResponse>(EMPTY_SMTP);
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState("forgotPassword");
  const [templateDetails, setTemplateDetails] =
    useState<TemplateDetails | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [audienceMode, setAudienceMode] = useState<AudienceMode>("all");
  const [audienceRole, setAudienceRole] = useState("builder");
  const [audienceSearch, setAudienceSearch] = useState("");
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [customSubject, setCustomSubject] = useState("");
  const [updateTitle, setUpdateTitle] = useState("Cohort review status");
  const [updateBody, setUpdateBody] = useState(
    "<p>We are reviewing the next onboarding cohort now and will share timelines shortly.</p>",
  );
  const [nextStep, setNextStep] = useState(
    "Watch for the next onboarding email with timing and eligibility checkpoints.",
  );
  const [ctaLink, setCtaLink] = useState("");
  const [audiencePreview, setAudiencePreview] = useState<AudienceRecipient[]>(
    [],
  );
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewSubject, setPreviewSubject] = useState("");
  const [status, setStatus] = useState("");
  const [notificationHistory, setNotificationHistory] = useState<
    NotificationHistoryItem[]
  >([]);
  const [executionPlan, setExecutionPlan] = useState<UpdateExecutionPlan | null>(null);
  const [operatorChecklist, setOperatorChecklist] =
    useState<OperatorUatState>(EMPTY_OPERATOR_UAT_STATE);
  const [operatorTouchedAt, setOperatorTouchedAt] =
    useState<OperatorUatTouchedState>({});
  const [operatorReviewer, setOperatorReviewer] = useState("");
  const [operatorNotes, setOperatorNotes] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sendingUpdate, setSendingUpdate] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  const token =
    typeof window !== "undefined"
      ? localStorage.getItem(ADMIN_TOKEN_KEY)
      : null;

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const stored = window.localStorage.getItem(OPERATOR_UAT_STORAGE_KEY);
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as Partial<OperatorUatState> & {
        reviewer?: string;
        notes?: string;
        touchedAt?: OperatorUatTouchedState;
      };

      setOperatorChecklist({
        ...EMPTY_OPERATOR_UAT_STATE,
        ...Object.fromEntries(
          Object.entries(parsed).filter(([key]) =>
            key in EMPTY_OPERATOR_UAT_STATE,
          ),
        ),
      } as OperatorUatState);
      setOperatorTouchedAt(parsed.touchedAt ?? {});
      setOperatorReviewer(parsed.reviewer ?? "");
      setOperatorNotes(parsed.notes ?? "");
    } catch {
      window.localStorage.removeItem(OPERATOR_UAT_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      OPERATOR_UAT_STORAGE_KEY,
      JSON.stringify({
        ...operatorChecklist,
        touchedAt: operatorTouchedAt,
        reviewer: operatorReviewer,
        notes: operatorNotes,
      }),
    );
  }, [operatorChecklist, operatorNotes, operatorReviewer, operatorTouchedAt]);

  useEffect(() => {
    if (!token) {
      router.replace("/admin/login");
      return;
    }

    const load = async () => {
      try {
        const [smtpResponse, templatesResponse, historyResponse] =
          await Promise.all([
            fetch(`${API_URL}/admin/email/smtp-settings`, {
              headers: { Authorization: `Bearer ${token}` },
            }),
            fetch(`${API_URL}/admin/email/templates`, {
              headers: { Authorization: `Bearer ${token}` },
            }),
            fetch(`${API_URL}/admin/email/notifications/history?limit=25`, {
              headers: { Authorization: `Bearer ${token}` },
            }),
          ]);

        if (
          smtpResponse.status === 401 ||
          templatesResponse.status === 401 ||
          historyResponse.status === 401
        ) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace("/admin/login");
          return;
        }

        if (!smtpResponse.ok || !templatesResponse.ok || !historyResponse.ok) {
          throw new Error("Unable to load email center configuration.");
        }

        const smtpData =
          (await smtpResponse.json()) as Partial<SmtpSettingsResponse>;
        setSmtp((previous) => ({ ...previous, ...smtpData }));
        const templateList =
          (await templatesResponse.json()) as TemplateListItem[];
        setTemplates(templateList);
        setNotificationHistory(
          (await historyResponse.json()) as NotificationHistoryItem[],
        );
        setSelectedTemplate(templateList[0]?.type ?? "forgotPassword");
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unknown email center error",
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [router, token]);

  useEffect(() => {
    if (!token || !selectedTemplate) {
      return;
    }

    const loadTemplate = async () => {
      try {
        const response = await fetch(
          `${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );

        if (response.status === 401) {
          localStorage.removeItem(ADMIN_TOKEN_KEY);
          router.replace("/admin/login");
          return;
        }

        if (!response.ok) {
          throw new Error("Unable to load template.");
        }

        setTemplateDetails((await response.json()) as TemplateDetails);
      } catch (templateError) {
        setError(
          templateError instanceof Error
            ? templateError.message
            : "Unable to load template",
        );
      }
    };

    void loadTemplate();
  }, [router, selectedTemplate, token]);

  useEffect(() => {
    if (audienceMode !== "selected") {
      setSelectedLeadIds([]);
    }
  }, [audienceMode]);

  const audiencePayload = useMemo(
    () => ({
      audienceMode,
      role: audienceMode === "role" ? audienceRole : undefined,
      search: audienceSearch || undefined,
      leadIds: audienceMode === "selected" ? selectedLeadIds : undefined,
      customSubject: customSubject || undefined,
      updateTitle,
      updateBody,
      nextStep,
      ctaLink: ctaLink || undefined,
    }),
    [
      audienceMode,
      audienceRole,
      audienceSearch,
      ctaLink,
      customSubject,
      nextStep,
      selectedLeadIds,
      updateBody,
      updateTitle,
    ],
  );

  const toggleLeadSelection = (leadId: string) => {
    setSelectedLeadIds((current) =>
      current.includes(leadId)
        ? current.filter((id) => id !== leadId)
        : [...current, leadId],
    );
  };

  const setOperatorStepState = (
    stepId: OperatorUatStepId,
    nextValue: boolean,
    options?: { preserveExistingTimestamp?: boolean },
  ) => {
    setOperatorChecklist((current) => {
      if (current[stepId] === nextValue) {
        return current;
      }

      return {
        ...current,
        [stepId]: nextValue,
      };
    });

    setOperatorTouchedAt((current) => {
      if (!nextValue) {
        if (!(stepId in current)) {
          return current;
        }

        const nextTouched = { ...current };
        delete nextTouched[stepId];
        return nextTouched;
      }

      if (options?.preserveExistingTimestamp && current[stepId]) {
        return current;
      }

      return {
        ...current,
        [stepId]: new Date().toISOString(),
      };
    });
  };

  const toggleOperatorChecklistItem = (stepId: OperatorUatStepId) => {
    setOperatorStepState(stepId, !operatorChecklist[stepId]);
  };

  const completedOperatorSteps = OPERATOR_UAT_STEPS.filter(
    (step) => operatorChecklist[step.id],
  ).length;
  const operatorValidationComplete =
    completedOperatorSteps === OPERATOR_UAT_STEPS.length;


  useEffect(() => {
    setOperatorStepState(
      "smtp-readiness",
      Boolean(smtp.transportStatus),
      { preserveExistingTimestamp: true },
    );
  }, [smtp.transportStatus]);

  useEffect(() => {
    if (notificationHistory.length > 0) {
      setOperatorStepState("history-review", true, {
        preserveExistingTimestamp: true,
      });
    }
  }, [notificationHistory.length]);

  useEffect(() => {
    if (executionPlan) {
      setOperatorStepState("sync-warning", true, {
        preserveExistingTimestamp: true,
      });
    }
  }, [executionPlan]);

  useEffect(() => {
    if (audiencePreview.length > 0 && previewHtml && previewSubject) {
      setOperatorStepState("preview-send-update", true, {
        preserveExistingTimestamp: true,
      });
    }
  }, [audiencePreview.length, previewHtml, previewSubject]);

  const operatorSummary = useMemo(() => {
    const lines = [
      `Operator reviewer: ${operatorReviewer || "Pending assignment"}`,
      `Checklist progress: ${completedOperatorSteps}/${OPERATOR_UAT_STEPS.length}`,
    ];

    for (const step of OPERATOR_UAT_STEPS) {
      const checked = operatorChecklist[step.id];
      const touchedAt = operatorTouchedAt[step.id];
      lines.push(
        `- [${checked ? "x" : " "}] ${step.label}${touchedAt ? ` (${new Date(touchedAt).toLocaleString()})` : ""}`,
      );
    }

    if (operatorNotes.trim()) {
      lines.push("Notes:", operatorNotes.trim());
    }

    return lines.join("\n");
  }, [
    completedOperatorSteps,
    operatorChecklist,
    operatorNotes,
    operatorReviewer,
    operatorTouchedAt,
  ]);

  const saveSmtp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;

    setSavingSmtp(true);
    setStatus("Saving SMTP settings...");
    setError("");
    try {
      const response = await fetch(`${API_URL}/admin/email/smtp-settings`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(smtp),
      });

      if (!response.ok) {
        throw new Error("Unable to save SMTP settings.");
      }

      setOperatorStepState("smtp-update-test", true, {
        preserveExistingTimestamp: true,
      });
      setStatus("SMTP settings saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save SMTP settings.",
      );
      setStatus("");
    } finally {
      setSavingSmtp(false);
    }
  };

  const sendTest = async () => {
    if (!token || !testRecipient.trim()) return;
    setTestingSmtp(true);
    setStatus("Sending SMTP test...");
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/admin/email/smtp-settings/test`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ to: testRecipient.trim() }),
        },
      );

      if (!response.ok) {
        throw new Error("Unable to send SMTP test.");
      }

      setOperatorStepState("smtp-update-test", true, {
        preserveExistingTimestamp: true,
      });
      setStatus("SMTP test request completed.");
    } catch (testError) {
      setError(
        testError instanceof Error ? testError.message : "SMTP test failed",
      );
      setStatus("");
    } finally {
      setTestingSmtp(false);
    }
  };

  const saveTemplate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || !templateDetails) return;

    setSavingTemplate(true);
    setStatus(`Saving ${selectedTemplate} template...`);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: templateDetails.subject,
            html: templateDetails.html,
          }),
        },
      );

      if (!response.ok) {
        throw new Error("Unable to save template.");
      }

      setTemplateDetails((await response.json()) as TemplateDetails);
      setOperatorStepState("template-edit-reset", true, {
        preserveExistingTimestamp: true,
      });
      setStatus(`Template ${selectedTemplate} saved.`);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save template",
      );
      setStatus("");
    } finally {
      setSavingTemplate(false);
    }
  };

  const resetTemplate = async () => {
    if (!token) return;
    setStatus(`Resetting ${selectedTemplate} template...`);
    setError("");
    try {
      const response = await fetch(
        `${API_URL}/admin/email/templates/${encodeURIComponent(selectedTemplate)}/reset`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        throw new Error("Unable to reset template.");
      }

      setTemplateDetails((await response.json()) as TemplateDetails);
      setOperatorStepState("template-edit-reset", true, {
        preserveExistingTimestamp: true,
      });
      setStatus(`Template ${selectedTemplate} reset to defaults.`);
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Unable to reset template",
      );
      setStatus("");
    }
  };

  const previewAudience = async () => {
    if (!token) return;
    setPreviewing(true);
    setError("");
    setStatus("Loading onboarding update preview...");

    try {
      const response = await fetch(
        `${API_URL}/admin/email/onboarding-updates/preview`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(audiencePayload),
        },
      );

      if (!response.ok) {
        throw new Error("Unable to preview onboarding update.");
      }

      const payload = (await response.json()) as {
        recipients: AudienceRecipient[];
        preview: { subject: string; html: string } | null;
        executionPlan?: UpdateExecutionPlan;
      };
      setAudiencePreview(payload.recipients);
      setPreviewSubject(payload.preview?.subject ?? "");
      setPreviewHtml(payload.preview?.html ?? "");
      setExecutionPlan(payload.executionPlan ?? null);
      if (audienceMode === "selected") {
        setSelectedLeadIds((current) =>
          current.filter((leadId) =>
            payload.recipients.some((recipient) => recipient.id === leadId),
          ),
        );
      }
      setStatus(
        `Loaded preview for ${payload.recipients.length} recipient(s).`,
      );
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Unable to preview onboarding update",
      );
      setStatus("");
    } finally {
      setPreviewing(false);
    }
  };

  const loadNotificationHistory = async () => {
    if (!token) return;

    try {
      const response = await fetch(
        `${API_URL}/admin/email/notifications/history?limit=25`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!response.ok) {
        throw new Error("Unable to load notification history.");
      }

      setNotificationHistory(
        (await response.json()) as NotificationHistoryItem[],
      );
    } catch (historyError) {
      setError(
        historyError instanceof Error
          ? historyError.message
          : "Unable to load notification history",
      );
    }
  };

  const sendUpdate = async () => {
    if (!token) return;
    setSendingUpdate(true);
    setError("");
    setStatus("Sending onboarding update...");
    try {
      const response = await fetch(
        `${API_URL}/admin/email/onboarding-updates/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(audiencePayload),
        },
      );

      if (!response.ok) {
        throw new Error("Unable to send onboarding update.");
      }

      const payload = (await response.json()) as {
        totalRecipients: number;
        sent: number;
        logged: number;
        failed: number;
        executionPlan?: UpdateExecutionPlan;
      };
      setExecutionPlan(payload.executionPlan ?? null);
      setOperatorStepState("preview-send-update", true, {
        preserveExistingTimestamp: true,
      });
      setStatus(
        `Onboarding update attempted for ${payload.totalRecipients} recipient(s); ${payload.sent} sent, ${payload.logged} logged, ${payload.failed} failed.`,
      );
      await loadNotificationHistory();
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "Unable to send onboarding update",
      );
      setStatus("");
    } finally {
      setSendingUpdate(false);
    }
  };

  if (loading) {
    return (
      <div className="py-8 text-sm text-slate-500">Loading email center…</div>
    );
  }

  return (
    <section className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
                SMTP source
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {smtp.resolvedSource ?? "database"}
              </p>
            </div>
            <Settings2 className="h-10 w-10 text-indigo-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
                Templates
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {templates.length}
              </p>
            </div>
            <Mail className="h-10 w-10 text-blue-600" />
          </CardContent>
        </Card>
        <Card gradient>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">
                Update audience
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">
                {audienceMode === "selected"
                  ? selectedLeadIds.length
                  : audiencePreview.length}
              </p>
            </div>
            <Send className="h-10 w-10 text-emerald-600" />
          </CardContent>
        </Card>
      </div>

      {status && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          {status}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-indigo-100 p-3 text-indigo-700">
              <CheckSquare className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Operator / UAT validation checklist</CardTitle>
              <CardDescription>
                Start the dashboard-only validation round from the runbook and
                record who completed it. Progress is stored locally in this
                browser.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={operatorValidationComplete ? "success" : "info"}>
              {completedOperatorSteps}/{OPERATOR_UAT_STEPS.length} checks complete
            </Badge>
            <Badge variant={operatorValidationComplete ? "success" : "warning"}>
              {operatorValidationComplete ? "Ready for sign-off" : "Operator sign-off pending"}
            </Badge>
            <p className="text-sm text-slate-600">
              Require one operator who did not implement the feature to complete
              this round without backend or source-code walkthroughs.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Checklist usage notes</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>Checklist items auto-complete when the operator loads readiness, history, preview, or completes the related save/send action.</li>
              <li>Operators can still manually adjust any item if remediation or retesting is required.</li>
              <li>Use the copy button below to paste the sign-off summary into the release ticket or runbook evidence log.</li>
            </ul>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {OPERATOR_UAT_STEPS.map((step) => (
              <label
                key={step.id}
                className={`rounded-2xl border p-4 transition ${operatorChecklist[step.id] ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white"}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={operatorChecklist[step.id]}
                    onChange={() => toggleOperatorChecklistItem(step.id)}
                    className="mt-1"
                  />
                  <div>
                    <p className="font-semibold text-slate-900">{step.label}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {step.description}
                    </p>
                    {operatorTouchedAt[step.id] ? (
                      <p className="mt-2 text-xs font-medium text-slate-500">
                        Last updated {new Date(operatorTouchedAt[step.id] as string).toLocaleString()}
                      </p>
                    ) : null}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(operatorSummary);
                  setStatus("Operator UAT summary copied to clipboard.");
                  setError("");
                } catch {
                  setError("Unable to copy the operator summary from this browser.");
                }
              }}
            >
              Copy sign-off summary
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOperatorChecklist(EMPTY_OPERATOR_UAT_STATE);
                setOperatorTouchedAt({});
                setOperatorReviewer("");
                setOperatorNotes("");
                setStatus("Operator UAT checklist cleared for a fresh validation round.");
                setError("");
              }}
            >
              Reset checklist
            </Button>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Sign-off summary preview</p>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-slate-700">{operatorSummary}</pre>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="operatorReviewer">Operator reviewer</Label>
              <Input
                id="operatorReviewer"
                value={operatorReviewer}
                onChange={(event) => setOperatorReviewer(event.target.value)}
                placeholder="Name of non-implementing reviewer"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="operatorNotes">Reviewer notes</Label>
              <Textarea
                id="operatorNotes"
                rows={3}
                value={operatorNotes}
                onChange={(event) => setOperatorNotes(event.target.value)}
                placeholder="Record any remediation tasks, risk acceptance, or sign-off context."
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {executionPlan && (
        <div
          className={`rounded-xl px-4 py-3 text-sm ${executionPlan.warning ? "border border-amber-200 bg-amber-50 text-amber-900" : "border border-blue-200 bg-blue-50 text-blue-900"}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={executionPlan.queueRecommended ? "warning" : "info"}>
              {executionPlan.mode}
            </Badge>
            <Badge
              variant={
                executionPlan.recommendedMode === "queued-worker"
                  ? "warning"
                  : "success"
              }
            >
              Recommended: {executionPlan.recommendedMode}
            </Badge>
          </div>
          <p className="mt-2">
            Phase 1 sends onboarding updates inline in the request cycle. Audiences above {executionPlan.queueRecommendedThreshold} recipients should move to a queue worker, and requests are capped at {executionPlan.maxRecipientsPerRequest} recipients.
          </p>
          {executionPlan.warning ? (
            <p className="mt-2 font-medium">{executionPlan.warning}</p>
          ) : null}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>SMTP settings</CardTitle>
            <CardDescription>
              Configure the active onboarding email relay and send a test
              message.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {smtp.transportStatus?.issues?.length ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">
                    {smtp.transportStatus.mode === "smtp"
                      ? "SMTP ready"
                      : "Fallback active"}
                  </Badge>
                  <Badge
                    variant={smtp.transportStatus.strict ? "error" : "info"}
                  >
                    {smtp.transportStatus.strict
                      ? "Strict delivery"
                      : "Development-safe"}
                  </Badge>
                </div>
                <ul className="mt-3 list-disc space-y-1 pl-5">
                  {smtp.transportStatus.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                Real SMTP delivery is ready for the current configuration.
              </div>
            )}
            <form className="space-y-4" onSubmit={saveSmtp}>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="host">Host</Label>
                  <Input
                    id="host"
                    value={smtp.host}
                    onChange={(event) =>
                      setSmtp((prev) => ({ ...prev, host: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="port">Port</Label>
                  <Input
                    id="port"
                    type="number"
                    value={String(smtp.port)}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        port: Number(event.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    value={smtp.username}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        username: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={smtp.password}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        password: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="fromAddress">From address</Label>
                  <Input
                    id="fromAddress"
                    value={smtp.fromAddress}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        fromAddress: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="replyTo">Reply-to</Label>
                  <Input
                    id="replyTo"
                    value={smtp.replyTo}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        replyTo: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="defaultBcc">Default BCC</Label>
                <Input
                  id="defaultBcc"
                  value={smtp.defaultBcc}
                  onChange={(event) =>
                    setSmtp((prev) => ({
                      ...prev,
                      defaultBcc: event.target.value,
                    }))
                  }
                  placeholder="ops@example.com; audit@example.com"
                />
              </div>
              <div className="flex flex-wrap gap-4 text-sm text-slate-600">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtp.secure}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        secure: event.target.checked,
                      }))
                    }
                  />{" "}
                  Secure (TLS)
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtp.rejectUnauthorized}
                    onChange={(event) =>
                      setSmtp((prev) => ({
                        ...prev,
                        rejectUnauthorized: event.target.checked,
                      }))
                    }
                  />{" "}
                  Reject unauthorized certificates
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={savingSmtp}>
                  {savingSmtp ? "Saving…" : "Save SMTP settings"}
                </Button>
                <Input
                  value={testRecipient}
                  onChange={(event) => setTestRecipient(event.target.value)}
                  placeholder="test recipient email"
                  className="max-w-xs"
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={sendTest}
                  disabled={testingSmtp || !testRecipient.trim()}
                >
                  {testingSmtp ? "Sending…" : "Send test"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Email templates</CardTitle>
                <CardDescription>
                  Edit database overrides for onboarding email templates.
                </CardDescription>
              </div>
              {templateDetails && (
                <Badge
                  variant={
                    templateDetails.source === "database"
                      ? "success"
                      : "default"
                  }
                >
                  {templateDetails.source}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={saveTemplate}>
              <div className="space-y-2">
                <Label htmlFor="templateType">Template type</Label>
                <select
                  id="templateType"
                  className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400"
                  value={selectedTemplate}
                  onChange={(event) => setSelectedTemplate(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.type} value={template.type}>
                      {template.type}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="templateSubject">Subject</Label>
                <Input
                  id="templateSubject"
                  value={templateDetails?.subject ?? ""}
                  onChange={(event) =>
                    setTemplateDetails((prev) =>
                      prev ? { ...prev, subject: event.target.value } : prev,
                    )
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="templateHtml">HTML body</Label>
                <Textarea
                  id="templateHtml"
                  rows={14}
                  value={templateDetails?.html ?? ""}
                  onChange={(event) =>
                    setTemplateDetails((prev) =>
                      prev ? { ...prev, html: event.target.value } : prev,
                    )
                  }
                />
              </div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                <p className="font-semibold text-slate-900">
                  Available placeholders
                </p>
                <p className="mt-2">
                  {templateDetails?.placeholders.join(", ") || "—"}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="submit"
                  disabled={savingTemplate || !templateDetails}
                >
                  {savingTemplate ? "Saving…" : "Save template"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={resetTemplate}
                  disabled={!templateDetails}
                >
                  Reset to default
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Notification audit log</CardTitle>
              <CardDescription>
                Recent per-recipient onboarding email activity and delivery
                status. Load the newest 25 records for operator review without
                developer assistance.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={loadNotificationHistory}
            >
              Refresh history
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {notificationHistory.length === 0 ? (
              <p className="text-sm text-slate-500">
                No notification history yet.
              </p>
            ) : (
              notificationHistory.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-900">
                        {item.recipientName || item.recipientEmail}
                      </p>
                      <p className="text-sm text-slate-600">
                        {item.recipientEmail}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge
                        variant={
                          item.status === "sent"
                            ? "success"
                            : item.status === "logged"
                              ? "default"
                              : "error"
                        }
                      >
                        {item.status}
                      </Badge>
                      <Badge>{item.templateType}</Badge>
                    </div>
                  </div>
                  <p className="mt-3 text-sm font-medium text-slate-900">
                    {item.subjectSnapshot}
                  </p>
                  <div className="mt-2 grid gap-1 text-xs text-slate-500 md:grid-cols-2">
                    <p>Audience: {item.audienceMode || "n/a"}</p>
                    <p>Channel: {item.channel || "n/a"}</p>
                    <p>Created: {new Date(item.createdAt).toLocaleString()}</p>
                    <p>
                      Sent:{" "}
                      {item.sentAt
                        ? new Date(item.sentAt).toLocaleString()
                        : "—"}
                    </p>
                  </div>
                  {item.errorMessage ? (
                    <p className="mt-2 text-sm text-red-600">
                      {item.errorMessage}
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-blue-100 p-3 text-blue-700">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>Onboarding update composer</CardTitle>
              <CardDescription>
                Preview and send status updates to applicants in bulk, by role,
                or by selected leads.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="audienceMode">Audience mode</Label>
              <select
                id="audienceMode"
                className="w-full rounded-xl border-2 border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400"
                value={audienceMode}
                onChange={(event) =>
                  setAudienceMode(event.target.value as AudienceMode)
                }
              >
                <option value="all">All applicants</option>
                <option value="role">By role</option>
                <option value="selected">Selected leads</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="audienceRole">Role</Label>
              <Input
                id="audienceRole"
                value={audienceRole}
                onChange={(event) => setAudienceRole(event.target.value)}
                disabled={audienceMode !== "role"}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="audienceSearch">Search filter</Label>
              <Input
                id="audienceSearch"
                value={audienceSearch}
                onChange={(event) => setAudienceSearch(event.target.value)}
                placeholder="name, email, institution"
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="customSubject">Custom subject override</Label>
              <Input
                id="customSubject"
                value={customSubject}
                onChange={(event) => setCustomSubject(event.target.value)}
                placeholder="Optional custom subject"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="updateTitle">Update title</Label>
              <Input
                id="updateTitle"
                value={updateTitle}
                onChange={(event) => setUpdateTitle(event.target.value)}
                placeholder="Eligibility review update"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="updateBody">Update body (HTML allowed)</Label>
            <Textarea
              id="updateBody"
              rows={8}
              value={updateBody}
              onChange={(event) => setUpdateBody(event.target.value)}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nextStep">Next step</Label>
              <Input
                id="nextStep"
                value={nextStep}
                onChange={(event) => setNextStep(event.target.value)}
                placeholder="Confirm eligibility documents when invited."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ctaLink">CTA link</Label>
              <Input
                id="ctaLink"
                value={ctaLink}
                onChange={(event) => setCtaLink(event.target.value)}
                placeholder="https://citizen.example/onboarding"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={previewAudience}
              disabled={previewing}
            >
              {previewing ? "Previewing…" : "Preview audience"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={sendUpdate}
              disabled={
                sendingUpdate ||
                (audienceMode === "selected"
                  ? selectedLeadIds.length === 0
                  : audiencePreview.length === 0)
              }
            >
              {sendingUpdate ? "Sending…" : "Send update"}
            </Button>
          </div>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="font-semibold text-slate-900">Audience preview</p>
                {audienceMode === "selected" ? (
                  <Badge>{selectedLeadIds.length} selected</Badge>
                ) : null}
              </div>
              <div className="space-y-3 text-sm text-slate-600">
                {audiencePreview.length === 0 ? (
                  <p>No recipients loaded yet.</p>
                ) : (
                  audiencePreview.map((recipient) => {
                    const isSelected = selectedLeadIds.includes(recipient.id);
                    return (
                      <label
                        key={recipient.id}
                        className={`block rounded-xl border p-3 transition ${isSelected ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-slate-50"}`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleLeadSelection(recipient.id)}
                            disabled={audienceMode !== "selected"}
                            className="mt-1"
                          />
                          <div>
                            <p className="font-semibold text-slate-900">
                              {recipient.fullName}
                            </p>
                            <p>{recipient.email}</p>
                            <p>
                              {recipient.role} · {recipient.institution}
                            </p>
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="mb-1 font-semibold text-slate-900">
                Rendered preview
              </p>
              <p className="mb-4 text-sm text-slate-500">
                Subject: {previewSubject || "Not loaded yet"}
              </p>
              <div
                className="prose max-w-none rounded-xl bg-slate-50 p-4"
                dangerouslySetInnerHTML={{
                  __html: previewHtml || "<p>No preview loaded yet.</p>",
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
