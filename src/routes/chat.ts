import crypto from 'node:crypto';
import { Context } from 'hono';
import { pickAccount } from '../services/auth.ts';
import { config } from '../services/configService.ts';
import { logStore } from '../services/logStore.ts';
import { modelRouter } from '../services/modelRouter.ts';
import { RetryableQwenStreamError } from '../services/qwen.ts';
import { uploadLargeTextAsFile } from '../services/qwenFileUpload.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { cleanTextOfXmlArtifacts } from '../tools/xmlToolParser.ts';
import { OpenAIRequest } from '../types/openai.ts';
import { checkContextWindow, estimateTokens } from '../utils/tokenEstimator.ts';
import { validateOpenAIRequest } from '../utils/validation.ts';
import {
  acquireSessionWithCorrections,
  buildQwenMessages,
  createQwenStreamWithRetry,
  getModelSpecs,
  handleImageModelFallback,
} from './chatHelpers.ts';
import { handleNonStreamingRequest } from './chatNonStreaming.ts';
import { handleStreamingRequest } from './chatStreaming.ts';

export {
  commonPrefixLen,
  getNewContent,
} from './chatHelpers.ts';

const MAX_MESSAGE_SIZE = 10_000_000; // 10MB — large payloads are uploaded as files via Qwen's file API

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

  // Per-message size validation to prevent OOM during estimateTokens
  if (body.messages && Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      if (content && content.length > MAX_MESSAGE_SIZE) {
        const err = new Error(`Message content exceeds maximum size of ${MAX_MESSAGE_SIZE} characters`);
        (err as any).upstreamStatus = 400;
        (err as any).type = 'invalid_request_error';
        (err as any).code = 'message_too_large';
        throw err;
      }
    }
  }

  let isStream = body.stream ?? false;
  const streamMode = config.get('STREAMING_MODE', 'auto');
  if (streamMode === 'stream') isStream = true;
  else if (streamMode === 'non-stream') isStream = false;
  const toolCalling = config.getBool('TOOL_CALLING', true);
  const cleanOutput = config.getBool('CLEAN_OUTPUT', true);

  const messages = body.messages || [];
  handleImageModelFallback(body, messages);
  const { maxContext, maxOutput } = getModelSpecs(body);

  const formattedMessages = messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content) ? m.content.map((c: any) => c.text || JSON.stringify(c)).join('\n') : String(m.content ?? ''),
  }));
  const estimatedTokens = estimateTokens(formattedMessages.map((m) => m.content).join('\n'));
  const contextCheck = checkContextWindow(estimatedTokens, maxContext, maxOutput, body.model as string, formattedMessages);

  return {
    body,
    isStream,
    toolCalling,
    cleanOutput,
    messages,
    contextCheck,
    availableTokens: contextCheck.availableTokens,
  };
}

