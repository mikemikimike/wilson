// DEMO-ONLY sandbox credentials. Public, fixed and deliberately weak: they exist only inside a throwaway HOME under
// /private/tmp (scripts/sandbox/up.ts). Never reuse them on a profile that holds real data.
export const SANDBOX_USERS = {
  admin: { username: 'sandbox-admin', password: 'sandbox-only-not-a-secret', role: 'admin' as const },
  viewer: { username: 'sandbox-viewer', password: 'sandbox-only-not-a-secret', role: 'viewer' as const },
};
