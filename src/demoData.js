export const caseId = "FR-20260829-0042";

export const custodians = [
  {
    id: "northport",
    name: "Northport Air",
    kind: "Airport inventory",
    synced: "10:14 AM",
    folders: [
      { label: "Aug 29, 2026", count: 8, selected: true },
      { label: "Aug 28, 2026", count: 5 },
    ],
  },
  {
    id: "metro-loop",
    name: "Metro Loop",
    kind: "Transit inventory",
    synced: "10:13 AM",
    folders: [
      { label: "Aug 29, 2026", count: 12 },
      { label: "Aug 28, 2026", count: 9 },
    ],
  },
  {
    id: "grand-hall",
    name: "Grand Hall",
    kind: "Venue inventory",
    synced: "10:11 AM",
    folders: [
      { label: "Aug 29, 2026", count: 6 },
      { label: "Aug 27, 2026", count: 4 },
    ],
  },
];

export const libraryItems = [
  { id: "NPA_042_A", custodianId: "northport", dateLabel: "Aug 29, 2026", filename: "NPA29_042_A.JPG", src: "/assets/pouch-front.jpg", label: "Black camera pouch" },
  { id: "NPA_042_B", custodianId: "northport", dateLabel: "Aug 29, 2026", filename: "NPA29_042_B.JPG", src: "/assets/pouch-rear.jpg", label: "Rear view" },
  { id: "ML_188", custodianId: "metro-loop", dateLabel: "Aug 29, 2026", filename: "ML29_0188.JPG", src: "/assets/claimant-match.jpg", label: "Similar pouch" },
  { id: "GH_077", custodianId: "grand-hall", dateLabel: "Aug 29, 2026", filename: "GH29_0077.JPG", src: "/assets/northport-intake.jpg", label: "Counter intake" },
  { id: "NPA_042_C", custodianId: "northport", dateLabel: "Aug 29, 2026", filename: "NPA29_042_C.JPG", src: "/assets/pouch-interior.jpg", label: "Interior" },
];

export const evidenceTags = ["camera pouch", "black nylon", "orange stitch", "two zips", "inner flap"];

export const comparison = {
  primary: {
    id: "NPA-042",
    filename: "NPA29_042_A.JPG",
    view: "Front view",
    src: "/assets/pouch-front.jpg",
    dimensions: "1600×1200",
    size: "1.4 MB",
  },
  secondary: {
    id: "NPA-042",
    filename: "NPA29_042_B.JPG",
    view: "Rear view (selected)",
    src: "/assets/pouch-rear.jpg",
    dimensions: "1600×1200",
    size: "1.3 MB",
  },
};

export const trayItems = [
  { id: "front", label: "Front", src: "/assets/pouch-front.jpg" },
  { id: "rear", label: "Rear", src: "/assets/pouch-rear.jpg", selected: true },
  { id: "inside", label: "Interior", src: "/assets/pouch-interior.jpg" },
  { id: "voice", label: "Claim — typed report", transcript: "Black camera pouch, two zips, orange stitching inside." },
  { id: "claim-photo", label: "Claim — prior photo", src: "/assets/claimant-match.jpg", blurred: true },
];

export const question = {
  id: "private-serial-suffix",
  prompt: "What are the last four digits of the lens serial inside the pouch?",
  helper: "This answer is compared privately with staff evidence. It is never added to the public listing.",
};

export const initialEvents = [
  { id: "evt-001", time: "09:41:06", label: "Intake received", detail: "Northport Air · Counter B", actor: "M. Chen" },
  { id: "evt-002", time: "09:41:09", label: "Safety screen passed", detail: "Ordinary intake allowed", actor: "Policy v1.4" },
  { id: "evt-003", time: "09:41:22", label: "Evidence structured", detail: "Gemini 3.5 Flash · ADK run 88F2", actor: "Case Analyst" },
  { id: "evt-004", time: "09:41:28", label: "Three custodians searched", detail: "8 candidates → 2 plausible", actor: "Case Analyst" },
  { id: "evt-005", time: "09:41:30", label: "Visual-only acceptance refused", detail: "Private discriminator required", actor: "Policy v1.4" },
];

export const stateSteps = [
  { key: "FOUND", label: "FOUND" },
  { key: "CANDIDATE", label: "CANDIDATE" },
  { key: "CLAIM_EVIDENCE_ACCEPTED", label: "EVIDENCE" },
  { key: "IDENTITY_ATTESTED", label: "IDENTITY" },
  { key: "RESERVED", label: "RESERVED" },
  { key: "RELEASED", label: "RELEASED" },
];

export const stateRank = {
  RECEIVED: 0,
  EVIDENCE_READY: 0,
  ANALYZING: 0,
  CANDIDATES_READY: 1,
  CLARIFICATION_REQUIRED: 1,
  CLAIM_EVIDENCE_ACCEPTED: 2,
  IDENTITY_ATTESTED: 3,
  APPROVAL_REQUIRED: 3,
  RESERVE_REQUESTED: 3,
  RESERVED: 4,
  CLAIMANT_PRESENT: 4,
  RELEASE_REQUESTED: 4,
  RELEASED: 5,
  CLOSED: 5,
};

export const privacyCopy = {
  publicDescription: "Small black nylon camera pouch with two zipper pulls.",
  restrictedDescription: "Orange inner stitching; serial suffix stored separately.",
};