async function setupSession(messages: any[], body: OpenAIRequest, availableTokens: number, toolCalling: boolean, logId: string) {
  const { qwenMessages: processedMessages } = buildQwenMessages(messages, body, availableTokens, toolCalling);

  let lastFailedEmail: string | undefined;

  const isThinkingModel = !body.model.includes('no-thinking');
  const MAX_ACCOUNT_RETRIES = 5;
  let lastError: any;

  for (let attempt = 0; attempt < MAX_ACCOUNT_RETRIES; attempt++) {
    const selectedAccount = await pickAccount(lastFailedEmail);
    // If no accounts available AND none are throttled, there are simply no accounts configured.
    // Fall through to acquireSessionWithCorrections with undefined email (mock Playwright path).
    const accountEmail = selectedAccount?.email;
    if (!selectedAccount && attempt > 0) {
      // On retry: if still no accounts, all are throttled — stop retrying
      throw lastError || new Error('All accounts are rate-limited. Please wait and try again later.');
    }

    let sessionResult;
    try {
      sessionResult = await acquireSessionWithCorrections(accountEmail, processedMessages);
    } catch (err) {
      lastFailedEmail = accountEmail;
      lastError = err;
      continue; // Try next account
    }
    const { session, qwenMessages: sessionMessages, nextParentId, sessionHeaders, resolvedEmail } = sessionResult;

    // Populate the account that served this request
    logStore.updateEntry(logId, (entry) => {
      entry.accountEmail = resolvedEmail;
    });

    // Upload large message content as a txt file attachment.
    // Qwen's per-message limit is ~131K characters. Payloads above this threshold
    // are uploaded via Qwen's file API and replaced with a short reference.
    // Keeps the chat completion request body small (<130KB) to prevent bot detection.
    // Skip in test mode — mocked browser cannot upload files.
    const FILE_UPLOAD_THRESHOLD = 100_000; // 100K chars — upload anything above this
    if (!process.env.TEST_MOCK_PLAYWRIGHT && sessionMessages[0] && typeof sessionMessages[0].content === 'string') {
      const originalContent = sessionMessages[0].content;
      const charCount = originalContent.length;
      if (charCount > FILE_UPLOAD_THRESHOLD) {
        try {
          const fileAttachment = await uploadLargeTextAsFile(resolvedEmail, originalContent, 'payload.txt');
          // Replace content with a short reference — the full text is in the file attachment.
          // Keeping the original content would make the request body >130KB, triggering bot detection.
          sessionMessages[0].content = `The attached file "payload.txt" contains the full text content (${charCount} characters). Please process and respond to the content of the attached file.`;
          sessionMessages[0].files = [fileAttachment];
          console.log(
            `[Chat] Payload uploaded as file — id=${fileAttachment.id}, chars=${charCount}, content replaced with short reference`,
          );
        } catch (uploadErr: any) {
          console.error(`[Chat] File upload failed: ${uploadErr.message} — falling back to inline content`);
          // If upload fails, keep content inline (will work for payloads under 131K)
          // For over-131K payloads, this will hit Qwen's limit but there's no other option.
        }
      }
    }

    let routedModel;
    let streamResult;
    try {
      routedModel = await modelRouter.route(body.model);
      streamResult = await createQwenStreamWithRetry(
        sessionMessages,
        isThinkingModel,
        routedModel,
        session.chatId,
        nextParentId,
        resolvedEmail,
        body.tools,
        body.tool_choice,
      );
    } catch (err: any) {
      // Release the acquired session to prevent pool exhaustion + inFlight leak
      sessionPool.release(session.chatId, nextParentId, sessionHeaders, resolvedEmail, false);

      console.log(`[Chat] Request failed on ${resolvedEmail}: ${err.message || err} (attempt ${attempt + 1}/${MAX_ACCOUNT_RETRIES})`);

      // If rate limited or retryable, try next account silently
      if (
        err.upstreamStatus === 429 ||
        /RateLimited|daily usage limit|CAPTCHA|FAIL_SYS_USER_VALIDATE/i.test(err.message || '') ||
        err instanceof RetryableQwenStreamError
      ) {
        lastFailedEmail = resolvedEmail;
        lastError = err;
        continue;
      }
      throw err; // Non-rate-limit errors propagate immediately
    }
    let { stream, abortController: qwenAbortController } = streamResult;

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

    console.log(`[Chat] Request routed to ${resolvedEmail} — stream ready (attempt ${attempt + 1})`);

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
    messages: messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) })),
  };
}

export async function chatCompletions(c: Context) {
  const logId = crypto.randomUUID();
  const _requestStartTime = Date.now();
  try {
    const parsed = await parseRequestBody(c);
    const { body, isStream, toolCalling, cleanOutput, messages, contextCheck } = parsed;
    console.log(
      `[Chat] Request: model=${body.model} stream=${isStream} msgs=${messages.length} tools=${body.tools?.length || 0} msgSizes=[${messages.map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length}`).join(',')}]`,
    );
    logStore.createEntry(logId, body.model, isStream);
    const logEntry = logStore.getEntry(logId);
    if (logEntry) populateLogEntry(logEntry, body, messages);

    if (!contextCheck.ok) {
      logStore.updateEntry(logId, (entry) => {
        entry.finalResponse = entry.finalResponse || { finishReason: '', toolCallCount: 0, contentPreview: '' };
        entry.finalResponse.finishReason = 'context_window_exceeded';
      });
      logStore.finalizeRequest(logId);
      return c.json(
        {
          error: {
            message: contextCheck.message,
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_window_exceeded',
          },
        },
        400,
      );
    }

    const { session, nextParentId, sessionHeaders, resolvedEmail, stream, qwenAbortController } = await setupSession(
      messages,
      body,
      contextCheck.availableTokens!,
      toolCalling,
      logId,
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
            message: 'All accounts have reached their daily usage limit. Please try again later.',
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
