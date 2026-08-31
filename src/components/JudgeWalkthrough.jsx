import {
  CheckCircle,
  CloudCheck,
  Eye,
  LockKey,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import architectureDiagram from "../../docs/architecture-diagram.png";

function titleCase(value) {
  return String(value || "unavailable").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortHash(value) {
  return typeof value === "string" && value.length >= 16 ? `${value.slice(0, 16)}…` : "Unavailable";
}

export function JudgeWalkthrough({ connection, walkthrough }) {
  const loading = walkthrough.status === "loading";
  const data = walkthrough.data;
  const available = Boolean(data?.available);

  return (
    <div className="judge-workspace">
      <section className="judge-intro">
        <div>
          <span className="judge-kicker"><Eye size={14} weight="fill" /> COMPLETED CASE STORY · READ-ONLY</span>
          <h1>See how this lost-item case was resolved</h1>
          <p>This safe public view shows the redacted outcome. Private evidence and staff actions stay protected.</p>
        </div>
      </section>

      {loading && (
        <section className="judge-loading" role="status"><CloudCheck size={24} weight="fill" /> Loading the public case projection…</section>
      )}

      {!loading && !available && (
        <section className="judge-unavailable" role="status">
          <WarningCircle size={28} weight="fill" />
          <div>
            <strong>This case is still being processed</strong>
            <p>{data?.reason || walkthrough.error || "The hosted public record could not be read. No private case data is shown."}</p>
          </div>
        </section>
      )}

      {!loading && available && (
        <main className="judge-story">
          <section className="judge-case-card" aria-labelledby="judge-case-title">
            <header><div><ShieldCheck size={20} weight="fill" /><span id="judge-case-title">Case record</span></div><b>{titleCase(data.case.state)}</b></header>
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

          <div className="judge-proof-grid">
            <section className="judge-agent-card" aria-labelledby="judge-agent-title">
              <header><CloudCheck size={20} weight="fill" /><span id="judge-agent-title">Gemini / ADK execution record</span></header>
              <dl>
                <div><dt>Execution mode</dt><dd>{data.agentic.mode}</dd></div>
                <div><dt>Model</dt><dd>{data.agentic.model_name}</dd></div>
                <div><dt>Execution record</dt><dd>{data.agentic.model_run_recorded ? "Present — redacted metadata only" : "Not recorded"}</dd></div>
                <div><dt>Tool steps retained</dt><dd>{data.agentic.bounded_tool_step_count}</dd></div>
              </dl>
              <p>The AI checks only policy-approved records and proposes the next private question. Policy and staff keep release authority; the relay remains SIMULATED.</p>
            </section>

            <section className="judge-passport-card" aria-labelledby="judge-passport-title">
              <header><CheckCircle size={20} weight="fill" /><span id="judge-passport-title">Case record integrity</span></header>
              <div className="judge-check-row"><b>{data.passport.hash_chain_valid ? "Hash chain valid" : "Hash chain unavailable"}</b><span>{data.passport.event_count} application events</span></div>
              <dl>
                <div><dt>Manifest</dt><dd>{data.passport.manifest_id}</dd></div>
                <div><dt>Final event hash</dt><dd title={data.passport.final_event_hash}>{shortHash(data.passport.final_event_hash)}</dd></div>
                <div><dt>Physical transfer</dt><dd>{data.passport.physical_transfer_proven ? "Proven" : "Not proven"}</dd></div>
              </dl>
              <p>This is internally checkable application evidence, not independent proof of identity, ownership, possession, or a real-world handoff.</p>
            </section>
          </div>

          <section className="judge-timeline" aria-labelledby="judge-timeline-title">
            <header><strong id="judge-timeline-title">What happened</strong><span>Safe public summary</span></header>
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

          <section className="judge-architecture" aria-labelledby="judge-architecture-title">
            <header><strong id="judge-architecture-title">Google Cloud architecture</strong><span>Bounded execution and policy-controlled release</span></header>
            <figure>
              <img src={architectureDiagram} alt="Found Roll architecture across Cloud Run, Vertex AI, Cloud Tasks, Firestore, Cloud Storage, Secret Manager, and Cloud Logging" />
              <figcaption>Gemini and ADK assist the review. Deterministic policy and authenticated people retain release authority.</figcaption>
            </figure>
          </section>
        </main>
      )}

      <footer className="judge-footer"><span className={`connection-${connection.status}`}><CloudCheck size={14} weight="fill" /> {connection.label}</span><span>Private evidence and staff actions stay protected.</span></footer>
    </div>
  );
}
