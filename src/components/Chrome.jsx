import {
  CaretDown,
  SignOut,
} from "@phosphor-icons/react";
import { chromePolicyFor } from "../surfaceAccess.js";

export function ToolButton({ icon: Icon, label, active = false, onClick, quiet = false, disabled = false }) {
  return (
    <button
      className={`tool-button${active ? " is-active" : ""}${quiet ? " is-quiet" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={18} weight={active ? "fill" : "regular"} aria-hidden="true" />
      {!quiet && <span>{label}</span>}
    </button>
  );
}

function ViewPicker({ view, setView }) {
  return (
    <label className="view-picker">
      <span>View:</span>
      <select value={view} onChange={(event) => setView(event.target.value)}>
        <option value="staff">Staff Workspace</option>
        <option value="relay">Relay Terminal</option>
      </select>
    </label>
  );
}

export function WindowChrome({ view, setView, onRefresh, onSignOut, busy = false }) {
  const title = view === "staff" ? "Staff Workspace" : view === "claimant" ? "Private Claim Proof" : "SIMULATED Relay Terminal";
  const policy = chromePolicyFor(view);
  return (
    <>
      <header className="title-bar">
        <span>Found Roll — {title}</span>
        <span className="window-actions" aria-hidden="true"><i></i><i></i><i></i></span>
      </header>
      <nav className="menu-bar" aria-label="Application menu">
        {policy.showStaffMenus ? (
          <>
            <div className="menu-items">
              {['File', 'Edit', 'View', 'Intake', 'Evidence', 'Match', 'Tools', 'Help'].map((label) => (
                <button type="button" key={label}>{label}</button>
              ))}
            </div>
            <div className="menu-session">
              {policy.showViewPicker && <ViewPicker view={view} setView={setView} />}
              {policy.showReset && <button type="button" className="text-command" onClick={onRefresh} disabled={busy}>Refresh case</button>}
              {policy.showStaffIdentity && <span className="staff-name">Authenticated staff <CaretDown size={11} weight="fill" /></span>}
              {policy.showStaffIdentity && <button className="sign-out" type="button" onClick={onSignOut} disabled={busy || !onSignOut}><SignOut size={14} /> Sign out</button>}
            </div>
          </>
        ) : (
          <div className="scoped-surface-label">{policy.scopeLabel}</div>
        )}
      </nav>
    </>
  );
}
