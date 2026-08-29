import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Check,
  Info,
  LockKey,
  Prohibit,
  QrCode,
  Scan,
  SealCheck,
  WifiHigh,
} from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import { WindowChrome } from "./Chrome.jsx";

function RelayCredential({ role, token, dispatch, busy, mutationAuthorized }) {
  const used = token.status === "USED";
  const available = Boolean(token.value);
  const title = role === "custodian" ? "Custodian credential" : "Recipient credential";
  return (
    <article className={`relay-credential${used ? " used" : ""}`}>
      <header><span>{role === "custodian" ? "A" : "B"}</span><strong>{title}</strong>{used && <SealCheck size={24} weight="fill" />}</header>
      <div className="relay-qr">{available ? <QRCodeSVG value={token.value} size={132} level="H" /> : <LockKey size={66} weight="duotone" />}</div>
      <code>{token.id}</code>
      <p>{used ? "Attested by the connected service" : available ? "One-time credential ready in this tab" : "Raw credential is unavailable in this browser session"}</p>
      <button type="button" onClick={() => dispatch({ type: "PRESENT_TOKEN", role })} disabled={busy || !available || !mutationAuthorized}><Scan size={20} weight="bold" />{used ? "Present again (replay test)" : available ? `Present ${role} credential` : "Return to staff to reissue"}</button>
    </article>
  );
}

export function RelayTerminal({ demo, dispatch, view, setView, busy, scope, operatorTokenLoaded, staffTokenLoaded }) {
  const ready = demo.claimantToken.status === "USED" && demo.custodianToken.status === "USED";
  const closed = demo.state === "CLOSED";
  const staffPreview = scope === "staff";
  const handoffAuthorized = operatorTokenLoaded && staffTokenLoaded;
  const expiryLabel = demo.reservation?.expiresAt
    ? new Date(demo.reservation.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="relay-shell">
      <div className="sr-only" aria-live="polite">{demo.lastNotice}</div>
      <WindowChrome view={view} setView={setView} onRefresh={() => {}} busy={busy} />
      <div className="simulated-banner"><Prohibit size={20} weight="fill" /> SIMULATED RELAY — no physical courier, locker, identity, or possession is verified by this demonstration</div>
      <header className="relay-header">
        <div className="relay-logo"><QrCode size={34} weight="duotone" /><div><strong>Relay Post</strong><span>Attestation terminal 03</span></div></div>
        <div className="relay-connection"><WifiHigh size={17} weight="fill" /> {demo.reservation ? `Service projection · eTag ${demo.reservation.remoteEtag}` : "No authoritative reservation loaded"}</div>
      </header>
      <main className="relay-main">
        <section className="reservation-ticket">
          <header><span>ACTIVE RESERVATION</span><b>{demo.reservation?.id || "Not yet reserved"}</b></header>
          <div className="ticket-grid">
            <div><small>ITEM</small><strong>{demo.reservation?.itemId || "Not loaded"}</strong><span>Black camera pouch</span></div>
            <div><small>CURRENT CUSTODIAN</small><strong>{demo.authoritativeCase?.current_holder || "Northport Air"}</strong><span>Service custody record</span></div>
            <div><small>DESTINATION</small><strong>Metro Loop</strong><span>Harbor Station · Post 12</span></div>
            <div><small>WINDOW</small><strong>{expiryLabel ? `Until ${expiryLabel}` : "Not issued"}</strong><span>{expiryLabel ? "Service-issued expiry" : "Awaiting reservation"}</span></div>
          </div>
          <footer><Info size={15} weight="fill" /> Tokens attest presentation to this simulator. They do not prove a physical handoff.</footer>
        </section>
        {demo.reservation ? (
          <section className="credential-grid">
            <RelayCredential role="custodian" token={demo.custodianToken} dispatch={dispatch} busy={busy} mutationAuthorized={operatorTokenLoaded} />
            <div className="relay-join"><ArrowRight size={28} weight="bold" /><span>same case</span><span>same window</span><span>same version</span></div>
            <RelayCredential role="claimant" token={demo.claimantToken} dispatch={dispatch} busy={busy} mutationAuthorized={operatorTokenLoaded} />
          </section>
        ) : (
          <section className="relay-empty"><LockKey size={46} weight="duotone" /><h2>No reservation loaded</h2><p>Complete the staff approval and reservation steps first.</p>{staffPreview && <button type="button" onClick={() => setView("staff")}>Return to staff workspace</button>}</section>
        )}
        {demo.reservation && (
          <section className={`relay-console${closed ? " closed" : ""}`}>
            <div className="console-screen">
              <span>CASE {demo.caseId} · VERSION {demo.version}</span>
              <strong>{closed ? "CALLBACK ACCEPTED · PASSPORT CLOSED" : ready ? "BOTH ATTESTATIONS PRESENT" : "WAITING FOR TWO ATTESTATIONS"}</strong>
              <small>{demo.tokenReplayRejected ? "TOKEN REPLAY REJECTED · NO STATE CHANGE" : demo.callback.replayHandled ? "DUPLICATE TASK DELIVERY ACKNOWLEDGED · NO NEW EVENT" : closed ? "Manifest generated · internally consistent service events" : "Present both one-time credentials before callback."}</small>
            </div>
            {!closed ? (
              <button type="button" className="relay-confirm" onClick={() => dispatch({ type: "CONFIRM_HANDOFF" })} disabled={!ready || busy || !handoffAuthorized} title={!handoffAuthorized ? "Load both the staff role and operator demo credentials in the staff workspace" : undefined}><Check size={23} weight="bold" /> Send simulated handoff callback</button>
            ) : (
              <div className="closed-actions"><button type="button" onClick={() => dispatch({ type: "REPLAY_CALLBACK" })} disabled={busy || !handoffAuthorized} title={!handoffAuthorized ? "Load both the staff role and operator demo credentials" : undefined}><ArrowsClockwise size={19} /> Queue duplicate task delivery</button>{staffPreview && <button type="button" className="primary-action" onClick={() => setView("staff")}><ArrowLeft size={19} /> View closed passport</button>}</div>
            )}
          </section>
        )}
      </main>
      <footer className="relay-footer"><span>SIMULATED Relay Post v1.0</span><span>Reservation adapter: HTTPS · deterministic callback · idempotency enforced</span><span>{demo.lastNotice}</span></footer>
    </div>
  );
}
