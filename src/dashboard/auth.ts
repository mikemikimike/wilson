import type { Database } from '../db/compat-sqlite.js';
import {
  revokeAllGrants,
  revokeGrantsForUser,
  expirePendingOperationsBySource,
  expirePendingOperationsForUser,
  isDashboardAuthEnabled,
} from '../mcp/store.js';
import { chatSessionOwnerId, getChatSessionById } from '../db/queries.js';

export interface DashboardUser {
  id: number;
  username: string;
  role: 'admin' | 'viewer';
  is_active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Whether a dashboard role may change data. The one RBAC rule for writes:
 * every REST write route, and approving a chat agent's mutating tool call
 * (#156), require it.
 */
export function canWrite(role: DashboardUser['role']): boolean {
  return role === 'admin';
}

/**
 * Whether a dashboard user may read or append to chat session `sessionId`. Auth off (`user` null): any session.
 * Auth on: a session is its starter's alone, so nobody writes into, or reads, another user's history (a viewer may
 * chat, #156, but only in their own sessions). An ownerless session (started with auth off) is the admins'. An id
 * with no session row is nobody's: a caller cannot plant turns under an id the server never minted.
 */
export function mayUseChatSession(db: Database, sessionId: string, user: Pick<DashboardUser, 'id' | 'role'> | null): boolean {
  if (!user) return true;
  if (!getChatSessionById(db, sessionId)) return false;
  const owner = chatSessionOwnerId(sessionId);
  return owner === null ? canWrite(user.role) : owner === user.id;
}

// ── Config ──────────────────────────────────────────────────────────────────

/** Read fresh from the DB on every call — see isDashboardAuthEnabled. */
export function isAuthEnabled(db: Database): boolean {
  return isDashboardAuthEnabled(db);
}

/**
 * Turn dashboard auth on. On the off -> on transition every WebMCP / HTTP-MCP
 * grant is revoked and every pending WebMCP / HTTP-MCP operation expired:
 * anything minted while auth was off has no owner (user_id null, role admin)
 * and would otherwise keep working, unattributed, under the new login rules.
 * Admins grant again afterwards. Re-enabling while already on changes nothing.
 * A chat run in flight with no owner (started while auth was off) is cancelled
 * through `onAuthEnabled`, together with its pending card.
 */
export function enableAuth(db: Database): void {
  if (isAuthEnabled(db)) return;
  revokeAllGrants(db);
  expirePendingOperationsBySource(db, 'webmcp', 'auth_enabled');
  expirePendingOperationsBySource(db, 'http-mcp', 'auth_enabled');
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'true')"
  ).run();
  for (const listener of authEnabledListeners) {
    try {
      listener(db);
    } catch (err) {
      // Housekeeping must never undo the enable (the flag is already written); say so and carry on.
      console.error('[auth] an onAuthEnabled listener failed:', err);
    }
  }
}

type AuthEnabledListener = (db: Database) => void;
const authEnabledListeners = new Set<AuthEnabledListener>();

/**
 * Run `listener(db)` right after dashboard auth is switched on (the off -> on transition only) for `db`.
 * The dashboard chat uses it to end runs that started with auth off: they have no owner, so nobody could
 * approve their cards or be held to their writes under the new login rules. A hook rather than an import
 * because chat.ts already depends on this module. Returns an unsubscribe function.
 */
export function onAuthEnabled(listener: AuthEnabledListener): () => void {
  authEnabledListeners.add(listener);
  return () => { authEnabledListeners.delete(listener); };
}

export function disableAuth(db: Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_config (key, value) VALUES ('auth_enabled', 'false')"
  ).run();
}

/** True when at least one active admin account exists, i.e. someone can actually log in and manage the dashboard. */
export function hasActiveAdmin(db: Database): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM dashboard_users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
  return !!row;
}

/**
 * The precondition for serving a profile over the network: the auth flag is on
 * AND an active admin exists. The flag alone is not enough, because with zero
 * users `/api/auth/setup` is public and the first caller would become admin.
 */
export function lanAuthReady(db: Database): boolean {
  return isAuthEnabled(db) && hasActiveAdmin(db);
}

