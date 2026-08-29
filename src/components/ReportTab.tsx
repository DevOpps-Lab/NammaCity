"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { processImage, type ProcessedImage, type BlurRegion } from "@/lib/imaging";
import { type DetectionResult } from "@/lib/detect";
import { llmAnalyze, type LLMAnalysisResult } from "@/lib/llm-analyze";
import { locate, resolveAuthority, type LocationFix, type ResolveOutcome } from "@/lib/pipeline";
import type { IssueCategory, CategorySource, Severity } from "@/lib/types";
import { SEVERITY_OPTIONS } from "@/lib/severity";
import { formatPlace } from "@/lib/place";
import { CATEGORY_OPTIONS } from "@/lib/detect";
import { t, type Lang } from "@/lib/i18n";

export interface ConfirmedReport {
  image: ProcessedImage;
  detection: DetectionResult;
  category: IssueCategory;
  categorySource: CategorySource;
  categoryConfidence: number;
  fix: LocationFix;
  resolved: Extract<ResolveOutcome, { ok: true }>;
}

type Stage = "idle" | "analysing" | "identified" | "filing";

/**
 * The primary flow: photograph a defect, have it identified, tap once.
 *
 * The agents run BEFORE the button, not after it — so the citizen sees the
 * ward, the responsible agencies and the deadline they are about to hold
 * someone to, rather than discovering them afterwards. That inversion is why
 * both refusal paths (`unreachable`, `no_authority`) render as blocking states
 * here instead of aborting a submission.
 *
 * The honesty disclosures are collapsed, not deleted. They are the reason this
 * app is trustworthy; they just shouldn't stand between a resident and the one
 * button they came to press.
 */
