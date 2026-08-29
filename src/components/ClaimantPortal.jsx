import { useEffect, useState } from "react";
import {
  ArrowRight,
  CheckCircle,
  Info,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { WindowChrome } from "./Chrome.jsx";
import { privacyCopy, question } from "../demoData.js";

export function formatClaimLinkExpiry(expiresAt, now = Date.now()) {
  if (!expiresAt) return "No active proof link";
  const remainingSeconds = Math.ceil((new Date(expiresAt).getTime() - now) / 1000);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return "Proof link expired";
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `Link expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function ClaimantPortal({ demo, dispatch, view, setView, connection, busy, scope }) {
  const [answer, setAnswer] = useState("");
  const [now, setNow] = useState(Date.now());
  const claimantCase = demo.claimantCase || null;
  const custodyCase = claimantCase || demo.authoritativeCase || {};
  const accepted = demo.state === "CLAIM_EVIDENCE_ACCEPTED" || (demo.authoritativeCase?.accepted_claim_evidence ?? false);
  const locked = demo.state === "MANUAL_REVIEW";
  const connected = connection.status === "live" || connection.status === "fixture";
  const claimLinkExpiry = new Date(demo.claimLink?.expiresAt || "").getTime();
  const claimLinkFresh = Number.isFinite(claimLinkExpiry) && claimLinkExpiry > now;
  const canSubmit = connected && demo.claimLink?.available && claimLinkFresh && demo.state === "CLARIFICATION_REQUIRED";
  const staffPreview = scope === "staff";
  const expiryCopy = formatClaimLinkExpiry(demo.claimLink?.expiresAt, now);
  const proofQuestion = custodyCase.next_question || question.prompt;
  const publicDescription = custodyCase.public_description || privacyCopy.publicDescription;
  const foundRoute = custodyCase.route_label || custodyCase.report_route?.join(" to ") || "Participating custodians checked";
  const foundTime = custodyCase.found_date_label || (custodyCase.found_at
    ? new Date(custodyCase.found_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "Date withheld from this proof view");
  const currentCustodian = custodyCase.synthetic_custodian_label || custodyCase.current_holder || "Participating custodian (SIMULATED)";
  const hasFixtureClaimantPhoto = demo.caseId === "FR-20260829-0042";
  const unavailableHeading = !connected
    ? "Private proof is unavailable offline"
    : demo.claimLink?.available && !claimLinkFresh
      ? "This proof link has expired"
      : demo.claimLink?.available
        ? "Private proof is not expected yet"
        : "This proof link is missing or no longer active";
  const unavailableCopy = !connected
    ? "This read-only interface fixture does not contain the restricted answer and cannot accept or reject a claim."
    : demo.claimLink?.available && !claimLinkFresh
      ? "Ask the custodian for a fresh case-scoped link. The expired proof cannot be submitted."
      : demo.claimLink?.available
        ? `The authoritative custody state is ${demo.state.replaceAll("_", " ")}.`
        : "Ask the custodian for a fresh case-scoped link. Shared operator credentials cannot submit claimant evidence.";

  useEffect(() => {
    if (!demo.claimLink?.expiresAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [demo.claimLink?.expiresAt]);

  const submit = async (event) => {
    event.preventDefault();
    try {
      await dispatch({ type: "SUBMIT_CLAIM", answer });
    } finally {
      setAnswer("");
    }
  };

  return (
    <div className="claimant-shell">
      <div className="sr-only" aria-live="polite">{demo.lastNotice}</div>
      <WindowChrome view={view} setView={setView} onRefresh={() => {}} busy={busy} />
      <header className="claimant-brandbar">
        <div className="found-roll-mark"><span>found</span><b>roll</b></div>
        <span className="secure-note"><LockKey size={14} weight="fill" /> Secure claim proof</span>
      </header>
      <main className="claimant-page">
        <div className="claimant-card">
          <header className="classic-form-header">
            <div><h1>One private detail can resolve this match</h1><p>Case {demo.caseId}</p></div>
            <ShieldCheck size={52} weight="duotone" />
          </header>
          <div className="privacy-banner"><Info size={18} weight="fill" /><span>Northport Air, Metro Loop, and Grand Hall are fictional demo operators. Your answer is checked privately and is not added to the public listing.</span></div>
          <section className={`claim-summary${hasFixtureClaimantPhoto ? "" : " no-photo"}`}>
            {hasFixtureClaimantPhoto && <div className="claim-photo"><img src="/assets/claimant-match.jpg" alt="Claimant-supplied prior photo of the camera pouch" /></div>}
            <div>
              <span className="eyebrow">POSSIBLE MATCH</span>
              <h2>{publicDescription}</h2>
              <dl><dt>Reported route</dt><dd>{foundRoute}</dd><dt>Found at</dt><dd>{foundTime}</dd><dt>Current custodian</dt><dd>{currentCustodian}</dd></dl>
            </div>
          </section>
          {!accepted && !locked && canSubmit && (
            <form className="proof-form" onSubmit={submit}>
              <label htmlFor="private-answer">
                <span className="question-number">1</span>
                <span><strong>{proofQuestion}</strong><small>{custodyCase.next_question ? "Answer only the requested private detail. It is compared inside the custody service and never added to the public case." : question.helper}</small></span>
              </label>
              <div className="answer-row">
                <input id="private-answer" value={answer} onChange={(event) => setAnswer(event.target.value.slice(0, 64))} type="password" maxLength="64" placeholder="Private detail" autoComplete="off" spellCheck="false" required autoFocus disabled={busy} />
                <button type="submit" disabled={busy}>{busy ? "Checking…" : "Submit private answer"} <ArrowRight size={16} weight="bold" /></button>
              </div>
              <p className="attempt-note">{demo.answerAttempts ? `${demo.answerAttempts} unsuccessful attempt${demo.answerAttempts > 1 ? "s" : ""}. ` : ""}The value is sent only to the connected custody service and cleared from this page after submission.</p>
            </form>
          )}
          {!accepted && !locked && !canSubmit && (
            <section className="claim-result review">
              <WarningCircle size={42} weight="fill" />
              <div>
                <h2>{unavailableHeading}</h2>
                <p>{unavailableCopy}</p>
              </div>
            </section>
          )}
          {accepted && (
            <section className="claim-result success">
              <CheckCircle size={42} weight="fill" />
              <div><h2>Your evidence matched the staff-only record</h2><p>This accepts the claim evidence; it does not yet authorize release. Staff must still attest identity and approve the valuable-item handoff.</p>{staffPreview && <button type="button" onClick={() => setView("staff")}>Return to staff workspace <ArrowRight size={16} /></button>}</div>
            </section>
          )}
          {locked && (
            <section className="claim-result review">
              <WarningCircle size={42} weight="fill" />
              <div><h2>Staff review is required</h2><p>Automatic checks are paused. No item has been reserved or released.</p>{staffPreview && <button type="button" onClick={() => setView("staff")}>Return to staff workspace <ArrowRight size={16} /></button>}</div>
            </section>
          )}
          <footer className="claimant-footer"><LockKey size={14} /> {expiryCopy} · Each submission consumes the link; a rejected attempt receives a fresh one · Answers are never shown back</footer>
        </div>
      </main>
    </div>
  );
}