// ── Users ───────────────────────────────────────────────────────────────────

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, 'argon2id');
}

/** Insert a user from an already-computed hash. Synchronous, so a caller can check state and insert with no await in between. */
export function insertUser(
  db: Database,
  username: string,
  passwordHash: string,
  role: 'admin' | 'viewer' = 'viewer'
): DashboardUser {
  const result = db.prepare(`
    INSERT INTO dashboard_users (username, password_hash, role)
    VALUES (@username, @passwordHash, @role)
  `).run({ username, passwordHash, role });
  const id = (result as { lastInsertRowid: number }).lastInsertRowid;
  return getUser(db, id)!;
}

export async function createUser(
  db: Database,
  username: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer'
): Promise<DashboardUser> {
  return insertUser(db, username, await hashPassword(password), role);
}

/**
 * First-run setup: create the admin and turn auth on, but only if there is
 * still no user at the moment of writing. The count check, the insert and
 * enableAuth run in one transaction with no await between them, so of two
 * concurrent setups (each having passed an early check, then awaited its body
 * and the password hash) exactly one wins; the other gets null.
 */
export function createFirstAdmin(db: Database, username: string, passwordHash: string): DashboardUser | null {
  return db.transaction(() => {
    if (getUserCount(db) > 0) return null;
    const user = insertUser(db, username, passwordHash, 'admin');
    enableAuth(db);
    return user;
  })();
}

export function getUser(db: Database, id: number): DashboardUser | undefined {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users WHERE id = @id'
  ).get({ id }) as DashboardUser | undefined;
}

export function getUserByUsername(db: Database, username: string): DashboardUser | undefined {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users WHERE username = @username'
  ).get({ username }) as DashboardUser | undefined;
}

export function listUsers(db: Database): DashboardUser[] {
  return db.prepare(
    'SELECT id, username, role, is_active, created_at, updated_at FROM dashboard_users ORDER BY id'
  ).all() as DashboardUser[];
}

export function getUserCount(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM dashboard_users').get() as { count: number };
  return row.count;
}

/** Thrown by deactivateUser / setUserRole when it would leave the profile with users but no active admin. */
export class LastAdminError extends Error {
  constructor(message = 'Cannot deactivate the last active admin. Promote or create another admin first.') {
    super(message);
    this.name = 'LastAdminError';
  }
}

/** True when an active admin other than `id` exists. */
function hasOtherActiveAdmin(db: Database, id: number): boolean {
  return !!db.prepare(
    "SELECT 1 AS ok FROM dashboard_users WHERE role = 'admin' AND is_active = 1 AND id != @id LIMIT 1"
  ).get({ id });
}

/** How a user lost the right to change data: deactivated, or moved to a role that cannot write. */
export type WriteRevocation = 'deactivated' | 'demoted';

type WriteRevokedListener = (db: Database, userId: number, why: WriteRevocation) => void;
const writeRevokedListeners = new Set<WriteRevokedListener>();

/**
 * Run `listener(db, userId, why)` right after `userId` loses write rights in `db`: deactivateUser, or setUserRole
 * taking an admin to a role that cannot write. The dashboard chat uses it to act on that user's in-flight run at
 * once (#159, #165), whichever caller made the change. A hook rather than an import, as with onAuthEnabled. A
 * row changed by any other path (a direct UPDATE) fires nothing; the chat re-checks the owner's current row before
 * every write its run makes, so that is still honoured, at the run's next write. Returns an unsubscribe function.
 */
export function onWriteRevoked(listener: WriteRevokedListener): () => void {
  writeRevokedListeners.add(listener);
  return () => { writeRevokedListeners.delete(listener); };
}

function notifyWriteRevoked(db: Database, userId: number, why: WriteRevocation): void {
  for (const listener of writeRevokedListeners) {
    try {
      listener(db, userId, why);
    } catch (err) {
      // The change is already committed; housekeeping must not turn it into an error. Say so and carry on.
      console.error('[auth] an onWriteRevoked listener failed:', err);
    }
  }
}

