/** Small pure formatters shared by the pocket and the screens. No device modules. */

/** "7xKp…a9Qe": full keys are unreadable at a glance. */
export const shorten = (key: { toBase58(): string } | string) => {
  const s = typeof key === "string" ? key : key.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** How a screen reader should say a short key: letter by letter would be worse. */
export const spokenKey = (key: { toBase58(): string } | string) => {
  const s = typeof key === "string" ? key : key.toBase58();
  return `key starting ${s.slice(0, 4).split("").join(" ")}`;
};

/** 24-hour clock time, phone-local. */
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** "now", "4m", "2h", "3d". */
export const ago = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "4 Oct, 14:05" from unix seconds. */
export const dayTime = (unixSeconds: bigint | number) => {
  const d = new Date(Number(unixSeconds) * 1000);
  return `${d.getDate()} ${MON[d.getMonth()]}, ${hhmm(d.getTime())}`;
};

/** Percent from basis points: 200 -> "2%", 150 -> "1.5%". */
export const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;

/** A stable small number from a string, for stamp angles. */
export const hashNum = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
};
