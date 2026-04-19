/**
 * Connection registry (v1.9.0).
 *
 * Per-profile map of registered Connection instances. Each profile registers
 * its own transports on startup; skills resolve them via the router (which
 * uses this internally) or via getConnection when they need a specific one.
 *
 * Why per-profile: multi-tenant deployment. Profile A may have slack+email,
 * profile B slack-only. Each has its own registry so they can't collide.
 */

import type { Connection, ConnectionId } from './types';
import logger from '../utils/logger';

// profileId -> (connectionId -> Connection)
const registry: Map<string, Map<ConnectionId, Connection>> = new Map();

/**
 * Register a Connection for a profile. Usually called once per connection
 * per profile on startup. Re-registering the same (profileId, connectionId)
 * pair replaces the previous instance and logs.
 */
export function registerConnection(profileId: string, connection: Connection): void {
  let profileMap = registry.get(profileId);
  if (!profileMap) {
    profileMap = new Map();
    registry.set(profileId, profileMap);
  }
  const existed = profileMap.has(connection.id);
  profileMap.set(connection.id, connection);
  logger.info('Connection registered', {
    profileId,
    connectionId: connection.id,
    replacedExisting: existed,
  });
}

/**
 * Look up a specific Connection for a profile. Returns null if not
 * registered — caller decides how to handle (fallback, error, log).
 */
export function getConnection(profileId: string, connectionId: ConnectionId): Connection | null {
  return registry.get(profileId)?.get(connectionId) ?? null;
}

/**
 * List all registered connection IDs for a profile. Used by the router when
 * falling back to "any reachable connection" and for startup logging.
 */
export function listConnections(profileId: string): ConnectionId[] {
  const profileMap = registry.get(profileId);
  return profileMap ? [...profileMap.keys()] : [];
}

/**
 * Remove a Connection (testing / reconfiguration). Rarely called in production.
 */
export function unregisterConnection(profileId: string, connectionId: ConnectionId): boolean {
  const removed = registry.get(profileId)?.delete(connectionId) ?? false;
  if (removed) logger.info('Connection unregistered', { profileId, connectionId });
  return removed;
}
