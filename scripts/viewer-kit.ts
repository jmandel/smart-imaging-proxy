// Downloads viewer-kit, the browser DICOM decoder the thumbnails use, checking the tarball's pinned
// SHA-256 and every file against its SHA256SUMS. The pin is in src/vendor.ts.
import { fetchViewerKit } from "../src/vendor";

try { console.log(`viewer-kit: ${await fetchViewerKit()}`); }
catch (e) { console.error(String((e as Error).message ?? e)); process.exit(1); }
