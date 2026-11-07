export const EVRLE = "1.2.840.10008.1.2.1";
export const JPEG_LOSSLESS = "1.2.840.10008.1.2.4.70";
export const JPEG_BASELINE = "1.2.840.10008.1.2.4.50";
export const J2K_LOSSLESS = "1.2.840.10008.1.2.4.90";
export const JPEGLS_LOSSLESS = "1.2.840.10008.1.2.4.80";
export const PRIVATE_DEMO = "1.3.6.1.4.1.99999.1.2.3";

const STANDARD_PREFIX = "1.2.840.10008.1.2";
/** PS3.18 keeps these off the web: Implicit VR, Big Endian, and Deflated. */
export const NOT_ON_THE_WEB = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);
export const isStandard = (uid: string) => uid === STANDARD_PREFIX || uid.startsWith(STANDARD_PREFIX + ".");
const LOSSY = new Set(["1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51", "1.2.840.10008.1.2.4.81", "1.2.840.10008.1.2.4.91", "1.2.840.10008.1.2.4.93", "1.2.840.10008.1.2.4.203"]);
export const isLossy = (uid: string) => LOSSY.has(uid);
