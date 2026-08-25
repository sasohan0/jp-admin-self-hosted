// Pure route selection for the cross-server job forwarder.
// Keeping the migration decision outside Discord code makes it testable and
// prevents a stale persisted destination from silently overriding a new safe
// default after deployment.

function cleanId(value) {
  const id = String(value || '').trim();
  return /^\d{17,20}$/.test(id) ? id : '';
}

function resolveForwarderRoute({
  persistedSource,
  persistedDestination,
  defaultSource,
  defaultDestination,
  deprecatedDestinationIds = [],
}) {
  const fallbackSource = cleanId(defaultSource);
  const fallbackDestination = cleanId(defaultDestination);
  const storedSource = cleanId(persistedSource);
  const storedDestination = cleanId(persistedDestination);
  const deprecated = new Set(deprecatedDestinationIds.map(cleanId).filter(Boolean));

  const source = storedSource || fallbackSource;
  const shouldMigrateDestination = Boolean(
    storedDestination && fallbackDestination && deprecated.has(storedDestination)
  );
  const destination = shouldMigrateDestination
    ? fallbackDestination
    : (storedDestination || fallbackDestination);

  return {
    source,
    destination,
    migratedDestination: shouldMigrateDestination,
  };
}

function forwarderRuntimeStatus({ desiredEnabled, stateLoaded = true, routeReady = false }) {
  if (!stateLoaded) return 'UNKNOWN';
  if (!desiredEnabled) return 'OFF';
  return routeReady ? 'ON' : 'WAITING';
}

module.exports = { cleanId, forwarderRuntimeStatus, resolveForwarderRoute };
