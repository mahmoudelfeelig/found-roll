import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { StaffWorkspace } from "./components/StaffWorkspace.jsx";
import { ClaimantPortal } from "./components/ClaimantPortal.jsx";
import { JudgeWalkthrough } from "./components/JudgeWalkthrough.jsx";
import { RelayTerminal } from "./components/RelayTerminal.jsx";
import { demoReducer, initialDemoState } from "./demoMachine.js";
import { resolveDemoAction } from "./demoController.js";
import {
  configureRuntimeSession,
  recoverConnectedActionFailure,
  ServiceDemoClient,
} from "./serviceDemoClient.js";
import { canNavigateSurface, resolveSurfaceScope } from "./surfaceAccess.js";

export function App() {
  const [demo, localDispatch] = useReducer(demoReducer, initialDemoState);
  const [connection, setConnection] = useState({ status: "checking", label: "Checking custody service…" });
  const [busy, setBusy] = useState(false);
  const [busyMessage, setBusyMessage] = useState("");
  const [operationError, setOperationError] = useState("");
  const [operatorTokenLoaded, setOperatorTokenLoaded] = useState(false);
  const [staffTokenLoaded, setStaffTokenLoaded] = useState(false);
  const [supervisorTokenLoaded, setSupervisorTokenLoaded] = useState(false);
  const [judgeWalkthrough, setJudgeWalkthrough] = useState({ status: "idle", data: null, error: "" });
  const apiBase = import.meta.env.VITE_API_BASE_URL || "";
  const serviceClient = useMemo(() => new ServiceDemoClient(apiBase), [apiBase]);
  const scope = useMemo(() => resolveSurfaceScope(window.location.search), []);
  const [view, setViewState] = useState(scope);

  useEffect(() => {
    const caseParam = new URLSearchParams(window.location.search).get("case") || "";
    if (caseParam) serviceClient.setCaseId(caseParam);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const claimToken = fragment.get("claim") || "";
    if (!claimToken) return;
    serviceClient.setClaimLinkToken(claimToken);
    const sanitized = new URL(window.location.href);
    sanitized.hash = "";
    window.history.replaceState({}, "", sanitized);
  }, [serviceClient]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase}/api/v1/healthz`, { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`health status ${response.status}`);
        const payload = await response.json();
        if (payload.service !== "found-roll-custody") throw new Error("unexpected health payload");
        if (controller.signal.aborted) return;
        setConnection({
          status: payload.analyst_mode === "vertex_adk" ? "live" : "fixture",
          label: payload.analyst_mode === "vertex_adk"
            ? "Connected custody service · Vertex ADK"
            : "Connected custody service · deterministic fixture analyst",
          payload,
        });
        if (scope === "staff") {
          localDispatch({
            type: "SET_READ_ONLY_NOTICE",
            message: payload.analyst_mode === "vertex_adk"
              ? "Live custody service reachable. This tab remains read-only until all three protected runtime roles are loaded."
              : "Connected deterministic fixture service. This tab remains read-only until all three protected runtime roles are loaded.",
          });
        }
        if (scope === "claimant") {
          try {
            const projection = await serviceClient.loadClaimantProjection();
            if (!controller.signal.aborted) localDispatch({ type: "HYDRATE_SERVICE", payload: projection });
          } catch (error) {
            if (!controller.signal.aborted) {
              localDispatch({ type: "CLAIMANT_LINK_UNAVAILABLE", caseId: serviceClient.caseId });
              setOperationError(error?.message || "This claimant proof link is unavailable.");
            }
          }
        }
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setConnection({ status: "offline", label: "Offline read-only fixture · no private-answer verification" });
          if (scope === "staff") {
            localDispatch({
              type: "SET_READ_ONLY_NOTICE",
              message: "Local read-only sample workspace. No private answer check or custody change is available.",
            });
          }
        }
      });
    return () => controller.abort();
  }, [apiBase, scope, serviceClient]);

  const refreshJudgeWalkthrough = useCallback(async () => {
    setJudgeWalkthrough({ status: "loading", data: null, error: "" });
    try {
      const response = await fetch(`${apiBase}/api/v1/judge-walkthrough`, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`public walkthrough status ${response.status}`);
      const data = await response.json();
      setJudgeWalkthrough({ status: "ready", data, error: "" });
    } catch {
      setJudgeWalkthrough({ status: "error", data: null, error: "The hosted read-only case could not be reached from this browser session." });
    }
  }, [apiBase]);

  useEffect(() => {
    if (scope !== "walkthrough") return undefined;
    void refreshJudgeWalkthrough();
    return undefined;
  }, [refreshJudgeWalkthrough, scope]);

  const hydrateAuthoritativeProjection = useCallback((projection) => {
    if (!projection?.authoritative) return;
    localDispatch({ type: "HYDRATE_SERVICE", payload: projection });
    if (projection.caseId) {
      const url = new URL(window.location.href);
      url.searchParams.set("case", projection.caseId);
      window.history.replaceState({}, "", url);
    }
  }, []);

  const dispatch = useCallback(async (action) => {
    if (busy) return;
    const connected = connection.status === "live" || connection.status === "fixture";
    setBusy(true);
    setBusyMessage("Custody service is committing this step…");
    setOperationError("");
    try {
      const resolved = await resolveDemoAction({
        action,
        connected,
        client: serviceClient,
        onQueuedProjection: (projection) => {
          if (!projection?.authoritative) return;
          hydrateAuthoritativeProjection(projection);
          setBusyMessage("Analysis is queued on the custody service. Waiting for its authoritative result…");
          if (action.type === "IMPORT_INTAKE" && typeof action.onQueued === "function") action.onQueued();
        },
      });
      if (resolved.type === "HYDRATE_SERVICE") hydrateAuthoritativeProjection(resolved.payload);
      else localDispatch(resolved);
      return resolved.payload;
    } catch (error) {
      setOperationError(error?.message || "The custody service stopped this step.");
      if (connected) {
        try {
          const recovery = await recoverConnectedActionFailure(serviceClient, scope, error);
          if (recovery.kind === "projection") {
            localDispatch({ type: "HYDRATE_SERVICE", payload: recovery.projection });
          } else if (recovery.kind === "claimant_unavailable") {
            localDispatch({ type: "CLAIMANT_LINK_UNAVAILABLE", caseId: recovery.caseId });
          }
        } catch {
          // Preserve the last authoritative projection when the refresh also fails.
        }
      }
      return false;
    } finally {
      setBusy(false);
      setBusyMessage("");
    }
  }, [busy, connection.status, hydrateAuthoritativeProjection, scope, serviceClient]);

  const setView = (nextView) => {
    if (!canNavigateSurface(scope, nextView)) return false;
    const url = new URL(window.location.href);
    url.searchParams.set("view", nextView);
    window.history.replaceState({}, "", url);
    setViewState(nextView);
    return true;
  };

  const configureRuntimeCredentials = useCallback(async ({ demoToken = "", staffToken = "", supervisorToken = "" }) => {
    serviceClient.clearSession();
    localDispatch({ type: "RESET" });
    setOperatorTokenLoaded(false);
    setStaffTokenLoaded(false);
    setSupervisorTokenLoaded(false);
    setOperationError("");
    setBusy(true);
    try {
      const configured = await configureRuntimeSession(serviceClient, {
        demoToken,
        staffToken,
        supervisorToken,
      });
      if (!configured.configured) return false;
      const { projection } = configured;
      localDispatch({ type: "HYDRATE_SERVICE", payload: projection });
      const url = new URL(window.location.href);
      url.searchParams.set("case", projection.caseId);
      window.history.replaceState({}, "", url);
      setOperatorTokenLoaded(true);
      setStaffTokenLoaded(true);
      setSupervisorTokenLoaded(true);
      return true;
    } catch (error) {
      serviceClient.clearSession();
      localDispatch({ type: "RESET" });
      setOperatorTokenLoaded(false);
      setStaffTokenLoaded(false);
      setSupervisorTokenLoaded(false);
      setOperationError(error?.message || "The service rejected these runtime credentials.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [serviceClient]);

  const screenProps = {
    demo,
    dispatch,
    view,
    setView,
    connection,
    busy,
    scope,
    operatorTokenLoaded,
    staffTokenLoaded,
    supervisorTokenLoaded,
    configureRuntimeCredentials,
  };

  const screen = view === "walkthrough"
    ? <JudgeWalkthrough connection={connection} walkthrough={judgeWalkthrough} />
    : view === "claimant"
    ? <ClaimantPortal {...screenProps} />
    : view === "relay"
      ? <RelayTerminal {...screenProps} />
      : <StaffWorkspace {...screenProps} />;

  return (
    <>
      {screen}
      {(busy || operationError) && (
        <div className={`service-operation-note${operationError ? " is-error" : ""}`} role={operationError ? "alert" : "status"} aria-live="polite">
          {operationError || busyMessage || "Custody service is committing this step…"}
        </div>
      )}
    </>
  );
}
