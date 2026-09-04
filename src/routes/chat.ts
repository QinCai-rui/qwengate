import crypto from 'node:crypto';
import { Context } from 'hono';
import { pickAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError, resolveThinkingMode } from '../services/qwen.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
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
  let lastFailedEmail: string | undefined;
  let useBrowserTransport = false;

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

    const { qwenMessages: processedMessages } = buildQwenMessages(messages, body, toolCalling);
    const requestMessages = processedMessages.map((message) => ({ ...message, files: [] as unknown[] }));

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(
        accountEmail,
        requestMessages,
        requestSignal,
        useBrowserTransport ? 'browser' : 'wreq',
      );
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
        useBrowserTransport ? 'browser' : 'wreq',
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
      // Bot detection / CAPTCHA: retry through the account's real browser
      // context. Do not throttle the account or upload the conversation.
      if ((err.message || '').includes('FAIL_SYS_USER_VALIDATE') || (err.message || '').includes('CAPTCHA')) {
        useBrowserTransport = true;
        lastFailedEmail = undefined;
        lastError = err;
        continue;
      }
      if (err instanceof RetryableQwenStreamError) {
        lastFailedEmail = undefined;
        lastError = err;
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

    // Qwen can split a non-SSE JSON rejection across several network chunks.
    // Buffer until a complete payload arrives so we can retry before starting the
    // client response, rather than forwarding an empty completion.
    const initialChunks: Uint8Array[] = [];
    const initialDecoder = new TextDecoder();
    let initialText = '';
    let initialDone = firstChunk.done;
    if (firstChunk.value) {
      initialChunks.push(firstChunk.value);
      initialText += initialDecoder.decode(firstChunk.value, { stream: true });
    }

    while (!initialDone) {
      const trimmedInitial = initialText.trim();
      const initialError = parseQwenErrorPayload(trimmedInitial);
      if (initialError) break;

      const initialPayload = trimmedInitial.startsWith('data: ') ? trimmedInitial.slice(6).split('\n')[0] : trimmedInitial;
      if (initialPayload === '[DONE]') break;
      try {
        if (initialPayload) {
          JSON.parse(initialPayload);
          break;
        }
      } catch {
        // A partial JSON or SSE frame: read another chunk before deciding.
      }

      const nextChunk = await streamReader.read();
      initialDone = nextChunk.done;
      if (nextChunk.value) {
        initialChunks.push(nextChunk.value);
        initialText += initialDecoder.decode(nextChunk.value, { stream: true });
      }
    }
    initialText += initialDecoder.decode();

    const firstChunkError = parseQwenErrorPayload(initialText);
    if (firstChunkError) {
      streamReader.cancel().catch(() => {});
      qwenAbortController.abort();
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      const upstreamError = Object.assign(new Error(firstChunkError.message), { upstreamStatus: firstChunkError.status });
      if (firstChunkError.message.includes('FAIL_SYS_USER_VALIDATE')) {
        useBrowserTransport = true;
        lastFailedEmail = undefined;
        lastError = upstreamError;
        logStore.log('warn', 'chat', `[Chat] CAPTCHA response from ${resolvedEmail}; retrying through the real browser context`);
        logStore.addError(logId, upstreamError.message);
        continue;
      }
      throw upstreamError;
    }

    // Reconstruct stream with the first chunk prepended, then pipe remaining data through.
    // This lets us keep the first chunk (already read) while allowing async consumption.
    stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const initialChunk of initialChunks) controller.enqueue(initialChunk);
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
