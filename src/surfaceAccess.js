const SURFACES = new Set(["staff", "claimant", "relay"]);

export function resolveSurfaceScope(search = "") {
  const requested = new URLSearchParams(search).get("view");
  return SURFACES.has(requested) ? requested : "staff";
}

export function canNavigateSurface(scope, nextView) {
  if (!SURFACES.has(nextView)) return false;
  if (scope === "staff") return nextView === "staff" || nextView === "relay";
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
    scopeLabel: view === "claimant"
      ? "Private claimant link · no staff access"
      : view === "relay"
        ? "Case-scoped SIMULATED relay terminal · no staff access"
        : "Authenticated staff surface",
  };
}
