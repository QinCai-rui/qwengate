import crypto from 'node:crypto';
import { Context } from 'hono';
import { decrementInFlight, pickAccount, throttleAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError, resolveThinkingMode } from '../services/qwen.ts';
import { uploadContextAsFile } from '../services/qwenContextUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  detachOlderContext,
  handleImageModelFallback,
  parseQwenErrorPayload,
} from './chatHelpers.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handleStreamingRequest } from './chatStreaming.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpers.ts';

async function parseRequestBody(c: Context) {
  const rawBody = await c.req.json();

  // Schema validation via zod — catches malformed requests early
  const validation = validateOpenAIRequest(rawBody);
  if (!validation.ok) {
    const err = new Error(validation.error!);
    (err as any).upstreamStatus = validation.status || 400;
    (err as any).type = 'invalid_request_error';
    (err as any).code = validation.code || 'invalid_request_error';
    throw err;
  }

  const body = validation.data as unknown as OpenAIRequest;

  let isStream = body.stream ?? false;
  const streamMode = config.get('STREAMING_MODE', 'auto');
  if (streamMode === 'stream') isStream = true;
  else if (streamMode === 'non-stream') isStream = false;
  const toolCalling = config.getBool('TOOL_CALLING', true);
  const cleanOutput = config.getBool('CLEAN_OUTPUT', true);

  const messages = body.messages || [];

  await handleImageModelFallback(body, messages);

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
  };
}

