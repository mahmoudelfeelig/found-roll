import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowSquareOut,
  ArrowsClockwise,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  CloudCheck,
  Eye,
  Files,
  FolderOpen,
  FolderSimple,
  HardDrives,
  IdentificationCard,
  ImageSquare,
  Link,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Note,
  Plus,
  Printer,
  QrCode,
  SealCheck,
  ShareNetwork,
  ShieldCheck,
  SquaresFour,
  UploadSimple,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { ToolButton, WindowChrome } from "./Chrome.jsx";
import { localSafetyGuidance } from "../safetyGuidance.js";
import { claimantProofUrl } from "../surfaceAccess.js";
import { identityReleaseGate } from "../staffWorkflow.js";
import { downloadManifest } from "../manifestExport.js";
import { resolveWorkspaceMedia } from "../workspaceMedia.js";
import {
  comparison,
  evidenceTags,
  question,
  stateRank,
  stateSteps,
  trayItems,
} from "../demoData.js";

function Toolbar({ onImport }) {
  return (
    <div className="main-toolbar">
      <button className="import-button" type="button" onClick={onImport}><UploadSimple size={18} weight="bold" /> Import Intake <CaretDown size={12} weight="fill" /></button>
      <span className="toolbar-separator" />
      <div className="icon-cluster">
        <ToolButton icon={FolderOpen} label="Folders (current workspace)" quiet active disabled />
        <ToolButton icon={Files} label="Albums (not available in this sample)" quiet disabled />
      </div>
      <span className="toolbar-separator" />
      <div className="icon-cluster">
        <ToolButton icon={SquaresFour} label="Thumbnail view (current workspace)" quiet active disabled />
        <ToolButton icon={ListBullets} label="List view (not available in this sample)" quiet disabled />
        <ToolButton icon={ShareNetwork} label="Share case (staff workflow only)" quiet disabled />
      </div>
      <span className="toolbar-separator" />
      <div className="filter-group"><strong>Filters:</strong><span className="filter-chip"><ImageSquare size={15} weight="fill" /> All</span><span className="filter-chip"><LockKey size={14} /> Restricted</span></div>
      <label className="search-box">
        <input aria-label="Search is unavailable in this sample workspace" placeholder="Search is unavailable in this sample" disabled />
        <MagnifyingGlass size={17} weight="bold" />
      </label>
    </div>
  );
}

function OperatorTokenControl({ demoLoaded, staffLoaded, supervisorLoaded, configure, connection }) {
  const [demoDraft, setDemoDraft] = useState("");
  const [staffDraft, setStaffDraft] = useState("");
  const [supervisorDraft, setSupervisorDraft] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    await configure({ demoToken: demoDraft, staffToken: staffDraft, supervisorToken: supervisorDraft });
    setDemoDraft("");
    setStaffDraft("");
    setSupervisorDraft("");
  };
  return (
    <form className="operator-token-strip" onSubmit={submit}>
      <LockKey size={14} weight="fill" />
      <strong>Connected demo mutations</strong>
      <span>{demoLoaded && staffLoaded && supervisorLoaded ? "Operator, staff, and supervisor credentials loaded in memory" : "Separate runtime role credentials required for the full custody flow"}</span>
      <input
        type="password"
        value={demoDraft}
        onChange={(event) => setDemoDraft(event.target.value)}
        placeholder="Operator demo token"
        aria-label="Operator demo access token"
        autoComplete="off"
        spellCheck="false"
        disabled={connection.status === "offline"}
      />
      <input
        type="password"
        value={staffDraft}
        onChange={(event) => setStaffDraft(event.target.value)}
        placeholder="Staff evidence token"
        aria-label="Staff evidence access token"
        autoComplete="off"
        spellCheck="false"
        disabled={connection.status === "offline"}
      />
      <input
        type="password"
        value={supervisorDraft}
        onChange={(event) => setSupervisorDraft(event.target.value)}
        placeholder="Supervisor approval token"
        aria-label="Supervisor approval access token"
        autoComplete="off"
        spellCheck="false"
        disabled={connection.status === "offline"}
      />
      <button type="submit" disabled={!demoDraft || !staffDraft || !supervisorDraft || connection.status === "offline"}>Load for this tab</button>
      {(demoLoaded || staffLoaded || supervisorLoaded) && <button type="button" onClick={() => void configure({})}>Clear</button>}
      <small>Role credentials stay only in this tab. Staff cannot self-approve; admin reset authority is never accepted by the browser.</small>
    </form>
  );
}

