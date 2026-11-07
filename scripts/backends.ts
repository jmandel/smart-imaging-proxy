// The S3 store (RustFS) and Orthanc, run as plain processes on loopback, with no containers. Their
// release binaries are downloaded once into $DEMO_STORAGE/bin, each checked against a pinned SHA-256.
//
//   bun scripts/backends.ts fetch            download and check the binaries
//   bun scripts/backends.ts start | stop     run both in the background (bun run up and down)
//   bun scripts/backends.ts run s3|orthanc   run one in the foreground, as a systemd unit does
//
// Orthanc's builds are for Linux on x86-64. Elsewhere it's skipped, and its backend reports itself
// unavailable.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { CONFIG, STORAGE } from "../src/config";

const BIN = `${STORAGE}/bin`;
const platform = `${process.platform}-${process.arch}`;

/** RustFS 1.0.4 (Apache-2.0), from github.com/rustfs/rustfs/releases. The static builds, where there are any. */
const RUSTFS: Record<string, { url: string; sha256: string }> = {
  "linux-x64": { url: "https://github.com/rustfs/rustfs/releases/download/1.0.4/rustfs-linux-x86_64-musl-v1.0.4.zip", sha256: "4924ad4b699b9f59943051efedae2d1eb6d4cac503a1b0384c4b25f7c2c31b5c" },
  "linux-arm64": { url: "https://github.com/rustfs/rustfs/releases/download/1.0.4/rustfs-linux-aarch64-musl-v1.0.4.zip", sha256: "81414fd0e41969f4f5c2e0555951cee76d3f224c112c269c80f52b31276f187a" },
  "darwin-arm64": { url: "https://github.com/rustfs/rustfs/releases/download/1.0.4/rustfs-macos-aarch64-v1.0.4.zip", sha256: "49057482769d7904ef95dc40457d71122f48cbb8e9e0725a0817a3ec6daf8270" },
};
/** Orthanc 1.13.0 and its DICOMweb plugin 1.24 (GPL and AGPL), Linux Standard Base builds from orthanc.uclouvain.be. */
const ORTHANC_SITE = "https://orthanc.uclouvain.be/downloads/linux-standard-base";
const ORTHANC: Record<string, { server: { url: string; sha256: string }; dicomweb: { url: string; sha256: string } }> = {
  "linux-x64": {
    server: { url: `${ORTHANC_SITE}/orthanc/1.13.0/Orthanc`, sha256: "c30cbcb8e6af3d209ebc5458b6db751e073822433612c1108927c40184e8d4a8" },
    dicomweb: { url: `${ORTHANC_SITE}/orthanc-dicomweb/1.24/libOrthancDicomWeb.so`, sha256: "17bbfe247571b966cd6d80e7b5c030d5eccb7b41833050633335d3e23b92a862" },
  },
};

const port = (url: string) => Number(new URL(url).port);
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Downloads `url` to `path` unless a file with that hash is already there. */
async function fetchPinned(url: string, sha: string, path: string) {
  if (existsSync(path) && sha256(path) === sha) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha) throw new Error(`${url}: SHA-256 ${got}, expected ${sha}`);
  await Bun.write(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
}

