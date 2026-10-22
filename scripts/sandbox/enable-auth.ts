#!/usr/bin/env bun
/**
 * Sandbox step (scripts/sandbox/up.ts --auth): turn dashboard auth ON for the sandbox's default profile with a
 * demo-only admin and a demo-only viewer, so agents can test both roles. Same HOME guard as the live seed.
 */
// Must stay the first import: it refuses a non-scratch HOME before any app module loads.
import './../webmcp-live-seed-guard.js';
import { setActiveProfile, DEFAULT_PROFILE } from '../../src/profile/index.js';
import { initDatabase } from '../../src/db/database.js';
import { createUser, enableAuth, getUserByUsername } from '../../src/dashboard/auth.js';
import { SANDBOX_USERS } from './users.js';

setActiveProfile(DEFAULT_PROFILE);
const db = initDatabase();
for (const u of Object.values(SANDBOX_USERS)) {
  if (!getUserByUsername(db, u.username)) await createUser(db, u.username, u.password, u.role);
}
enableAuth(db);
db.close();
console.log(`Dashboard auth ON (admin ${SANDBOX_USERS.admin.username}, viewer ${SANDBOX_USERS.viewer.username}).`);
