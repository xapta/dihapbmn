// Akses Google API dengan service account Firebase (secret FIREBASE_SERVICE_ACCOUNT), tanpa dependensi.
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');

export function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Secret FIREBASE_SERVICE_ACCOUNT belum diisi.');
  return JSON.parse(raw);
}
export const projectId = () => process.env.FIREBASE_PROJECT_ID || serviceAccount().project_id;

let cached = null;
export async function accessToken() {
  if (cached && cached.exp > Date.now() + 60e3) return cached.token;
  const sa = serviceAccount(), now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit',
  }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Gagal mendapat akses Google: ' + JSON.stringify(j).slice(0, 200));
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

export async function gapi(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text }; }
  if (!r.ok) { const e = new Error(`${init.method || 'GET'} ${url.split('?')[0]} → ${r.status}: ${(j?.error?.message || text).slice(0, 300)}`); e.status = r.status; throw e; }
  return j;
}

// ---------- Firestore REST ----------
const FS = () => `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/(default)/documents`;
export function fromValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
export const fromFields = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fromValue(v)]));
export function toValue(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === 'string') return { stringValue: x };
  if (typeof x === 'boolean') return { booleanValue: x };
  if (typeof x === 'number') return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toValue(v)])) } };
}
export async function fsQuery(collectionId, field, op, value, limit = 10) {
  const res = await gapi(`${FS()}:runQuery`, {
    method: 'POST',
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op, value: toValue(value) } }, limit } }),
  });
  return (res || []).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), name: x.document.name, ...fromFields(x.document.fields) }));
}
export async function fsList(path) {
  let out = [], token = '';
  do {
    const j = await gapi(`${FS()}/${path}?pageSize=300${token ? '&pageToken=' + token : ''}`);
    out = out.concat((j?.documents || []).map(d => ({ id: d.name.split('/').pop(), ...fromFields(d.fields) })));
    token = j?.nextPageToken || '';
  } while (token);
  return out;
}
export async function fsPatch(path, data) {
  const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return gapi(`${FS()}/${path}?${mask}`, { method: 'PATCH', body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }) });
}
export const fsDelete = path => gapi(`${FS()}/${path}`, { method: 'DELETE' });