async function setupSession(messages: any[], body: OpenAIRequest, toolCalling: boolean, logId: string, requestSignal?: AbortSignal) {
  // File upload happens inside retry loop using the same account as the request
  // (accounts can't access files uploaded by other accounts — must share the account)
  let lastFailedEmail: string | undefined;
  let forceFileUpload = false;

  const thinkingMode = resolveThinkingMode(body.model, body);
  const MAX_ACCOUNT_RETRIES = 5;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    if (requestSignal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const selectedAccount = await pickAccount(lastFailedEmail);
    const accountEmail = selectedAccount?.email;
    if (!selectedAccount && attempt > 0) {
      // On retry: if still no accounts, all are throttled — stop retrying
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    // A CAPTCHA response is often triggered by a large inline conversation. Retry
    // with every older turn attached as a file while preserving the latest turn.
    const { qwenMessages: processedMessages } = buildQwenMessages(messages, body, toolCalling);
    const detachedContext = detachOlderContext(processedMessages, forceFileUpload);
    const requestMessages = processedMessages.map((message) => ({ ...message, files: [] as unknown[] }));
    if (detachedContext) {
      if (!accountEmail) throw new Error('Unable to upload older conversation history without a Qwen account');
      try {
        const contextFile = await uploadContextAsFile(accountEmail, detachedContext, requestSignal);
        requestMessages[0] = { ...requestMessages[0], files: [...(requestMessages[0].files || []), contextFile] };
      } catch (err) {
        decrementInFlight(accountEmail);
        throw err;
      }
    }

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, requestMessages, requestSignal);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      logStore.log(
        'warn',
        'chat',
        `[Chat] Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      logStore.addError(logId, `Session acquire failed for ${accountEmail || '?'}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // Try next account
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;

    // Populate the account that served this request
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    let routedModel;
    let streamResult;
    try {
      routedModel = await modelRouter.route(body.model);
      streamResult = await createQwenStreamWithRetry(
        sessionMessages,
        thinkingMode,
        routedModel,
        session.chatId,
        nextParentId,
        resolvedEmail,
        toolCalling ? body.tools : undefined,
        toolCalling ? body.tool_choice : 'none',
        requestSignal,
        sessionHeaders,
      );
    } catch (err: any) {
      // Release the acquired session to prevent pool exhaustion + inFlight leak
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      logStore.log(
        'debug',
        'chat',
        `[Chat] Request failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `Stream creation failed for ${resolvedEmail}: ${err.message || String(err)}`);

      // If rate limited, try next account — Qwen didn't process the request yet
      if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // Bot detection / CAPTCHA: Qwen rejected BEFORE processing (safe to retry on another account).
      // Throttle the detected account so pickAccount won't pick it again.
      if (
        (err.message || '').includes('FAIL_SYS_USER_VALIDATE') ||
        (err.message || '').includes('CAPTCHA') ||
        err instanceof RetryableQwenStreamError
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        continue;
      }
      // Timeout / slow response: Qwen didn't respond in time — skip to next account without penalty
      if (
        err.name === 'AbortError' ||
        (err.message || '').includes('timed out') ||
        (err.message || '').includes('timeout') ||
        (err.message || '').includes('ETIMEDOUT') ||
        err.upstreamStatus === 408 ||
        err.upstreamStatus === 504
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      // All other errors (network, session): Qwen may have processed the request.
      // Don't throttle — let the user retry manually.
      throw err;
    }
    let { stream, abortController: qwenAbortController } = streamResult;

    // First-chunk timeout: Qwen sometimes sends HTTP headers but never body data (silent hang).
    // Wait up to 60s for the first byte. If none arrives, release this session and try next account.
    const FIRST_CHUNK_MS = 60_000;
    const streamReader = stream.getReader();
    let firstChunk: any;
    let firstChunkTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      firstChunk = await Promise.race([
        streamReader.read(),
        new Promise<never>((_, reject) => {
          firstChunkTimer = setTimeout(
            () => reject(new Error(`No first chunk from ${resolvedEmail} within ${FIRST_CHUNK_MS / 1000}s`)),
            FIRST_CHUNK_MS,
          );
        }),
      ]);
    } catch (timeoutErr) {
      clearTimeout(firstChunkTimer);
      logStore.log(
        'warn',
        'chat',
        `[Chat] First-chunk timeout for ${resolvedEmail} after stream started (${attempt + 1}/${MAX_ACCOUNT_RETRIES})`,
      );
      logStore.addError(logId, `First-chunk timeout for ${resolvedEmail}`);
      streamReader.cancel().catch(() => {});
      qwenAbortController?.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);
      lastFailedEmail = resolvedEmail;
      lastError = timeoutErr as Error;
      continue;
    }
    clearTimeout(firstChunkTimer);

    const firstChunkText = firstChunk.value ? new TextDecoder().decode(firstChunk.value) : '';
    const firstChunkError = parseQwenErrorPayload(firstChunkText);
    if (firstChunkError) {
      streamReader.cancel().catch(() => {});
      qwenAbortController.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      const upstreamError = Object.assign(new Error(firstChunkError.message), { upstreamStatus: firstChunkError.status });
      if (firstChunkError.message.includes('FAIL_SYS_USER_VALIDATE')) {
        forceFileUpload = true;
        lastFailedEmail = resolvedEmail;
        lastError = upstreamError;
        if (resolvedEmail) throttleAccount(resolvedEmail, 5 * 60 * 1000);
        logStore.log('warn', 'chat', `[Chat] CAPTCHA response from ${resolvedEmail}; retrying with older context uploaded as a file`);
        logStore.addError(logId, upstreamError.message);
        continue;
      }
      throw upstreamError;
    }

    // Reconstruct stream with the first chunk prepended, then pipe remaining data through.
    // This lets us keep the first chunk (already read) while allowing async consumption.
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        if (!firstChunk.done && firstChunk.value) controller.enqueue(firstChunk.value);
        try {
          while (true) {
            const { done, value } = await streamReader.read();
            if (done) break;
            // Honor backpressure: if the consumer is behind, wait before
            // enqueueing so the client's socket drains instead of receiving
            // a pre-filled queue all at once.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              await new Promise((r) => setTimeout(r, 1));
            }
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    // Build finalPrompt for logStore debug logging only
    const finalPrompt = sessionMessages
      .map((m: any) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role}: ${content}`;
      })
      .join('\n\n');
    logStore.updateEntry(logId, (entry) => {
      entry.promptToQwen = {
        systemPromptLength: 0,
        totalLength: finalPrompt.length,
        preview: finalPrompt.length > 1000 ? finalPrompt.substring(0, 1000) + '...' : finalPrompt,
      };
    });

    logStore.log('debug', 'chat', `[Chat] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

    return {
      sessionMessages,
      session,
      nextParentId,
      sessionHeaders,
      resolvedEmail,
      stream,
      qwenAbortController,
    };
  }

  // All account retries exhausted — throw a clean user-facing error
  throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
}

function populateLogEntry(logEntry: any, body: OpenAIRequest, messages: any[]): void {
  const rawContent = messages.length > 0 ? messages[messages.length - 1].content : '';
  const lastMsg = typeof rawContent === 'string' ? rawContent : rawContent !== undefined ? JSON.stringify(rawContent) : '';
  logEntry.clientRequest = {
    messageCount: messages.length,
    roles: messages.map((m) => m.role),
    hasTools: !!body.tools?.length,
    toolNames: body.tools?.map((t: any) => t.function?.name || t.name) || [],
    tool_choice: body.tool_choice ? (typeof body.tool_choice === 'string' ? body.tool_choice : JSON.stringify(body.tool_choice)) : null,
    lastMessage: lastMsg.substring(0, 300),
    messages: messages.map((m) => ({
      role: m.role,
      content: (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).substring(0, 2000),
    })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages } = parsed;
    logStore.log(
      'debug',
      'chat',
      `[Chat] Request: model=${body.model} stream=${isStream} msgs=${messages.length} tools=${body.tools?.length || 0} msgSizes=[${messages.map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length}`).join(',')}]`,
    );
    logStore.createEntry(logId, body.model, isStream);
    logStore.updateEntry(logId, (entry) => {
      entry.apiType = 'openai';
    });
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupSession(
      messages,
      body,
      toolCalling,
      logId,
      c.req.raw.signal,
    );

    const completionId = 'chatcmpl-' + crypto.randomUUID();

    if (!isStream) {
      return handleNonStreamingRequest({
        c,
        logId,
        completionId,
        body,
        session,
        stream,
        resolvedEmail,
        initialParentId: nextParentId,
        sessionHeaders,
        toolCalling,
        cleanOutput,
        qwenAbortController,
      });
    }

    return await handleStreamingRequest({
      c,
      logId,
      completionId,
      body,
      session,
      stream,
      qwenAbortController,
      resolvedEmail,
      initialParentId: nextParentId,
      sessionHeaders,
      toolCalling,
      cleanOutput,
    });
  } catch (err: any) {
    console.error(`[Chat] <<< Request failed after ${Date.now() - _requestStartTime}ms: ${err?.message || err}`);
    console.error('Error in chatCompletions:', err);
    logStore.addError(logId, err.message || String(err));
    logStore.updateEntry(logId, (entry) => {
      entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
      entry.finalResponse.finishReason = 'error';
    });
    logStore.finalizeRequest(logId);

    // Rate limit errors after all accounts exhausted — clean user-facing message
    if (err.upstreamStatus === 429 || /RateLimited|daily usage limit/i.test(err.message || '')) {
      return c.json(
        {
          error: {
            message: err.message || 'All accounts have reached their daily usage limit. Please try again later.',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        429,
      );
    }

    const status = err.upstreamStatus || 500;
    const cleanMessage = cleanTextOfXmlArtifacts(err.message || String(err)).cleanedText || err.message || 'Internal error';
    return c.json(
      {
        error: {
          message: cleanMessage,
          type: err.type || 'server_error',
          code: err.code || undefined,
        },
      },
      status,
    );
  }
}