export default function ReportTab({
  lang,
  displayName,
  onConfirm,
  busy,
  initialFile,
  onInitialFileHandled,
}: {
  lang: Lang;
  /** First name only — a full "Aravind Kumar S" in a greeting reads like a form letter. */
  displayName: string;
  onConfirm: (c: ConfirmedReport) => void;
  busy: boolean;
  /**
   * A frame handed over from Dashcam mode. Runs through the exact same
   * analyse() pipeline as a manually-picked photo — redaction, category
   * identification, authority resolution — so a dashcam capture is never
   * treated as pre-trusted just because a model already boxed it.
   */
  initialFile?: File | null;
  /** Called once the file above has been consumed, so the parent can clear it. */
  onInitialFileHandled?: () => void;
}) {
  const firstName = displayName.trim().split(/\s+/)[0] || "";
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [step, setStep] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [image, setImage] = useState<ProcessedImage | null>(null);
  const [regions, setRegions] = useState<BlurRegion[]>([]);
  const [llmResult, setLlmResult] = useState<LLMAnalysisResult | null>(null);
  const [category, setCategory] = useState<IssueCategory | null>(null);
  const [source, setSource] = useState<CategorySource>("user");
  // Severity as returned by LLM, overrideable by user
  const [severity, setSeverity] = useState<"minor" | "moderate" | "severe">("moderate");
  const [fix, setFix] = useState<LocationFix | null>(null);
  const [resolved, setResolved] = useState<ResolveOutcome | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [reblurring, setReblurring] = useState(false);

  const reset = () => {
    setStage("idle");
    setFile(null);
    setImage(null);
    setRegions([]);
    setLlmResult(null);
    setCategory(null);
    setSource("user");
    setSeverity("moderate");
    setFix(null);
    setResolved(null);
    setPickerOpen(false);
    setShowDetail(false);
  };

  /** Redact → call LLM for category+severity → locate → resolve authority. */
  const analyse = useCallback(async (f: File, blur: BlurRegion[]) => {
    setStage("analysing");

    try {
      setStep("Redacting faces on your device…");
      const processed = await processImage(f, blur);
      setImage(processed);

      // LLM analysis and geolocation run in parallel — independent of each other.
      setStep("Analysing the image and finding your location…");
      const [result, position] = await Promise.all([
        llmAnalyze(processed.dataUrl),
        locate(),
      ]);
      setLlmResult(result);
      setFix(position);

      // Pre-fill from LLM; user can override either.
      const chosen = result.state === "unavailable" ? null : result.category;
      setCategory(chosen);
      setSource(result.state === "unavailable" ? "user" : "model");
      if (result.severity) setSeverity(result.severity);
      setPickerOpen(result.state !== "identified");

      if (chosen) {
        setStep("Resolving the responsible authority…");
        try {
          setResolved(await resolveAuthority(position.lat, position.lng, chosen));
        } catch {
          setResolved({ ok: false, kind: "unreachable" });
        }
      }
    } catch (err) {
      // Something unexpected threw — don't leave the user frozen.
      // Surface the error as an unavailable LLM result so the form still
      // renders and the user can pick category/severity manually.
      console.error("[analyse] unexpected error:", err);
      const pos = await locate().catch(() => ({ lat: 13.0389, lng: 80.2492, exact: false }));
      setFix(pos);
      setLlmResult({
        category: null,
        severity: null,
        confidence: 0,
        reason: "",
        state: "unavailable",
        note: "Something went wrong during analysis. Choose the category and severity below.",
      });
      setPickerOpen(true);
    }

    setStage("identified");
  }, []);

  const seedFromFile = useCallback(
    async (f: File) => {
      setFile(f);
      setRegions([]);
      await analyse(f, []);
    },
    [analyse]
  );

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      await seedFromFile(f);
    },
    [seedFromFile]
  );

  // Dashcam hands a frame over via `initialFile` instead of the file input.
  // Runs once per file: the parent nulls it out in onInitialFileHandled,
  // which is what stops this from re-firing on every re-render. Queued as a
  // microtask so seeding is a reaction to the prop change, not a synchronous
  // setState cascade inside the effect's own render pass.
  useEffect(() => {
    if (!initialFile) return;
    onInitialFileHandled?.();
    queueMicrotask(() => void seedFromFile(initialFile));
  }, [initialFile, seedFromFile, onInitialFileHandled]);

  /**
   * Tap-to-redact — works everywhere, unlike the FaceDetector API.
   *
   * This ONLY re-renders the redaction: it reuses the faces already detected on
   * the first pass and does NOT re-run the category/severity analysis or
   * geolocation. Blurring a bystander must not re-classify the photo, re-hit the
   * rate-limited vision model, or wipe the form to a spinner — all of which the
   * old path did on every tap.
   */
  const onTapImage = useCallback(
    async (e: React.MouseEvent<HTMLImageElement>) => {
      if (!file || !image || !imgRef.current || reblurring) return;
      const rect = imgRef.current.getBoundingClientRect();
      const size = Math.max(image.width, image.height) * 0.12;
      const next = [
        ...regions,
        {
          x: (e.clientX - rect.left) * (image.width / rect.width) - size / 2,
          y: (e.clientY - rect.top) * (image.height / rect.height) - size / 2,
          w: size,
          h: size,
        },
      ];
      setRegions(next);
      setReblurring(true);
      try {
        const processed = await processImage(file, next, {
          faceRegions: image.faceRegions,
          supported: !image.manualReviewRequired,
          backend: image.detectionBackend,
        });
        setImage(processed);
      } catch (err) {
        console.error("[redact] tap-to-blur failed:", err);
      } finally {
        setReblurring(false);
      }
    },
    [file, image, regions, reblurring]
  );

  /** Changing the category re-resolves: a different category can mean a different agency. */
  const chooseCategory = useCallback(
    async (c: IssueCategory) => {
      setCategory(c);
      setSource("user");
      setPickerOpen(false);
      if (fix) {
        setResolved(null);
        setResolved(await resolveAuthority(fix.lat, fix.lng, c));
      }
    },
    [fix]
  );

  // ---------------------------------------------------------------- idle
  if (stage === "idle") {
    return (
      <Shell>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPick}
          className="hidden"
        />
        {firstName && (
          <p className="rise-in mb-3 text-[15px] font-semibold">
            Hello, {firstName}.
            <span className="ml-1.5 font-normal text-[var(--text-dim)]">
              What have you found?
            </span>
          </p>
        )}
        <button
          onClick={() => fileRef.current?.click()}
          className="press active:scale-[0.98] rise-in group relative flex w-full flex-col items-center justify-center gap-5 rounded-3xl overflow-hidden py-24 shadow-[0_8px_30px_rgba(var(--accent-rgb),0.12)] transition-all hover:shadow-[0_8px_40px_rgba(var(--accent-rgb),0.2)]"
        >
          {/* Background effects */}
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--surface)] to-[var(--surface-2)]" />
          <div className="absolute inset-0 opacity-[0.15] transition-opacity duration-500 group-hover:opacity-30" style={{ background: "var(--brand-grad)" }} />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[var(--accent)]/10 to-transparent" />
          
          <span
            className="breathe relative grid h-24 w-24 place-items-center rounded-full text-white shadow-[0_0_40px_rgba(var(--accent-rgb),0.4)]"
            style={{ background: "var(--brand-grad)" }}
          >
            <Icon name="camera" size={36} />
            <div className="absolute inset-0 rounded-full border border-white/20" />
          </span>
          <div className="relative text-center">
            <span className="block text-xl font-bold tracking-tight">{t(lang, "takePhoto")}</span>
            <span className="mt-2 block max-w-[28ch] text-[13px] leading-relaxed text-[var(--text-dim)]">
              {t(lang, "photoHint")}
            </span>
          </div>
        </button>
        <p className="rise-in mt-4 text-center text-[11px] leading-relaxed text-[var(--text-faint)]">
          Everything below happens before you commit: the photo is redacted on
          your device, the issue is identified, and we work out which agency is
          responsible. You confirm once.
        </p>
      </Shell>
    );
  }

  // ------------------------------------------------------------ analysing
  if (stage === "analysing" || !image || !llmResult) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-24">
          <div className="relative mb-8 h-20 w-20">
            {/* Pulsing rings */}
            <div className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)]/20" />
            <div className="absolute inset-2 animate-ping rounded-full bg-[var(--accent)]/40" style={{ animationDelay: "0.2s" }} />
            
            <div className="absolute inset-0 grid place-items-center rounded-full bg-[var(--surface)] shadow-[0_0_30px_rgba(var(--accent-rgb),0.2)]">
              <Icon name="eye" size={32} className="text-[var(--accent)] animate-pulse" />
            </div>
            
            {/* Orbiting dot */}
            <div className="absolute inset-0 animate-spin" style={{ animationDuration: "2s" }}>
              <div className="h-3 w-3 rounded-full bg-[var(--accent)] shadow-[0_0_10px_var(--accent)] -translate-y-1.5 translate-x-8" />
            </div>
          </div>
          <p className="fade-in text-center text-[15px] font-semibold tracking-tight">{step}</p>
          <p className="fade-in mt-2 text-center text-[12px] text-[var(--text-dim)]">AI Vision & Location Engine Active</p>
        </div>
      </Shell>
    );
  }

  // ------------------------------------------------------------ identified
  const ok = resolved?.ok === true ? resolved : null;
  const canFile = Boolean(category && ok) && !busy;
  // Map LLM severity string to the Severity type the pipeline expects.
  const mappedSeverity: Severity = SEVERITY_OPTIONS.find(s => s.value === severity)?.mapped ?? "medium";

  return (
    <Shell>
      <div className="card rise-in overflow-hidden shadow-[var(--shadow-2)]">
        {/* photo + tap to redact */}
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={image.dataUrl}
            alt="Your report"
            onClick={onTapImage}
            className="max-h-[38vh] w-full cursor-crosshair bg-[var(--surface)] object-contain"
          />
          <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[10px] text-white">
            {reblurring ? "Blurring…" : t(lang, "tapToBlur")}
          </span>
          {reblurring && (
            <span className="absolute right-2 top-2 h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
        </div>

        <div className="p-4">
          {/* --- category: the auto-identified answer, always changeable --- */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
                {llmResult?.state === "identified" ? "Best guess" : "What is it?"}
              </p>
              <p className="mt-0.5 truncate text-[19px] font-bold leading-tight">
                {category
                  ? CATEGORY_OPTIONS.find((o) => o.value === category)?.[
                      lang === "ta" ? "ta" : "label"
                    ]
                  : "Not identified"}
              </p>
              {llmResult?.reason && category && source !== "user" && (
                <p className="mt-0.5 truncate text-[11px] text-[var(--text-dim)]">
                  {llmResult.reason} · {Math.round((llmResult.confidence ?? 0) * 100)}% confident
                </p>
              )}
            </div>
            <button
              onClick={() => setPickerOpen((v) => !v)}
              className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-dim)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              {category ? "Change" : "Choose"}
            </button>
          </div>

          {/* Unavailable note */}
          {llmResult?.state === "unavailable" && llmResult.note && (
            <p className="mt-2 rounded-lg border border-[var(--warning)]/35 bg-[var(--warning)]/10 px-3 py-2 text-[11px] leading-relaxed text-[var(--warning)]">
              {llmResult.note}
            </p>
          )}

          {pickerOpen && (
            <div className="fade-in mt-3 grid grid-cols-3 gap-1.5">
              {CATEGORY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => chooseCategory(o.value)}
                  className={`rounded-lg border px-2 py-2 text-[11px] transition-colors ${
                    category === o.value
                      ? "border-[var(--accent)] bg-[var(--accent)] font-semibold text-[var(--on-accent)]"
                      : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {lang === "ta" ? o.ta : o.label}
                </button>
              ))}
            </div>
          )}

          {/* --- severity: LLM pre-selects, user always has final say --- */}
          <div className="mt-4">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              Severity
              <span className="ml-1.5 font-normal normal-case text-[var(--text-faint)]">
                {source === "user" ? "(choose one)" : "(AI estimate — tap to change)"}
              </span>
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {SEVERITY_OPTIONS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => setSeverity(s.value)}
                  className={`rounded-lg border px-2 py-2 text-[11px] font-medium transition-colors ${
                    severity === s.value
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)]"
                      : "border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* --- the facts you're about to file on --- */}
          <dl className="mt-4 space-y-2 border-t border-[var(--border)] pt-3 text-[12px]">
            <Row label="Location">
              {fix?.exact ? (
                ok?.routing ? (
                  formatPlace(ok.routing, fix)
                ) : (
                  `${fix.lat.toFixed(4)}, ${fix.lng.toFixed(4)}`
                )
              ) : (
                <span className="text-[var(--warning)]">
                  Approximate — your device gave no location fix
                </span>
              )}
            </Row>

            <Row label="Files to">
              {ok ? (
                <span className="space-y-0.5">
                  {ok.authorities.map((a) => (
                    <span key={a.id} className="block">
                      {a.name}
                      {!(a as { verified?: boolean }).verified && (
                        <span className="ml-1 text-[var(--warning)]">[unverified]</span>
                      )}
                    </span>
                  ))}
                  <span className="block text-[var(--text-faint)]">
                    {ok.authorities[0].slaHours}h deadline · {ok.authorities[0].slaSource}
                  </span>
                </span>
              ) : resolved?.ok === false ? (
                <span className="text-[var(--danger)]">
                  {resolved.kind === "unreachable"
                    ? "Resolver unreachable — we will not guess a jurisdiction."
                    : "No verified contact registry covers this location. We refuse to file blind."}
                </span>
              ) : category ? (
                <span className="text-[var(--text-faint)]">Resolving…</span>
              ) : (
                <span className="text-[var(--text-faint)]">Pick a category first</span>
              )}
            </Row>
          </dl>

          {/* --- disclosures: collapsed, never removed --- */}
          <button
            onClick={() => setShowDetail((v) => !v)}
            className="mt-3 flex w-full items-center justify-between border-t border-[var(--border)] pt-3 text-[11px] font-medium text-[var(--text-dim)]"
          >
            <span>Privacy and detector details</span>
            <Icon name={showDetail ? "chevron-down" : "chevron-right"} size={14} />
          </button>

          {showDetail && (
            <div className="fade-in mt-2 space-y-2 text-[11px] leading-relaxed text-[var(--text-dim)]">
              <p
                className={
                  image.manualReviewRequired ? "text-[var(--warning)]" : "text-[var(--success)]"
                }
              >
                {image.manualReviewRequired
                  ? "TF.js blazeface could not run in this browser — tap any faces or number plates yourself."
                  : `${image.facesFound} face(s) auto-redacted by TF.js blazeface`}
                {image.detectionBackend && ` (backend: ${image.detectionBackend})`}.
                {regions.length > 0 && ` ${regions.length} area(s) manually blurred by you.`}
              </p>
              <p>
                EXIF stripped · the original never leaves your phone ·{" "}
                {Math.round(image.bytes / 1024)} KB uploaded
              </p>
              <p className="text-[var(--text-faint)]">
                Category and severity identified by Gemini. You confirmed the result.
              </p>
            </div>
          )}
        </div>

        {/* PRIVACY, SAID OUT LOUD RATHER THAN IN A COLLAPSED PANEL.
            "0 face(s) auto-redacted" was already reported — inside "Privacy and
            detector details", collapsed by default, which is where a resident
            never looks. So a photo of an identifiable person was filed with the
            app believing it had redacted nothing because there was nothing to
            redact. Automatic detection is not exhaustive, and the moment that
            matters is BEFORE the button, not in a disclosure afterwards. */}
        {image && (image.manualReviewRequired || image.facesFound === 0) && (
          <div className="mx-4 mb-1 rounded-xl border border-[var(--warning)] bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[12px] font-semibold text-[var(--warning)]">
              {image.manualReviewRequired
                ? "Face blurring could not run"
                : "No faces were detected"}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-dim)]">
              {image.manualReviewRequired
                ? "Nothing in this photo has been blurred automatically."
                : "Nothing has been blurred. Face detection can miss people who are small in frame, turned away, or in shadow."}{" "}
              <strong>Tap anyone in the photo above to blur them</strong> before you file — it
              goes to a government office and onto a public ledger.
            </p>
          </div>
        )}

        {/* --- the one button --- */}
        <div className="border-t border-[var(--border)] bg-[var(--surface-2)] p-4">
          <button
            disabled={!canFile}
            onClick={() =>
              category &&
              ok &&
              onConfirm({
                image,
                // Pass a minimal DetectionResult-shaped object using the user-chosen severity
                detection: {
                  severity: mappedSeverity,
                  confidence: llmResult?.confidence ?? 0,
                  areaFraction: 0,
                  signals: [],
                  lowConfidence: (llmResult?.confidence ?? 0) < 0.45,
                  method: "heuristic-v1",
                },
                category,
                categorySource: source,
                categoryConfidence: llmResult?.confidence ?? 0,
                fix: fix!,
                resolved: ok,
              })
            }
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] text-[14px] font-bold text-[var(--on-accent)] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:bg-[var(--surface-3)] disabled:text-[var(--text-faint)]"
          >
            {busy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : (
              <Icon name="send" size={17} />
            )}
            {busy ? "Filing…" : "Report this issue"}
          </button>
          <button
            onClick={reset}
            className="mt-2 w-full text-[11px] font-medium text-[var(--text-dim)] hover:text-[var(--text)]"
          >
            {t(lang, "retake")}
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="scroll-thin h-full overflow-y-auto px-4 py-5">
      <div className="mx-auto w-full max-w-lg">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[74px] shrink-0 text-[var(--text-faint)]">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium">{children}</dd>
    </div>
  );
}
