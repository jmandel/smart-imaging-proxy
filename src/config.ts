export const PORTS = { demo: 4600, proxy: 4601, imaging: 4602, auth: 4603, trace: 4604 };
const host = "http://127.0.0.1";
export const CONFIG = {
  demoUrl: `${host}:${PORTS.demo}`,
  proxyUrl: `${host}:${PORTS.proxy}`,
  imagingUrl: `${host}:${PORTS.imaging}`,
  authUrl: `${host}:${PORTS.auth}`,
  traceUrl: `${host}:${PORTS.trace}`,
  minio: { endpoint: "http://127.0.0.1:4610", accessKey: "demo-minio", secretKey: "demo-minio-secret", bucket: "smart-imaging" },
  orthanc: { base: "http://127.0.0.1:4611", user: "demo-proxy", password: "demo-orthanc-secret" },
};