/**
 * Deactivate a user and end their MCP access with them: every WebMCP /
 * HTTP-MCP grant they hold is revoked and every pending operation prepared
 * under one is expired, so an external client holding their bearer token
 * sees no tools and nothing they queued can still be approved. Their chat
 * run in flight is cancelled through `onWriteRevoked`.
 *
 * Throws LastAdminError (and changes nothing) when the target is the only
 * active admin; the check and the update share one transaction.
 */
export function deactivateUser(db: Database, id: number): boolean {
  const deactivated = db.transaction(() => {
    const target = getUser(db, id);
    if (target && target.role === 'admin' && target.is_active && !hasOtherActiveAdmin(db, id)) {
      throw new LastAdminError();
    }
    const result = db.prepare(
      "UPDATE dashboard_users SET is_active = 0, updated_at = datetime('now') WHERE id = @id"
    ).run({ id });
    if ((result as { changes: number }).changes === 0) return false;
    revokeGrantsForUser(db, id);
    expirePendingOperationsForUser(db, id, 'user_deactivated');
    return true;
  })();
  if (deactivated) notifyWriteRevoked(db, id, 'deactivated');
  return deactivated;
}

/**
 * Change a user's role. Returns false when there is no such user. Throws LastAdminError (and changes nothing)
 * when it would demote the only active admin; the check and the update share one transaction.
 *
 * Taking an admin to a role that cannot write fires `onWriteRevoked`, so the chat run they have in flight loses
 * its writes at once and keeps its reads (#165). Their MCP access needs nothing here: grants, client tokens and
 * pending operations are all checked against the owner's live role when they are used.
 */
export function setUserRole(db: Database, id: number, role: DashboardUser['role']): boolean {
  let demoted = false;
  const found = db.transaction(() => {
    const target = getUser(db, id);
    if (!target) return false;
    demoted = canWrite(target.role) && !canWrite(role);
    if (demoted && target.is_active && !hasOtherActiveAdmin(db, id)) {
      throw new LastAdminError('Cannot demote the last active admin. Promote or create another admin first.');
    }
    db.prepare(
      "UPDATE dashboard_users SET role = @role, updated_at = datetime('now') WHERE id = @id"
    ).run({ id, role });
    return true;
  })();
  if (found && demoted) notifyWriteRevoked(db, id, 'demoted');
  return found;
}

// ── Sessions ────────────────────────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyLogin(
  db: Database,
  username: string,
  password: string
): Promise<{ token: string; user: DashboardUser } | null> {
  const row = db.prepare(
    'SELECT id, username, password_hash, role, is_active, created_at, updated_at FROM dashboard_users WHERE username = @username'
  ).get({ username }) as (DashboardUser & { password_hash: string }) | undefined;

  if (!row || !row.is_active) return null;

  const valid = await Bun.password.verify(password, row.password_hash);
  if (!valid) return null;

  const token = generateToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO dashboard_sessions (token, user_id, expires_at)
    VALUES (@token, @userId, @expiresAt)
  `).run({ token, userId: row.id, expiresAt });

  const { password_hash: _, ...user } = row;
  return { token, user };
}

// expires_at is stored as ISO ('T' separator) while datetime('now') uses a space, so a text
// comparison keeps a session valid for the rest of the UTC day. Compare via julianday() on
// both sides with an ISO `now`, as src/mcp/store.ts does.
export function validateToken(db: Database, token: string): DashboardUser | null {
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.is_active, u.created_at, u.updated_at
    FROM dashboard_sessions s
    JOIN dashboard_users u ON u.id = s.user_id
    WHERE s.token = @token AND julianday(s.expires_at) > julianday(@now) AND u.is_active = 1
  `).get({ token, now: new Date().toISOString() }) as DashboardUser | undefined;
  return row ?? null;
}

export function revokeToken(db: Database, token: string): void {
  db.prepare('DELETE FROM dashboard_sessions WHERE token = @token').run({ token });
}

export function cleanExpiredSessions(db: Database): number {
  const result = db.prepare(
    'DELETE FROM dashboard_sessions WHERE julianday(expires_at) <= julianday(@now)'
  ).run({ now: new Date().toISOString() });
  return (result as { changes: number }).changes;
}
