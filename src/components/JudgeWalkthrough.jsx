import {
  ArrowsClockwise,
  CheckCircle,
  CloudCheck,
  Eye,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { WindowChrome } from "./Chrome.jsx";

function titleCase(value) {
  return String(value || "unavailable").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortHash(value) {
  return typeof value === "string" && value.length >= 16 ? `${value.slice(0, 16)}…` : "Unavailable";
}

export function JudgeWalkthrough({ connection, walkthrough, onRefresh }) {
  const loading = walkthrough.status === "loading";
  const data = walkthrough.data;
  const available = Boolean(data?.available);

  return (
    <div className="judge-workspace">
      <WindowChrome view="walkthrough" setView={() => false} />
      <section className="judge-intro">
        <div>
          <span className="judge-kicker"><Eye size={14} weight="fill" /> PUBLIC · READ-ONLY</span>
          <h1>Inspect the redacted completed case</h1>
          <p>Review the live service’s synthetic Item Passport without credentials, media access, claimant evidence, or mutation authority.</p>
        </div>
        <button className="secondary-action judge-refresh" type="button" onClick={onRefresh} disabled={loading}>
          <ArrowsClockwise size={17} weight="bold" /> {loading ? "Refreshing…" : "Refresh live record"}
        </button>
      </section>

      {loading && (
        <section className="judge-loading" role="status"><CloudCheck size={24} weight="fill" /> Loading the public case projection…</section>
      )}

      {!loading && !available && (
        <section className="judge-unavailable" role="status">
          <WarningCircle size={28} weight="fill" />
          <div>
            <strong>Completed walkthrough not available yet</strong>
            <p>{data?.reason || walkthrough.error || "The hosted public record could not be read. No private case data is shown."}</p>
          </div>
        </section>
      )}

      {!loading && available && (
        <main className="judge-grid">
          <section className="judge-case-card" aria-labelledby="judge-case-title">
            <header><div><ShieldCheck size={20} weight="fill" /><span id="judge-case-title">Closed Item Passport</span></div><b>{titleCase(data.case.state)}</b></header>
            <div className="judge-case-content">
              <figure>
                <img src="/assets/pouch-front.jpg" alt="Synthetic black camera pouch used in the public walkthrough" />
                <figcaption>Synthetic camera-pouch fixture</figcaption>
              </figure>
              <dl>
                <div><dt>Case</dt><dd>{data.case.id}</dd></div>
                <div><dt>Version</dt><dd>{data.case.version} · {data.passport.event_count} events</dd></div>
                <div><dt>Scope</dt><dd>{data.case.reported_route_count} custodians · synthetic only</dd></div>
                <div><dt>Release tier</dt><dd>{titleCase(data.case.risk_tier)}</dd></div>
              </dl>
            </div>
            <p className="judge-disclosure"><LockKey size={15} weight="fill" /> No claim answer, restricted media, credential, task body, raw actor ID, or model trace is available on this route.</p>
          </section>

          <section className="judge-agent-card" aria-labelledby="judge-agent-title">
            <header><CloudCheck size={20} weight="fill" /><span id="judge-agent-title">Bounded Case Analyst</span></header>
            <dl>
              <div><dt>Execution mode</dt><dd>{data.agentic.mode}</dd></div>
              <div><dt>Model</dt><dd>{data.agentic.model_name}</dd></div>
              <div><dt>Run recorded</dt><dd>{data.agentic.model_run_recorded ? "Yes — private evidence receipt" : "Not recorded"}</dd></div>
              <div><dt>Tool steps retained</dt><dd>{data.agentic.bounded_tool_step_count}</dd></div>
            </dl>
            <p>The agent investigates and proposes a next question. Deterministic policy, staff attestation, supervisor approval, and the SIMULATED relay retain release authority.</p>
          </section>

          <section className="judge-passport-card" aria-labelledby="judge-passport-title">
            <header><CheckCircle size={20} weight="fill" /><span id="judge-passport-title">Internal consistency check</span></header>
            <div className="judge-check-row"><b>{data.passport.hash_chain_valid ? "Hash chain valid" : "Hash chain unavailable"}</b><span>{data.passport.event_count} application events</span></div>
            <dl>
              <div><dt>Manifest</dt><dd>{data.passport.manifest_id}</dd></div>
              <div><dt>Final event hash</dt><dd title={data.passport.final_event_hash}>{shortHash(data.passport.final_event_hash)}</dd></div>
              <div><dt>Physical transfer</dt><dd>{data.passport.physical_transfer_proven ? "Proven" : "Not proven"}</dd></div>
            </dl>
            <p>This is internally checkable application evidence, not independent proof of identity, ownership, possession, or a real-world handoff.</p>
          </section>

          <section className="judge-timeline" aria-labelledby="judge-timeline-title">
            <header><strong id="judge-timeline-title">Redacted custody timeline</strong><span>Read-only service projection</span></header>
            <ol>
              {data.timeline.map((event) => (
                <li key={`${event.sequence}-${event.event_hash}`}>
                  <i>{event.sequence}</i>
                  <div><strong>{titleCase(event.type)}</strong><span>{titleCase(event.from_state)} → {titleCase(event.to_state)} · {event.actor_label}</span></div>
                  <time>{new Date(event.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                </li>
              ))}
            </ol>
          </section>
        </main>
      )}

      <footer className="judge-footer"><span className={`connection-${connection.status}`}><CloudCheck size={14} weight="fill" /> {connection.label}</span><span>Full protected live flow is shown in the public demo video.</span></footer>
    </div>
  );
}
