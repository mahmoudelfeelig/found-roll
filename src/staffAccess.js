export function hasAuthoritativeStaffProjection({
  demo,
  operatorTokenLoaded,
  staffTokenLoaded,
  supervisorTokenLoaded,
}) {
  return Boolean(
    operatorTokenLoaded
    && staffTokenLoaded
    && supervisorTokenLoaded
    && demo?.authoritative === true
    && demo?.source === "service"
    && demo?.authoritativeCase?.id,
  );
}