function FolderTree({ activeFolder, onSelectFolder, custodianRows }) {
  return (
    <aside className="folder-pane">
      <section>
        <h2>FOLDERS <span>(connected custodians)</span></h2>
        {custodianRows.map((custodian, index) => (
          <div className="custodian" key={custodian.id}>
            <div className="tree-row custodian-row">
              <CaretDown size={12} weight="fill" />
              <FolderOpen size={18} weight="fill" className="folder-icon" />
              <span>{custodian.name}</span>
              <i className="sync-dot" title={`Synced ${custodian.synced}`}></i>
            </div>
            {custodian.folders.map((folder) => (
              <button
                className={`tree-row folder-row${activeFolder === `${custodian.id}|${folder.label}` ? " selected" : ""}`}
                type="button"
                key={`${custodian.id}-${folder.label}`}
                onClick={() => onSelectFolder(`${custodian.id}|${folder.label}`)}
              >
                <span className="tree-indent" />
                <FolderSimple size={16} weight="fill" className="folder-icon" />
                <span>{folder.label} ({folder.count})</span>
              </button>
            ))}
            {index === 0 && <div className="tree-meta">{custodian.kind} · synced {custodian.synced}</div>}
          </div>
        ))}
      </section>
      <section className="album-section">
        <h2>ALBUMS <span>(logical groups)</span></h2>
        <button className="tree-row album-row" type="button"><WarningCircle className="album-icon amber" size={16} weight="fill" /><span>Needs Review</span><b>14</b></button>
        <button className="tree-row album-row selected" type="button"><Link className="album-icon blue" size={16} weight="bold" /><span>Candidate Pairs</span><b>6</b></button>
        <button className="tree-row album-row" type="button"><LockKey className="album-icon gray" size={16} weight="fill" /><span>Private Questions</span><b>3</b></button>
        <button className="tree-row album-row" type="button"><CheckCircle className="album-icon green" size={16} weight="fill" /><span>Evidence Accepted</span><b>8</b></button>
        <button className="tree-row album-row" type="button"><Archive className="album-icon orange" size={16} weight="fill" /><span>Reserved</span><b>2</b></button>
        <button className="tree-row album-row" type="button"><SealCheck className="album-icon gray" size={16} weight="fill" /><span>Released (closed)</span><b>23</b></button>
        <button className="tree-row album-row" type="button"><XCircle className="album-icon red" size={16} weight="fill" /><span>No Match / Unable</span><b>7</b></button>
      </section>
      <section className="quick-filter">
        <h2>QUICK FILTER</h2>
        <button className="tree-row" type="button"><Camera size={16} /><span>Has restricted detail</span><b>4</b></button>
        <button className="tree-row" type="button"><Note size={16} /><span>Has staff note</span><b>19</b></button>
        <button className="tree-row" type="button"><ArrowsClockwise size={16} /><span>Needs sync</span><b>0</b></button>
      </section>
    </aside>
  );
}

function ThumbnailLibrary({ activeFolder, selectedItemId, onSelectItem, onSelectFolder, custodianRows, items: workspaceItems, fixture }) {
  const [custodianId, dateLabel] = activeFolder.split("|");
  const custodian = custodianRows.find((item) => item.id === custodianId) || custodianRows[0];
  const items = workspaceItems.filter((item) => item.custodianId === custodian.id && item.dateLabel === dateLabel);
  return (
    <section className="library-strip">
      <header className="section-ridge">
        <div><CaretDown size={13} weight="fill" /><strong>{dateLabel} — {custodian.name}</strong></div>
        <span>{items.length} item{items.length === 1 ? "" : "s"}</span>
      </header>
      <div className="thumbnail-row">
        {items.map((item) => (
          <button className={`library-thumb thumb-selector${selectedItemId === item.id ? " selected" : ""}`} type="button" onClick={() => onSelectItem(item.id)} key={item.id}>
            <div className="thumb-image"><img src={item.src} alt={item.label} /></div>
            {selectedItemId === item.id && <Check className="selection-check" size={15} weight="bold" />}
            <span className="thumb-caption">{item.filename}</span>
          </button>
        ))}
        {!items.length && <p className="empty-folder-note">{fixture ? "No synthetic intake photos in this folder." : "No staff-authorized preview is loaded in this tab."}</p>}
      </div>
      {custodianRows.filter((item) => item.id !== custodian.id).map((item) => {
        const folder = item.folders[0];
        return (
          <button type="button" className="collapsed-ridge" onClick={() => folder && onSelectFolder(`${item.id}|${folder.label}`)} disabled={!folder} key={item.id}>
            <span><CaretRight size={13} weight="fill" /> {folder?.label || "No case media loaded"} — {item.name}</span>
            <b>{workspaceItems.filter((row) => row.custodianId === item.id).length} items</b>
          </button>
        );
      })}
    </section>
  );
}

