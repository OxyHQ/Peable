/**
 * The date of the one wire (ADR 0014 D2): echoed as `Peable-Version` on every
 * response, the `api_version` every event is stored under, and the only value
 * a caller may send in `Peable-Version`. One constant, so the header, the
 * stored events and the SDK's `apiVersion` cannot name two different wires.
 */
export const PEABLE_API_VERSION = '2026-11-03';

/** Every wire date the gateway serves. Dated versions side by side are a later decision (ADR 0014 D2). */
export const PEABLE_API_VERSIONS = [PEABLE_API_VERSION] as const;
export type PeableApiVersion = (typeof PEABLE_API_VERSIONS)[number];
