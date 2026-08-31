const SURFACES = new Set(["walkthrough", "staff", "claimant", "relay"]);

export function resolveSurfaceScope(search = "") {
  const requested = new URLSearchParams(search).get("view");
  return SURFACES.has(requested) ? requested : "walkthrough";
}

export function canNavigateSurface(scope, nextView) {
  if (!SURFACES.has(nextView)) return false;
  if (scope === "staff") return nextView === "staff" || nextView === "relay";
  if (scope === "walkthrough") return nextView === "walkthrough";
  return scope === nextView;
}

export function claimantProofUrl(currentHref, caseId, rawToken) {
  const url = new URL(currentHref);
  url.search = new URLSearchParams({ view: "claimant", case: caseId }).toString();
  url.hash = new URLSearchParams({ claim: rawToken }).toString();
  return url.toString();
}

export function chromePolicyFor(view) {
  const staff = view === "staff";
  return {
    showStaffMenus: staff,
    showViewPicker: staff,
    showStaffIdentity: staff,
    showReset: staff,
    scopeLabel: view === "walkthrough"
      ? "Public judge walkthrough · read-only synthetic case"
      : view === "claimant"
      ? "Private claimant link · no staff access"
      : view === "relay"
        ? "Case-scoped SIMULATED relay terminal · no staff access"
        : "Authenticated staff surface",
  };
}
