export async function resolveDemoAction({ action, connected, client }) {
  if (!connected) {
    return ["RESET", "REFRESH"].includes(action.type)
      ? { type: "RESET" }
      : { type: "OFFLINE_ACTION_BLOCKED" };
  }
  const projection = await client.perform(action);
  return { type: "HYDRATE_SERVICE", payload: projection };
}
