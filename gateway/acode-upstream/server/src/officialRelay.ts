export const officialRelay = {
  // The public relay endpoint is product configuration, not a user-entered URL.
  url: "https://code.pixlnan.com",
  // The registration secret belongs to the deployment and must never be shipped
  // in the client bundle. Provision it explicitly through the host environment
  // when generating an official-mode config; an empty value makes the missing
  // provisioning visible instead of silently using a stale production secret.
  get serverToken() {
    return process.env.RELAY_SERVER_TOKEN?.trim() ?? "";
  }
} as const;

export function isOfficialRelayUrl(value: string | undefined) {
  return (value ?? "").trim() === officialRelay.url;
}