async function fetchAll() {
  mkdirSync(BIN, { recursive: true });
  const rustfs = RUSTFS[platform];
  if (!rustfs) throw new Error(`No RustFS build is pinned for ${platform}`);
  await fetchPinned(rustfs.url, rustfs.sha256, `${BIN}/rustfs.zip`);
  const unpacked = existsSync(`${BIN}/rustfs`) && existsSync(`${BIN}/rustfs.sha256`) && readFileSync(`${BIN}/rustfs.sha256`, "utf8") === rustfs.sha256;
  if (!unpacked) {
    rmSync(`${BIN}/unzip`, { recursive: true, force: true });
    const unzip = Bun.spawnSync(["unzip", "-q", "-o", `${BIN}/rustfs.zip`, "rustfs", "-d", `${BIN}/unzip`]);
    if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr}`);
    renameSync(`${BIN}/unzip/rustfs`, `${BIN}/rustfs`);
    rmSync(`${BIN}/unzip`, { recursive: true, force: true });
    await Bun.write(`${BIN}/rustfs.sha256`, rustfs.sha256);
  }
  chmodSync(`${BIN}/rustfs`, 0o755);
  console.log(`RustFS: ${BIN}/rustfs`);
  const orthanc = ORTHANC[platform];
  if (!orthanc) { console.log(`Orthanc: no build for ${platform}, so its backend is unavailable`); return; }
  await fetchPinned(orthanc.server.url, orthanc.server.sha256, `${BIN}/Orthanc`);
  await fetchPinned(orthanc.dicomweb.url, orthanc.dicomweb.sha256, `${BIN}/libOrthancDicomWeb.so`);
  chmodSync(`${BIN}/Orthanc`, 0o755);
  console.log(`Orthanc: ${BIN}/Orthanc`);
}

/** The command line for each server, with its data under $DEMO_STORAGE. */
async function command(name: "s3" | "orthanc"): Promise<string[] | undefined> {
  if (name === "s3") {
    mkdirSync(`${STORAGE}/s3`, { recursive: true });
    return [`${BIN}/rustfs`, "server", "--address", `127.0.0.1:${port(CONFIG.s3.endpoint)}`, "--access-key", CONFIG.s3.accessKey, "--secret-key", CONFIG.s3.secretKey, `${STORAGE}/s3`];
  }
  if (!existsSync(`${BIN}/Orthanc`)) return undefined;
  const db = `${STORAGE}/orthanc-db`;
  mkdirSync(db, { recursive: true });
  await Bun.write(`${STORAGE}/orthanc.json`, JSON.stringify({
    Name: "smart-imaging-proxy",
    StorageDirectory: db,
    IndexDirectory: db,
    HttpPort: port(CONFIG.orthanc.base),
    HttpBindAddresses: ["127.0.0.1"],
    DicomServerEnabled: false,
    RemoteAccessAllowed: false,
    AuthenticationEnabled: true,
    RegisteredUsers: { [CONFIG.orthanc.user]: CONFIG.orthanc.password },
    Plugins: [`${BIN}/libOrthancDicomWeb.so`],
    DicomWeb: { Enable: true, Root: "/dicom-web/" },
  }, null, 2));
  return [`${BIN}/Orthanc`, `${STORAGE}/orthanc.json`];
}

const pidFile = (name: string) => `${STORAGE}/${name}.pid`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const running = (name: string) => {
  const pid = existsSync(pidFile(name)) ? Number(readFileSync(pidFile(name), "utf8")) : 0;
  return pid && alive(pid) ? pid : undefined;
};

async function start() {
  for (const name of ["s3", "orthanc"] as const) {
    if (running(name)) { console.log(`${name}: already running`); continue; }
    const cmd = await command(name);
    if (!cmd) { console.log(`${name}: not installed here, skipped`); continue; }
    const log = Bun.file(`${STORAGE}/${name}.log`);
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: log, stderr: log, detached: true });
    p.unref();
    await Bun.write(pidFile(name), `${p.pid}\n`);
    console.log(`${name}: started, log ${STORAGE}/${name}.log`);
  }
}

async function stop() {
  for (const name of ["s3", "orthanc"]) {
    const pid = running(name);
    rmSync(pidFile(name), { force: true });
    if (!pid) continue;
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 40 && alive(pid); i++) await Bun.sleep(250);
    console.log(`${name}: stopped`);
  }
}

/** Runs one server in the foreground, passing on the signals a service manager sends. */
async function run(name: "s3" | "orthanc") {
  const cmd = await command(name);
  if (!cmd) { console.error(`${name} isn't installed here`); process.exit(1); }
  const p = Bun.spawn(cmd, { stdio: ["ignore", "inherit", "inherit"] });
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => p.kill(sig));
  process.exit(await p.exited);
}

const [what, name] = process.argv.slice(2);
if (what === "fetch") await fetchAll();
else if (what === "start") await start();
else if (what === "stop") await stop();
else if (what === "run" && (name === "s3" || name === "orthanc")) await run(name);
else { console.error("usage: bun scripts/backends.ts fetch | start | stop | run s3|orthanc"); process.exit(2); }
