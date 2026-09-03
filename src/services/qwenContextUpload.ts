import crypto from 'node:crypto';
import { getAccountByEmail, getTokenWithAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';

interface StsTokenResponse {
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
  bucketname: string;
  endpoint: string;
  file_id: string;
  file_path: string;
  file_url: string;
}

export interface QwenContextAttachment {
  type: 'file';
  file: {
    created_at: number;
    data: Record<string, never>;
    filename: string;
    hash: null;
    id: string;
    user_id: string;
    meta: { name: string; size: number; content_type: string; parse_meta: { parse_status: 'success' } };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string;
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: 'uploaded';
  greenNet: 'success';
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: 'file';
  file_class: 'document';
  uploadTaskId: string;
}

function accountHeaders(token: string, email: string) {
  const profileCookies = getAccountByEmail(email)?.profileCookies || '';
  const extraCookies = profileCookies
    .replace(/\btoken=[^;]+;?\s*/g, '')
    .replace(/;+$/, '')
    .trim();
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    source: 'web',
    cookie: `token=${token}${extraCookies ? `; ${extraCookies}` : ''}`,
    origin: QWEN_API_BASE,
  };
}

async function getStsToken(email: string, byteLength: number, signal?: AbortSignal): Promise<StsTokenResponse> {
  const tokenInfo = await getTokenWithAccount(email);
  if (!tokenInfo) throw new Error(`No Qwen session for ${email}`);

  const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/files/getstsToken`, {
    method: 'POST',
    headers: accountHeaders(tokenInfo.token, email),
    body: JSON.stringify({ filename: 'context.txt', filesize: String(byteLength), filetype: 'file' }),
    accountEmail: email,
    signal,
  });
  if (!response.ok) throw new Error(`Qwen context upload setup failed: ${response.status}`);

  const payload = await response.json();
  if (!payload?.data) throw new Error('Qwen context upload setup returned an invalid response');
  return payload.data;
}

function hmacSha1Base64(key: string, message: string): string {
  return crypto.createHmac('sha1', key).update(message).digest('base64');
}

async function uploadToOss(sts: StsTokenResponse, content: Buffer, signal?: AbortSignal): Promise<void> {
  let objectKey = sts.file_path;
  const bucketPrefix = `${sts.bucketname}/`;
  if (objectKey.startsWith(bucketPrefix)) objectKey = objectKey.slice(bucketPrefix.length);

  let endpoint = sts.endpoint.replace(/\/+$/, '');
  if (!endpoint.includes(sts.bucketname)) endpoint = `https://${sts.bucketname}.${endpoint.replace(/^https?:\/\//, '')}`;
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.protocol !== 'https:') throw new Error('Qwen returned an insecure object-storage endpoint');

  const contentType = 'text/plain';
  const date = new Date().toUTCString();
  const canonicalRequest = [
    'PUT',
    '',
    contentType,
    date,
    `x-oss-security-token:${sts.security_token}`,
    `/${sts.bucketname}/${objectKey}`,
  ].join('\n');
  const response = await fetch(`${endpoint}/${objectKey}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      Date: date,
      Authorization: `OSS ${sts.access_key_id}:${hmacSha1Base64(sts.access_key_secret, canonicalRequest)}`,
      'x-oss-security-token': sts.security_token,
    },
    body: content as any,
    signal,
  });
  if (!response.ok) throw new Error(`Qwen context upload failed: ${response.status} ${response.statusText}`);
}

async function waitForParse(email: string, fileId: string, signal?: AbortSignal): Promise<void> {
  const tokenInfo = await getTokenWithAccount(email);
  if (!tokenInfo) throw new Error(`No Qwen session for ${email}`);
  const headers = accountHeaders(tokenInfo.token, email);

  const parseResponse = await browserlessFetch(`${QWEN_API_BASE}/api/v2/files/parse`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file_id: fileId }),
    accountEmail: email,
    signal,
  });
  if (!parseResponse.ok) throw new Error(`Qwen context parse failed: ${parseResponse.status}`);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await browserlessFetch(`${QWEN_API_BASE}/api/v2/files/parse/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ file_id_list: [fileId] }),
      accountEmail: email,
      signal,
    });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const status = payload?.data?.[0]?.status || payload?.status;
      if (status === 'success') return;
      if (status === 'failed') throw new Error('Qwen context parsing failed');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Context upload aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  throw new Error('Qwen context parsing timed out');
}

/** Upload only detached conversation history when Qwen's inline request becomes too large. */
export async function uploadContextAsFile(email: string, text: string, signal?: AbortSignal): Promise<QwenContextAttachment> {
  const content = Buffer.from(text, 'utf8');
  if (content.length > 2_000_000) throw new Error('Context upload exceeds the maximum size');
  const sts = await getStsToken(email, content.length, signal);
  await uploadToOss(sts, content, signal);
  await waitForParse(email, sts.file_id, signal);

  const now = Date.now();
  const userId = sts.file_path.split('/')[0] || '';
  logStore.log('debug', 'upload', `[ContextUpload] Attached ${content.length} bytes of older history for ${email}`);
  return {
    type: 'file',
    file: {
      created_at: now,
      data: {},
      filename: 'context.txt',
      hash: null,
      id: sts.file_id,
      user_id: userId,
      meta: { name: 'context.txt', size: content.length, content_type: 'text/plain', parse_meta: { parse_status: 'success' } },
      update_at: now,
      lastModified: now,
      name: 'context.txt',
      webkitRelativePath: '',
      size: content.length,
      type: 'text/plain',
    },
    id: sts.file_id,
    url: sts.file_url,
    name: 'context.txt',
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    greenNet: 'success',
    size: content.length,
    error: '',
    itemId: crypto.randomUUID(),
    file_type: 'text/plain',
    showType: 'file',
    file_class: 'document',
    uploadTaskId: crypto.randomUUID(),
  };
}
