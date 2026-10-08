import { ClientActionEnum, epochNow, NTP_CONSTANTS, type NTPResponseMessageType } from "@beatsync/shared";

// ── Types ──────────────────────────────────────────────────────────

export interface NTPMeasurement {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  roundTripDelay: number;
  clockOffset: number;
}

// ── Probe pair sending ─────────────────────────────────────────────

let probeGroupCounter = 0;
let pendingFirstProbe: NTPMeasurement | null = null;
let pendingFirstProbeGroupId: number | null = null;

/** Reset probe state (call on connection reset) */
export const resetProbeState = () => {
  probeGroupCounter = 0;
  pendingFirstProbe = null;
  pendingFirstProbeGroupId = null;
};

/**
 * Send a coded probe pair (Huygens). Two NTP requests sent with a known
 * inter-departure gap. The client later validates that the server-side
 * inter-arrival gap matches, filtering out measurements corrupted by
 * queuing, TCP HOL blocking, or GC pauses.
 */
export const sendProbePair = (data: {
  ws: WebSocket;
  currentRTT: number | undefined;
  compensationMs: number | undefined;
}) => {
  const { ws, currentRTT, compensationMs } = data;
  if (ws.readyState !== WebSocket.OPEN) return;

  const probeGroupId = probeGroupCounter++;

  const send = (probeGroupIndex: 0 | 1) =>
    ws.send(
      JSON.stringify({
        type: ClientActionEnum.enum.NTP_REQUEST,
        t0: epochNow(),
        clientRTT: currentRTT,
        clientCompensationMs: compensationMs,
        clientNudgeMs: 0,
        probeGroupId,
        probeGroupIndex,
      })
    );

  send(0);
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) send(1);
  }, NTP_CONSTANTS.PROBE_GAP_MS);
};

// ── Probe pair collection ──────────────────────────────────────────

/**
 * Feed an individual probe response into the pair validator.
 * Buffers the first probe; when the second arrives, validates gap purity
 * and returns the best measurement (lowest RTT) from the pair.
 */
const validateProbePair = (data: {
  measurement: NTPMeasurement;
  probeGroupId: number;
  probeGroupIndex: number;
}): NTPMeasurement | null => {
  const { measurement, probeGroupId, probeGroupIndex } = data;

  if (probeGroupIndex === 0) {
    pendingFirstProbe = measurement;
    pendingFirstProbeGroupId = probeGroupId;
    return null;
  }

  const first = pendingFirstProbe;
  const firstGroupId = pendingFirstProbeGroupId;

  if (!first || firstGroupId !== probeGroupId) return null;

  pendingFirstProbe = null;
  pendingFirstProbeGroupId = null;

  // Compare server inter-arrival gap against client inter-departure gap
  const clientGap = measurement.t0 - first.t0;
  const serverGap = measurement.t1 - first.t1;
  const gapDrift = Math.abs(serverGap - clientGap);
  if (gapDrift > NTP_CONSTANTS.PROBE_GAP_TOLERANCE_MS) return null;

  return first.roundTripDelay <= measurement.roundTripDelay ? first : measurement;
};

// ── Offset estimation ──────────────────────────────────────────────

/**
 * Min-RTT selection: queuing delays can only ADD to RTT, never subtract,
 * so the lowest-RTT measurement's offset has the least asymmetric
 * queuing contamination (RFC 5905 §10).
 */
export const calculateOffsetEstimate = (measurements: NTPMeasurement[]) => {
  let minRTT = Infinity;
  let bestOffset = 0;
  for (const m of measurements) {
    if (m.roundTripDelay < minRTT) {
      minRTT = m.roundTripDelay;
      bestOffset = m.clockOffset;
    }
  }

  const totalRoundTrip = measurements.reduce((sum, m) => sum + m.roundTripDelay, 0);
  const averageRoundTrip = measurements.length > 0 ? totalRoundTrip / measurements.length : 0;

  return { offset: bestOffset, roundTrip: minRTT === Infinity ? 0 : minRTT, averageRoundTrip };
};

/** ms until targetServerTime given the clock offset estimate */
export const calculateWaitTimeMilliseconds = (targetServerTime: number, clockOffset: number): number =>
  Math.max(0, targetServerTime - (epochNow() + clockOffset));

/**
 * Process an NTP_RESPONSE into a measurement and attempt to complete a
 * probe pair. Returns a measurement once both probes in a pure pair
 * have been received, else null.
 */
export const handleNTPResponse = (response: NTPResponseMessageType): NTPMeasurement | null => {
  const t3 = epochNow();
  const { t0, t1, t2, probeGroupId, probeGroupIndex } = response;

  const clockOffset = (t1 - t0 + (t2 - t3)) / 2;
  const roundTripDelay = t3 - t0 - (t2 - t1);
  const measurement: NTPMeasurement = { t0, t1, t2, t3, roundTripDelay, clockOffset };

  return validateProbePair({ measurement, probeGroupId, probeGroupIndex });
};
