const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanId, forwarderRuntimeStatus, resolveForwarderRoute } = require('./forwarder-route');

const EJP_SOURCE = '1511285725499232397';
const ENDGAME_DESTINATION = '1491800679495241844';
const STRIDE_DESTINATION = '1527624229548195911';

test('cleanId accepts Discord snowflakes and rejects unsafe values', () => {
  assert.equal(cleanId(` <#${EJP_SOURCE}> `), '');
  assert.equal(cleanId(EJP_SOURCE), EJP_SOURCE);
  assert.equal(cleanId('not-an-id'), '');
});

test('forwarder route uses configured defaults when no state exists', () => {
  assert.deepEqual(resolveForwarderRoute({
    defaultSource: EJP_SOURCE,
    defaultDestination: STRIDE_DESTINATION,
  }), {
    source: EJP_SOURCE,
    destination: STRIDE_DESTINATION,
    migratedDestination: false,
  });
});

test('deprecated Endgame destination migrates to STRIDE', () => {
  assert.deepEqual(resolveForwarderRoute({
    persistedSource: EJP_SOURCE,
    persistedDestination: ENDGAME_DESTINATION,
    defaultSource: EJP_SOURCE,
    defaultDestination: STRIDE_DESTINATION,
    deprecatedDestinationIds: [ENDGAME_DESTINATION],
  }), {
    source: EJP_SOURCE,
    destination: STRIDE_DESTINATION,
    migratedDestination: true,
  });
});

test('an unrelated custom destination remains unchanged', () => {
  const customDestination = '123456789012345678';
  const route = resolveForwarderRoute({
    persistedSource: EJP_SOURCE,
    persistedDestination: customDestination,
    defaultSource: EJP_SOURCE,
    defaultDestination: STRIDE_DESTINATION,
    deprecatedDestinationIds: [ENDGAME_DESTINATION],
  });
  assert.equal(route.destination, customDestination);
  assert.equal(route.migratedDestination, false);
});

test('a transient route failure preserves the requested ON state', () => {
  assert.equal(forwarderRuntimeStatus({ desiredEnabled: true, routeReady: false }), 'WAITING');
  assert.equal(forwarderRuntimeStatus({ desiredEnabled: true, routeReady: true }), 'ON');
  assert.equal(forwarderRuntimeStatus({ desiredEnabled: false, routeReady: true }), 'OFF');
  assert.equal(forwarderRuntimeStatus({ desiredEnabled: true, stateLoaded: false }), 'UNKNOWN');
});
