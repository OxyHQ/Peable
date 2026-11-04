/**
 * Peable's own Oxy application: the identity the gateway runs as (`OxyServer`'s
 * `applicationId`) and the one an Oxy service addresses when it calls the
 * gateway. One constant, so the gateway's accepted audience and the SDK's
 * requested one cannot name two different applications.
 */
export const PEABLE_OXY_APPLICATION_ID = '6a2f851751b784a86fd0e958';

/** The service-token audience of Peable's gateway (`oxy-service:<application id>`). */
export const PEABLE_SERVICE_AUDIENCE = `oxy-service:${PEABLE_OXY_APPLICATION_ID}`;