function PhotoPanel({ photo, accent = false }) {
  return (
    <article className={`photo-panel${accent ? " accent" : ""}`}>
      <header><strong>{photo.filename}</strong><span>{photo.view}</span></header>
      <div className="large-photo"><img src={photo.src} alt={photo.view} /></div>
      <footer>
        <div className="photo-tools">
          <ToolButton icon={MagnifyingGlass} label="Zoom" quiet />
          <ToolButton icon={ArrowsClockwise} label="Rotate" quiet />
          <ToolButton icon={Eye} label="Inspect" quiet />
          <ToolButton icon={Printer} label="Print" quiet />
        </div>
        <span>{photo.dimensions}</span><span>{photo.size}</span>
      </footer>
    </article>
  );
}

function MediaUnavailable({ title, children, icon: Icon = ImageSquare }) {
  return (
    <article className="media-unavailable">
      <Icon size={35} weight="duotone" />
      <strong>{title}</strong>
      <p>{children}</p>
    </article>
  );
}

function CompareStage({ selectedItemId, items, fixture, demo }) {
  const selected = items.find((item) => item.id === selectedItemId) || items[0];
  if (!fixture) {
    return (
      <section className="compare-stage imported-compare-stage">
        {selected ? <PhotoPanel photo={{
          filename: selected.filename,
          view: selected.view,
          src: selected.src,
          dimensions: selected.dimensions,
          size: selected.size,
        }} /> : <MediaUnavailable title="Preview unavailable">Reload staff authorization or import evidence for this case. Unrelated fixture imagery is never substituted.</MediaUnavailable>}
        <MediaUnavailable title={`${demo.candidates?.length || 0} candidate records`} icon={MagnifyingGlass}>Candidate metadata was returned by the bounded search. Remote custodian photo bytes are not copied into this browser view.</MediaUnavailable>
        <MediaUnavailable title="Private detail remains restricted" icon={LockKey}>The claimant question is derived from staff-only evidence. The expected value is not sent to the model, claimant, or this comparison panel.</MediaUnavailable>
      </section>
    );
  }
  const primary = {
    filename: selected.filename,
    view: selected.label,
    src: selected.src,
    dimensions: "1600×1200",
    size: "synthetic fixture",
  };
  return (
    <section className="compare-stage">
      <PhotoPanel photo={primary} />
      <PhotoPanel photo={comparison.secondary} accent />
      <MediaUnavailable title="Restricted staff detail" icon={LockKey}>This read-only sample never loads restricted evidence. A protected staff session can inspect only the current workflow epoch.</MediaUnavailable>
    </section>
  );
}

function PhotoTray({ items, fixture, demo }) {
  const visibleItems = fixture ? trayItems : items;
  return (
    <section className="photo-tray">
      <header>PHOTO TRAY <span>(selected item & related evidence)</span></header>
      <div className="tray-content">
        <span className="tray-arrow" aria-hidden="true"><CaretLeft size={20} weight="bold" /></span>
        {visibleItems.map((item) => item.transcript ? (
          <article className="tray-note" key={item.id}>
            <div className="note-wave" aria-hidden="true">▥▥▤▥▥▤▥▤▥▥▤▥</div>
            <strong>{item.label}</strong>
            <p>“{item.transcript}”</p>
          </article>
        ) : (
          <figure className={`tray-photo${item.selected ? " selected" : ""}`} key={item.id}>
            <div className="tray-image"><img src={item.src} alt={item.label} className={item.blurred ? "privacy-blur" : ""} /></div>
            {item.restricted && <LockKey className="tray-lock" size={13} weight="fill" />}
            <figcaption>{item.label}</figcaption>
          </figure>
        ))}
        {!visibleItems.length && <p className="empty-tray-note">No staff-authorized evidence bytes are loaded for case {demo.caseId}.</p>}
        {!fixture && visibleItems.length > 0 && <article className="tray-note"><strong>Imported intake</strong><p>{demo.authoritativeCase?.public_description || "Staff evidence accepted for bounded analysis."}</p></article>}
        <span className="tray-arrow" aria-hidden="true"><CaretRight size={20} weight="bold" /></span>
      </div>
    </section>
  );
}

function StatusBadge({ state }) {
  const labels = {
    RECEIVED: "INTAKE RECEIVED",
    EVIDENCE_READY: "EVIDENCE READY",
    ANALYZING: "ANALYZING",
    CANDIDATES_READY: "CANDIDATES READY",
    CLARIFICATION_REQUIRED: "PRIVATE EVIDENCE NEEDED",
    CLAIM_EVIDENCE_ACCEPTED: "EVIDENCE ACCEPTED",
    APPROVAL_REQUIRED: "APPROVAL REQUIRED",
    IDENTITY_ATTESTED: "IDENTITY ATTESTED",
    RESERVE_REQUESTED: "RESERVATION READY",
    RESERVED: "RESERVED",
    CLAIMANT_PRESENT: "ATTESTATION IN PROGRESS",
    RELEASE_REQUESTED: "RELEASE REQUESTED",
    RELEASED: "RELEASED",
    CLOSED: "CLOSED",
    MANUAL_REVIEW: "MANUAL REVIEW",
  };
  return <span className={`state-badge state-${state.toLowerCase()}`}>{labels[state] || state.replaceAll("_", " ")}</span>;
}

