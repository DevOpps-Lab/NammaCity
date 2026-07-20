/**
 * Minimal Tamil/English strings.
 *
 * Not decoration: Namma Chennai shipped English-only in a Tamil-speaking city
 * and managed roughly 1 lakh downloads in a metro of 7M+. Language exclusion is
 * one of the documented reasons Indian civic apps fail to reach the people with
 * the worst infrastructure.
 */

export type Lang = "en" | "ta";

const STRINGS = {
  reportIssue: { en: "Report an issue", ta: "சிக்கலைப் பதிவு செய்" },
  takePhoto: { en: "Take a photo", ta: "படம் எடுக்கவும்" },
  photoHint: {
    en: "Faces and plates are blurred on your device before upload",
    ta: "பதிவேற்றும் முன் முகங்கள் உங்கள் சாதனத்திலேயே மறைக்கப்படும்",
  },
  processing: { en: "Redacting and analysing…", ta: "மறைத்து ஆய்வு செய்கிறது…" },
  tapToBlur: { en: "Tap anything to blur it", ta: "மறைக்க தட்டவும்" },
  manualReview: {
    en: "Please tap any faces or number plates yourself before submitting.",
    ta: "சமர்ப்பிக்கும் முன் முகங்களை நீங்களே தட்டி மறைக்கவும்.",
  },
  severity: { en: "Severity", ta: "தீவிரம்" },
  category: { en: "What is it?", ta: "இது என்ன?" },
  retake: { en: "Retake", ta: "மீண்டும்" },
  submit: { en: "File complaint", ta: "புகார் அளி" },
  lowConfidence: {
    en: "Low confidence — shadows, wet patches and manhole covers are known confusers. Please check the category before filing.",
    ta: "நம்பகத்தன்மை குறைவு — நிழல்கள், ஈரமான இடங்கள் குழப்பலாம். வகையைச் சரிபார்க்கவும்.",
  },
  open: { en: "Open", ta: "நிலுவை" },
  pastSla: { en: "Past SLA", ta: "காலம் தாண்டியது" },
  verified: { en: "Verified", ta: "உறுதி" },
  recentlyFixed: { en: "Recently fixed", ta: "சமீபத்தில் சரிசெய்யப்பட்டவை" },
  reportsNotProblems: {
    en: "Showing reports, not problems — affluent areas report more.",
    ta: "புகார்களைக் காட்டுகிறது, பிரச்சினைகளை அல்ல.",
  },
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[key][lang];
}
