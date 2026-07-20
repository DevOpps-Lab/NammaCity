/**
 * DEMO CLOCK
 *
 * The entire thesis is about SLA breach, and you cannot wait 48 hours on stage.
 * With ?demo=1 the clock compresses so an SLA deadline arrives in seconds:
 * one real second becomes one simulated hour.
 *
 * Everything that reads "now" must go through `now()` so countdown rings, the
 * escalation trigger and the timeline all move together.
 */

export const DEMO_SPEEDUP = 3600; // 1 real second = 1 simulated hour

let demoMode = false;
let anchorReal = Date.now();
let anchorSim = Date.now();

export function isDemoMode() {
  return demoMode;
}

export function setDemoMode(on: boolean) {
  if (on === demoMode) return;
  // Re-anchor so simulated time is continuous across a toggle.
  anchorSim = now();
  anchorReal = Date.now();
  demoMode = on;
}

/** Simulated current time in ms. Use this everywhere instead of Date.now(). */
export function now(): number {
  if (!demoMode) return Date.now();
  return anchorSim + (Date.now() - anchorReal) * DEMO_SPEEDUP;
}

export const HOUR = 3_600_000;

/** Human countdown, e.g. "6h 12m left" or "3d 4h overdue". */
export function formatRemaining(deadline: number, at: number = now()): string {
  const diff = deadline - at;
  const overdue = diff < 0;
  const ms = Math.abs(diff);

  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / HOUR);
  const mins = Math.floor((ms % HOUR) / 60_000);

  const parts = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  return overdue ? `${parts} overdue` : `${parts} left`;
}

/** 0 -> just filed, 1 -> deadline reached, >1 -> overdue. */
export function slaProgress(createdAt: number, deadline: number, at: number = now()) {
  const total = deadline - createdAt;
  if (total <= 0) return 1;
  return (at - createdAt) / total;
}