function StateTrack({ state }) {
  const rank = stateRank[state] ?? 1;
  return (
    <div className="state-track">
      <div className="state-line" aria-hidden="true"><i style={{ width: `${Math.max(0, (rank / (stateSteps.length - 1)) * 100)}%` }} /></div>
      {stateSteps.map((step, index) => (
        <div className={`state-step${index < rank ? " complete" : index === rank ? " current" : ""}`} key={step.key}>
          <i>{index < rank ? <Check size={11} weight="bold" /> : ""}</i>
          <span>{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function MiniCredential({ role, token, expiresAt }) {
  const label = role === "claimant" ? "Claimant Credential" : "Staff Credential";
  return (
    <div className="mini-credential">
      <div>
        <strong>{label}</strong>
        <p>Status: <b className={token.status === "USED" ? "green-text" : token.status === "ISSUED" ? "orange-text" : "gray-text"}>{token.status.replace("_", " ")}</b></p>
        <small>{token.status === "NOT_ISSUED" ? "Issued only after reservation" : expiresAt ? `One-time use · expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "One-time use · service expiry unavailable"}</small>
      </div>
      <div className="mini-qr">{token.status === "NOT_ISSUED" || !token.value ? <LockKey size={29} /> : <QRCodeSVG value={token.value} size={55} level="M" />}</div>
    </div>
  );
}

function CaseInspector({ demo }) {
  const accepted = demo.authoritativeCase?.accepted_claim_evidence ?? false;
  const reserved = Boolean(demo.handoff && ["HELD", "RELEASED"].includes(demo.handoff.status));
  const selectedCandidate = demo.candidates?.find((candidate) => candidate.id === demo.authoritativeCase?.selected_item_id) || demo.candidates?.[0];
  const candidateScore = selectedCandidate?.frozen_score == null ? null : Math.round(selectedCandidate.frozen_score * 100);
  const proofQuestion = demo.authoritativeCase?.next_question || question.prompt;
  return (
    <aside className="inspector-pane">
      <header className="inspector-heading">
        <span>Match Case: {demo.caseId}</span>
        <StatusBadge state={demo.state} />
      </header>
      <section className="inspector-section">
        <h3>Evidence Tags</h3>
        <div className="tag-cloud">{evidenceTags.map((tag) => <span key={tag}>{tag}</span>)}<button type="button" aria-label="Add evidence tag"><Plus size={13} /></button></div>
      </section>
      <section className="inspector-section similarity">
        <h3>Candidate Match <span>(best candidate)</span></h3>
        <div className={accepted ? "decision accepted" : "decision insufficient"}>
          {accepted ? <CheckCircle size={19} weight="fill" /> : <ShieldCheck size={19} weight="fill" />}
          <strong>{accepted ? "Policy evidence accepted" : `${candidateScore ?? "No score"}${candidateScore == null ? "" : "%"} — Insufficient`}</strong>
        </div>
        <p>{accepted ? "Hard filters, two visible signals, and the private serial suffix agree." : "Visual evidence alone is never enough to accept a claim."}</p>
      </section>
      <section className="inspector-section question-summary">
        <h3>Private Question <span>(asked 10:08 AM)</span></h3>
        <dl><dt>Q:</dt><dd>{proofQuestion}</dd><dt>A:</dt><dd className={accepted ? "private-answer" : "pending-answer"}>{accepted ? "•••• (matched privately)" : "Waiting for claimant"}</dd></dl>
        <p className={accepted ? "match-note" : "wait-note"}>{accepted ? <CheckCircle size={16} weight="fill" /> : <Clock size={16} weight="fill" />}{accepted ? " Matches restricted staff evidence" : demo.claimLink?.expiresAt ? ` Scoped link expires ${new Date(demo.claimLink.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " Scoped proof link not issued"}</p>
      </section>
      <section className="inspector-section reservation-summary">
        <h3>Relay Reservation</h3>
        <div className={`reservation-state${reserved ? " reserved" : ""}`}><LockKey size={17} weight="fill" /><strong>{reserved ? "Post 12 — Reserved" : "Not yet reserved"}</strong></div>
        <p>{reserved ? `${demo.reservation.provider} · service-attested hold` : "Requires accepted evidence, identity attestation, and staff approval."}</p>
        {reserved && <div className="expiry-meter"><i /><span>{demo.reservation.expiresAt ? `Expires ${new Date(demo.reservation.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Expiry supplied by relay"}</span></div>}
      </section>
      <section className="inspector-section credentials">
        <MiniCredential role="claimant" token={demo.claimantToken} expiresAt={demo.reservation?.expiresAt} />
        <MiniCredential role="custodian" token={demo.custodianToken} expiresAt={demo.reservation?.expiresAt} />
      </section>
      <section className="inspector-section custody-state">
        <h3>Custody State</h3>
        <StateTrack state={demo.state} />
        <p>Current: <strong>{demo.state.replaceAll("_", " ")}</strong></p>
        <small>{demo.state === "CLOSED" ? "Service event manifest is internally consistent." : "Release work remains policy-bound; Gemini cannot mutate this state."}</small>
        {demo.authoritativeCase?.analysis_auto_start_armed && <small>Server queue armed after an authorized preview.</small>}
      </section>
    </aside>
  );
}

function IntakeDialog({ open, onClose, dispatch, busy, credentialsReady }) {
  const dialogRef = useRef(null);
  const fileInputRef = useRef(null);
  const previousCredentialsReady = useRef(credentialsReady);
  const [foundAt, setFoundAt] = useState(() => new Date().toISOString());
  const [draftStarted, setDraftStarted] = useState(false);
  const [safety, setSafety] = useState("ORDINARY_ITEM");
  const [sensitiveCategory, setSensitiveCategory] = useState("passport");
  const [sourceMode, setSourceMode] = useState("synthetic");
  const [assignedTenant, setAssignedTenant] = useState("northport-air");
  const [category, setCategory] = useState("camera_pouch");
  const [riskTier, setRiskTier] = useState("VALUABLE");
  const [foundZone, setFoundZone] = useState("Terminal C security return");
  const [reportRoute, setReportRoute] = useState("Grand Hall, Metro Loop Blue Line, Northport Air Terminal C");
  const [publicDescription, setPublicDescription] = useState("Black padded camera pouch with two zipper pulls and a repaired corner seam.");
  const [file, setFile] = useState(null);
  const [authorizePreviewForModel, setAuthorizePreviewForModel] = useState(true);
  const [formError, setFormError] = useState("");

  const clearFileDraft = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resetDraft = () => {
    setFoundAt(new Date().toISOString());
    setDraftStarted(false);
    setSafety("ORDINARY_ITEM");
    setSensitiveCategory("passport");
    setSourceMode("synthetic");
    setAssignedTenant("northport-air");
    setCategory("camera_pouch");
    setRiskTier("VALUABLE");
    setFoundZone("Terminal C security return");
    setReportRoute("Grand Hall, Metro Loop Blue Line, Northport Air Terminal C");
    setPublicDescription("Black padded camera pouch with two zipper pulls and a repaired corner seam.");
    clearFileDraft();
    setAuthorizePreviewForModel(true);
    setFormError("");
  };

  const selectSafety = (nextSafety) => {
    setSafety(nextSafety);
    if (nextSafety !== "ORDINARY_ITEM") {
      clearFileDraft();
      setAuthorizePreviewForModel(false);
    }
  };

  useEffect(() => {
    if (open && !draftStarted) {
      setFoundAt(new Date().toISOString());
      setDraftStarted(true);
    }
  }, [open, draftStarted]);

  useEffect(() => {
    if (previousCredentialsReady.current && !credentialsReady) resetDraft();
    previousCredentialsReady.current = credentialsReady;
  }, [credentialsReady]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const closeDialog = () => dialogRef.current?.close();
  const handleNativeClose = () => {
    resetDraft();
    onClose();
  };
  const trapDialogFocus = (event) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0);
    if (!focusable.length) return;
    const activeIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex >= focusable.length - 1 ? 0 : activeIndex + 1;
    event.preventDefault();
    focusable[nextIndex].focus();
  };

  const intakeStopped = safety !== "ORDINARY_ITEM";
  const guidanceCategory = safety === "SUSPICIOUS_OR_DANGEROUS" ? "suspicious_package" : sensitiveCategory;
  const safetyGuidance = localSafetyGuidance(guidanceCategory, assignedTenant);

  const submit = async (event) => {
    event.preventDefault();
    setFormError("");
    if (safety !== "ORDINARY_ITEM") return;
    if (sourceMode === "upload" && !file) {
      setFormError("Choose a JPEG or PNG before continuing.");
      return;
    }
    if (!authorizePreviewForModel) {
      setFormError("Confirm the derived-preview permission before the service queues bounded candidate analysis.");
      return;
    }
    const holders = {
      "northport-air": "Northport Air secure dropbox",
      "metro-loop": "Metro Loop central property desk",
      "grand-hall": "Grand Hall venue office",
    };
    const accepted = await dispatch({
      type: "IMPORT_INTAKE",
      intake: {
        assignedTenant,
        category,
        riskTier,
        currentHolder: holders[assignedTenant],
        publicDescription,
        foundAt,
        foundZone,
        reportRoute: reportRoute.split(",").map((part) => part.trim()).filter(Boolean),
        authorizePreviewForModel,
        useSyntheticFixture: sourceMode === "synthetic",
        file: sourceMode === "upload" ? file : null,
      },
    });
    if (accepted) {
      closeDialog();
    }
  };

  return (
      <dialog ref={dialogRef} className="intake-dialog" aria-labelledby="intake-title" onClose={handleNativeClose} onKeyDown={trapDialogFocus}>
        <header><div><UploadSimple size={20} weight="bold" /><span id="intake-title">Import Intake</span></div><button type="button" onClick={closeDialog} aria-label="Close intake"><XCircle size={21} /></button></header>
        <form onSubmit={submit}>
          <fieldset className="safety-screen">
            <legend>Local safety screen — before photo upload</legend>
            <label className={safety === "ORDINARY_ITEM" ? "selected" : ""}><input type="radio" name="safety" value="ORDINARY_ITEM" checked={safety === "ORDINARY_ITEM"} onChange={(event) => selectSafety(event.target.value)} /><ShieldCheck size={22} weight="fill" /><span><strong>Ordinary lost item</strong><small>Continue to a bounded synthetic recovery intake.</small></span></label>
            <label className={safety === "SENSITIVE_OR_REGULATED" ? "selected" : ""}><input type="radio" name="safety" value="SENSITIVE_OR_REGULATED" checked={safety === "SENSITIVE_OR_REGULATED"} onChange={(event) => selectSafety(event.target.value)} /><IdentificationCard size={22} weight="fill" /><span><strong>Sensitive or regulated</strong><small>Route locally without photographing or modeling.</small></span></label>
            <label className={safety === "SUSPICIOUS_OR_DANGEROUS" ? "selected danger" : ""}><input type="radio" name="safety" value="SUSPICIOUS_OR_DANGEROUS" checked={safety === "SUSPICIOUS_OR_DANGEROUS"} onChange={(event) => selectSafety(event.target.value)} /><WarningCircle size={22} weight="fill" /><span><strong>Suspicious or dangerous</strong><small>Stop locally. Do not photograph, move, or upload.</small></span></label>
          </fieldset>

          {intakeStopped ? (
            <>{safety === "SENSITIVE_OR_REGULATED" && <label className="sensitive-category">Category<select value={sensitiveCategory} onChange={(event) => setSensitiveCategory(event.target.value)}><option value="passport">Passport or government ID</option><option value="payment_card">Payment card</option><option value="access_badge">Access badge</option><option value="medication">Medication</option></select></label>}<section className="local-safety-stop" role="alert"><WarningCircle size={34} weight="fill" /><div><strong>Intake stopped before any network request</strong><p>{safetyGuidance.action}</p><small>{safetyGuidance.retention}</small></div></section></>
          ) : (
            <div className="intake-fields">
              <label>Custodian<select value={assignedTenant} onChange={(event) => setAssignedTenant(event.target.value)}><option value="northport-air">Northport Air</option><option value="metro-loop">Metro Loop</option><option value="grand-hall">Grand Hall</option></select></label>
              <label>Item category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="camera_pouch">Camera pouch</option><option value="camera">Camera</option><option value="phone">Phone</option><option value="laptop">Laptop</option><option value="tablet">Tablet</option><option value="headphones">Headphones</option><option value="bag">Bag</option><option value="backpack">Backpack</option><option value="umbrella">Umbrella</option><option value="clothing">Clothing</option><option value="book">Book</option><option value="keys">Keys</option></select></label>
              <label>Release tier<select value={riskTier} onChange={(event) => setRiskTier(event.target.value)}><option value="STANDARD">Standard item</option><option value="VALUABLE">Valuable item</option></select></label>
              <label>Found zone<input value={foundZone} onChange={(event) => setFoundZone(event.target.value)} minLength="2" maxLength="120" required /></label>
              <label className="wide-field">Reported route<input value={reportRoute} onChange={(event) => setReportRoute(event.target.value)} minLength="2" maxLength="240" required /></label>
              <label className="wide-field">Public description<textarea value={publicDescription} onChange={(event) => setPublicDescription(event.target.value)} minLength="8" maxLength="500" required /></label>
              <fieldset className="source-choice wide-field"><legend>Evidence source</legend><label><input type="radio" name="source" checked={sourceMode === "synthetic"} onChange={() => { clearFileDraft(); setSourceMode("synthetic"); setAuthorizePreviewForModel(true); }} /> Use owned synthetic camera-pouch fixture</label><label><input type="radio" name="source" checked={sourceMode === "upload"} onChange={() => { setSourceMode("upload"); setAuthorizePreviewForModel(false); }} /> Choose a JPEG or PNG</label>{sourceMode === "upload" && <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" onChange={(event) => setFile(event.target.files?.[0] || null)} />}</fieldset>
              <label className="model-preview-consent wide-field"><input type="checkbox" checked={authorizePreviewForModel} onChange={(event) => setAuthorizePreviewForModel(event.target.checked)} /><span><strong>Create a metadata-stripped derivative for bounded model analysis</strong><small>The original remains staff-only. Gemini receives only the derived preview after this explicit permission.</small></span></label>
              {!credentialsReady && <p className="credential-warning wide-field"><LockKey size={15} weight="fill" /> Load both runtime credentials above. The image upload uses the separate staff evidence boundary.</p>}
              {formError && <p className="form-error wide-field">{formError}</p>}
            </div>
          )}

          <footer><button type="button" className="secondary-action" onClick={closeDialog}>{intakeStopped ? "Acknowledge safety stop" : "Cancel"}</button>{safety === "ORDINARY_ITEM" && <button type="submit" className="primary-action" disabled={busy || !credentialsReady}>{busy ? "Importing…" : "Create passport & queue analysis"}</button>}</footer>
        </form>
      </dialog>
  );
}

function BottomActions({ demo, dispatch, setView, busy, operatorTokenLoaded, staffTokenLoaded, supervisorTokenLoaded, onImport }) {
  const buttons = [];
  const releaseGate = identityReleaseGate({
    state: demo.state,
    riskTier: demo.authoritativeCase?.risk_tier,
    approvalRecorded: Boolean(demo.approval),
  });
  if (["RECEIVED", "EVIDENCE_READY"].includes(demo.state)) {
    if (demo.authoritativeCase?.analysis_auto_start_armed) {
      buttons.push({
        label: demo.state === "RECEIVED" ? "Await Authorized Preview" : "Refresh Service State",
        icon: ArrowsClockwise,
        action: () => dispatch({ type: "REFRESH" }),
      });
    } else {
      buttons.push({ label: "Start Bounded Analysis", icon: ArrowsClockwise, action: () => dispatch({ type: "ANALYZE" }), requiresToken: true });
    }
  }
  else if (["ANALYZING", "CANDIDATES_READY"].includes(demo.state)) buttons.push({ label: "Refresh Service State", icon: ArrowsClockwise, action: () => dispatch({ type: "REFRESH" }) });
  else if (demo.state === "CLARIFICATION_REQUIRED") buttons.push({
    label: demo.claimLink?.available ? "Open Separate Claimant Link" : "Issue & Open Separate Claimant Link",
    icon: ArrowSquareOut,
    action: async () => {
      const pendingWindow = window.open("", "_blank");
      if (!pendingWindow) return;
      pendingWindow.opener = null;
      let projection = demo;
      if (!demo.claimLink?.available) {
        projection = await dispatch({ type: "OPEN_CLAIMANT_PROOF" });
      }
      if (!projection?.claimLink?.value) {
        pendingWindow?.close();
        return;
      }
      const url = claimantProofUrl(window.location.href, projection.caseId, projection.claimLink.value);
      pendingWindow.location.replace(url);
    },
    requiresToken: !demo.claimLink?.available,
    requiresCredential: demo.claimLink?.available ? undefined : "staff",
  });
  else if (demo.state === "CLAIM_EVIDENCE_ACCEPTED") buttons.push({ label: "Record Identity Attestation", icon: IdentificationCard, action: () => dispatch({ type: "ATTEST_IDENTITY" }), requiresCredential: "staff" });
  else if (releaseGate === "SUPERVISOR_APPROVAL") buttons.push({ label: "Approve Valuable Item", icon: SealCheck, action: () => dispatch({ type: "APPROVE" }), requiresCredential: "supervisor" });
  else if (releaseGate === "RESERVE") buttons.push({ label: "Reserve SIMULATED Relay", icon: LockKey, action: () => dispatch({ type: "RESERVE" }), requiresToken: true });
  else if (["RESERVED", "CLAIMANT_PRESENT"].includes(demo.state)) buttons.push({ label: "Open Relay Terminal", icon: QrCode, action: () => setView("relay") });
  else if (demo.state === "CLOSED") buttons.push({ label: "View Custody Evidence", icon: ShieldCheck, action: () => document.getElementById("event-playback")?.showModal() });
  return (
    <div className="bottom-actionbar">
      <ToolButton icon={UploadSimple} label="Import Intake" onClick={onImport} />
      <ToolButton icon={Link} label="Add to Claim" />
      <ToolButton icon={Files} label="Compare" active />
      <ToolButton icon={LockKey} label="Private Question" />
      <ToolButton icon={Archive} label="Reserve Relay" disabled={(stateRank[demo.state] ?? 0) < 3} />
      {demo.state === "CLOSED" && <ToolButton icon={Printer} label="Export Manifest" onClick={() => downloadManifest(demo)} />}
      <span className="action-spacer" />
      {buttons.map(({ label, icon: Icon, action, requiresToken, requiresCredential }) => {
        const roleReady = !requiresCredential || (requiresCredential === "staff" ? staffTokenLoaded : supervisorTokenLoaded);
        const operatorReady = !requiresToken || operatorTokenLoaded;
        const locked = !roleReady || !operatorReady;
        const missingCredentials = [!operatorReady && "operator demo", !roleReady && `${requiresCredential} role`].filter(Boolean).join(" and ");
        return <span className="primary-action-group" key={label}><button className="primary-action" type="button" onClick={action} disabled={busy || locked} title={locked ? `Load the ${missingCredentials} credential${missingCredentials.includes(" and ") ? "s" : ""} above` : undefined}><Icon size={20} weight="bold" />{label}</button>{locked && <small className="action-lock-reason">Read-only until {missingCredentials} role{missingCredentials.includes(" and ") ? "s are" : " is"} loaded.</small>}</span>;
      })}
    </div>
  );
}

function EventDialog({ demo }) {
  return (
    <dialog className="event-dialog" id="event-playback">
      <header><div><ShieldCheck size={22} weight="fill" /><span>Item Passport — {demo.caseId}</span></div><button type="button" onClick={() => document.getElementById("event-playback")?.close()} aria-label="Close"><XCircle size={22} /></button></header>
      <div className="manifest-summary"><strong>Service event manifest</strong><span>{demo.events.length} hash-linked application events · case version {demo.version}</span><small>Internally consistent record; not independent proof of a physical transfer.</small></div>
      <ol className="event-list">
        {demo.events.map((event) => <li key={event.id}><time>{event.time}</time><i></i><div><strong>{event.label}</strong><span>{event.detail}</span><small>{event.actor} · {event.id}</small></div></li>)}
      </ol>
      <footer><button type="button" className="secondary-action" onClick={() => downloadManifest(demo)}><Printer size={17} /> Export JSON manifest</button><button type="button" className="primary-action" onClick={() => document.getElementById("event-playback")?.close()}>Done</button></footer>
    </dialog>
  );
}

export function StaffWorkspace({ demo, dispatch, view, setView, connection, busy, operatorTokenLoaded, staffTokenLoaded, supervisorTokenLoaded, configureRuntimeCredentials }) {
  const media = resolveWorkspaceMedia(demo);
  const [activeFolder, setActiveFolder] = useState(media.defaultFolder);
  const [selectedItemId, setSelectedItemId] = useState(media.defaultSelectedItemId);
  const [intakeOpen, setIntakeOpen] = useState(false);
  useEffect(() => {
    setActiveFolder(media.defaultFolder);
    setSelectedItemId(media.defaultSelectedItemId);
  }, [demo.caseId, demo.intakeEvidence?.id]);
  return (
    <div className="staff-workspace">
      <div className="sr-only" aria-live="polite">{demo.lastNotice}</div>
      <WindowChrome view={view} setView={setView} onRefresh={() => dispatch({ type: "REFRESH" })} onSignOut={() => void configureRuntimeCredentials({})} busy={busy} />
      <div className="staff-narrow-notice" role="status">The staff workspace is optimized for a 1120px+ workstation. Use a wider screen for the protected live workflow.</div>
      <Toolbar onImport={() => setIntakeOpen(true)} />
      <OperatorTokenControl demoLoaded={operatorTokenLoaded} staffLoaded={staffTokenLoaded} supervisorLoaded={supervisorTokenLoaded} configure={configureRuntimeCredentials} connection={connection} />
      <main className="desktop-layout">
        <FolderTree activeFolder={activeFolder} onSelectFolder={setActiveFolder} custodianRows={media.custodians} />
        <div className="center-pane"><ThumbnailLibrary activeFolder={activeFolder} selectedItemId={selectedItemId} onSelectItem={setSelectedItemId} onSelectFolder={setActiveFolder} custodianRows={media.custodians} items={media.items} fixture={media.fixture} /><CompareStage selectedItemId={selectedItemId} items={media.items} fixture={media.fixture} demo={demo} /><PhotoTray items={media.trayItems} fixture={media.fixture} demo={demo} /></div>
        <CaseInspector demo={demo} />
      </main>
      <BottomActions demo={demo} dispatch={dispatch} setView={setView} busy={busy} operatorTokenLoaded={operatorTokenLoaded} staffTokenLoaded={staffTokenLoaded} supervisorTokenLoaded={supervisorTokenLoaded} onImport={() => setIntakeOpen(true)} />
      <div className="status-bar"><span className={`connection-${connection.status}`}><CloudCheck size={15} weight="fill" /> {connection.label}</span><span><HardDrives size={15} /> Case v{demo.version}</span><span><ShieldCheck size={15} /> Policy v1.4</span><span className="agent-status"><i></i> Case Analyst · Gemini 3.5 Flash / ADK boundary</span></div>
      <EventDialog demo={demo} />
      <IntakeDialog open={intakeOpen} onClose={() => setIntakeOpen(false)} dispatch={dispatch} busy={busy} credentialsReady={operatorTokenLoaded && staffTokenLoaded} />
    </div>
  );
}
