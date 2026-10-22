/**
 * init() options for the hybrid chat chunk when its fetch already resolves API
 * paths against the page origin, as the React dashboard's authedFetch does
 * (it prefixes getBaseUrl()). The hybrid client joins baseUrl with each API
 * path before calling fetchImpl, so baseUrl must stay empty: passing the
 * origin as well doubled it ("http://host:porthttp://host:port/api/...") and
 * every turn silently fell back to the server agent.
 *
 * Import-free so the main bundle can use it without pulling in the client.
 */
export function hybridOptsForOriginFetch<F>(originFetch: F): { baseUrl: ''; fetchImpl: F } {
  return { baseUrl: '', fetchImpl: originFetch };
}
