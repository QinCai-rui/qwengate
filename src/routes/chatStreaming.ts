import { Context } from 'hono';
import { stream as honoStream } from 'hono/streaming';
import type { OpenAIRequest } from '../utils/types.ts';
import { StreamingToolParser } from '../tools/parser.ts';
import { validateSingleToolCall } from '../tools/guard.ts';
import { filterContent, stripToolCallArtifacts, stripStreamingDelta } from '../utils/contentFilter.ts';
import { StreamingContentFilter } from './pipeline/StreamingContentFilter.ts';
import { StreamingEchoFilter } from './pipeline/StreamingEchoFilter.ts';
import { sessionPool } from '../services/sessionPool.ts';
import { logStore } from '../services/logStore.ts';
import {
  logDebug,
  streamDebugLog,
  detectCumulativeChunk,
  getSnapshotDelta,
  cleanThinkTags,
  parseQwenErrorPayload,
  extractDeltaContent,
  checkAmplificationGuard,
  pendingCorrections,
  type AmplificationGuardState,
} from './chatHelpers.ts';
import { config } from '../services/configService.ts';
import {
  writeEvent,
  writeReasoningEvent,
  writeContentDelta,
  writeToolCallEvent,
  writeDeferredThinking,
  makeChoice,
  buildChunkEvent,
  buildUsage,
  checkFinalAmplification,
  scheduleCleanup,
  cleanupImmediately,
} from './chatStreamingHelpers.ts';

export interface StreamingContext {
  c: Context;
  logId: string;
  completionId: string;
  body: OpenAIRequest;
  finalPrompt: string;
  session: { chatId: string; parentId: string | null; cachedHeaders: any; accountEmail?: string };
  stream: ReadableStream;
  qwenAbortController: AbortController;
  resolvedEmail: string;
  initialParentId: string | null;
  sessionHeaders: any;
  toolCalling: boolean;
  cleanOutput: boolean;
  toolResultContents: string[];
}

export async function handleStreamingRequest(ctx: StreamingContext): Promise<Response> {
  const { c, logId, completionId, body, finalPrompt, session, stream, qwenAbortController, resolvedEmail, sessionHeaders, toolCalling, cleanOutput, toolResultContents } = ctx;
  let nextParentId = ctx.initialParentId;

  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'close');

  return honoStream(c, async (streamWriter: any) => {
    let streamDone = false;
    if (c.req.raw?.signal) {
      c.req.raw.signal.addEventListener('abort', () => {
        streamDone = true;
      });
    }
    let heartbeatInterval: any;
    let totalChunks = 0;
    let streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let streamReleased = false;
    try {
      await streamWriter.write(': heartbeat\n\n');

      heartbeatInterval = setInterval(async () => {
        try {
          await streamWriter.write(': keep-alive\n\n');
        } catch (_e) {
          clearInterval(heartbeatInterval);
          streamDone = true;
        }
      }, 15000);
      if (heartbeatInterval && typeof heartbeatInterval.unref === 'function') {
        heartbeatInterval.unref();
      }

      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ role: 'assistant', content: '' })]));

      streamReader = stream.getReader();
      let reader: ReadableStreamDefaultReader<Uint8Array> = streamReader;
      const decoder = new TextDecoder();

      let _inThinkingState = false;
      let _thinkingFragments: Record<string, boolean> = {};
      let currentThoughtIndex = 0;
      let _currentAppendPath = '';

      let reasoningBuffer = '';
      let deferredThinkingChunks: string[] = [];
      let lastFullContent = '';
      let lastRawContent = '';
      let lastFilteredSnapshot = '';
      let lastThinkingSnapshot = '';
      const enableContentFiltering = cleanOutput;
      const streamFilter = new StreamingContentFilter(enableContentFiltering);
      const echoDetectorEnabled = config.get('ECHO_DETECTOR', 'true') !== 'false';
      const streamingEchoFilter = new StreamingEchoFilter(echoDetectorEnabled ? toolResultContents : []);
      let lastVStrRaw = '';
      let targetResponseId: string | null = null;
      const toolParser = new StreamingToolParser();
      if (!toolCalling) toolParser.passThrough = true;

      let buffer = '';
      let completionTokens = 0;
      let promptTokens = Math.ceil(finalPrompt.length / 3.5);

      const ampState: AmplificationGuardState = { rawInputBytes: 0, emittedOutputBytes: 0, triggered: false };

      while (true) {
        if (streamDone) break;
        if (c.req.raw?.signal?.aborted) { reader.cancel(); break; }

        let done: boolean;
        let value: Uint8Array | undefined;
        const IDLE_TIMEOUT_MS = 60_000;
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Upstream stream idle timeout — no data for 60s')), IDLE_TIMEOUT_MS);
          }),
        ]);
        done = readResult.done;
        value = readResult.value;

        if (done) break;
        totalChunks++;
        if (value) ampState.rawInputBytes += value.length;

        const rawDecoded = decoder.decode(value, { stream: true });
        streamDebugLog(completionId, 'WIRE_CHUNK', { chunkNum: totalChunks, byteLen: value?.length ?? 0, preview: rawDecoded.substring(0, 300) });
        buffer += rawDecoded;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const chunk = JSON.parse(dataStr);
            streamDebugLog(completionId, 'SSE_EVENT', { phase: chunk.choices?.[0]?.delta?.phase, hasContent: !!chunk.choices?.[0]?.delta?.content, hasToolCalls: !!chunk.choices?.[0]?.delta?.tool_calls, contentLen: chunk.choices?.[0]?.delta?.content?.length ?? 0, dataPreview: dataStr.substring(0, 300) });

            if (chunk.choices?.[0]?.delta?.status === 'finished') {
              const deltaPhase = chunk.choices[0].delta.phase;
              if (deltaPhase !== 'thinking_summary') {
                streamDone = true;
                break;
              }
            }

            if (chunk['response.created'] && chunk['response.created'].response_id) {
              if (!targetResponseId) targetResponseId = chunk['response.created'].response_id;
              nextParentId = chunk['response.created'].response_id;
            } else if (chunk.response_id && !targetResponseId) {
              targetResponseId = chunk.response_id;
              nextParentId = chunk.response_id;
            }

            if (chunk.usage) {
              if (chunk.usage.output_tokens) completionTokens = chunk.usage.output_tokens;
              if (chunk.usage.input_tokens) promptTokens = chunk.usage.input_tokens;
            }

            const deltaResult = extractDeltaContent(chunk, targetResponseId, currentThoughtIndex, reasoningBuffer);
            const { vStr, foundStr, isThinkingChunk } = deltaResult;
            currentThoughtIndex = deltaResult.currentThoughtIndex;

            if (foundStr && vStr !== '') {
              if (vStr === 'FINISHED') continue;

              if (isThinkingChunk) {
                _inThinkingState = true;
                reasoningBuffer += vStr;
                deferredThinkingChunks.push(vStr);
              } else {
                _inThinkingState = false;
                if (/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/.test(vStr)) continue;

                logStore.addRawChunk(logId, vStr);
                streamDebugLog(completionId, 'RAW_CHUNK', vStr);
                if (vStr.includes('"name"')) logDebug('QWEN RAW CHUNK (streaming)', vStr);
                let feedStr = vStr;
                if (lastVStrRaw.length > 0) {
                  const detection = detectCumulativeChunk(vStr, lastVStrRaw);
                  streamDebugLog(completionId, 'CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length, lastLen: lastVStrRaw.length, newLen: vStr.length });
                  if (detection.cumulative) {
                    feedStr = detection.delta;
                    lastVStrRaw = vStr;
                  } else if (detection.delta === '') {
                    feedStr = '';
                  } else {
                    lastVStrRaw += vStr;
                  }
                } else {
                  lastVStrRaw = vStr;
                }
                const { text: rawText, toolCalls, thinking: parserThinking } = feedStr ? toolParser.feed(feedStr) : { text: '', toolCalls: [], thinking: '' };
                streamDebugLog(completionId, 'PARSER_OUTPUT', { feedLen: feedStr.length, textLen: rawText.length, toolCount: toolCalls.length, toolNames: toolCalls.map(t => t.name) });

                if (toolCalls.length) {
                  logStore.updateEntry(logId, entry => {
                    for (const tc of toolCalls) {
                      entry.parsedToolCalls.push({ name: tc.name, args: JSON.stringify(tc.arguments) });
                    }
                  });
                }

                if (rawText) {
                  streamDebugLog(completionId, 'RAW_TEXT', { len: rawText.length, preview: rawText.substring(0, 100) });
                  if (lastRawContent.length > 0) {
                    const detection = detectCumulativeChunk(rawText, lastRawContent);
                    streamDebugLog(completionId, 'RAW_CUMULATIVE_DETECT', { cumulative: detection.cumulative, deltaLen: detection.delta.length });
                    if (detection.cumulative) {
                      lastRawContent = rawText;
                      lastFullContent += detection.delta;
                    } else if (detection.delta === '') {
                      // no-op
                    } else {
                      lastRawContent += rawText;
                      lastFullContent += rawText;
                    }
                  } else {
                    lastRawContent = rawText;
                    lastFullContent = rawText;
                  }
                }

                streamFilter.feed(lastFullContent);

                const baseFilteredContent = enableContentFiltering
                  ? filterContent(lastFullContent).cleanText
                  : lastFullContent;
                const filteredThinking = enableContentFiltering
                  ? filterContent(lastFullContent).thinking
                  : '';
                const fullFilteredText = stripToolCallArtifacts(baseFilteredContent);

                const echoResult = streamingEchoFilter.feed(fullFilteredText);
                if (echoResult.echoDetected) {
                  console.warn(`[StreamingEchoFilter] ${echoResult.reason}`);
                  logStore.updateEntry(logId, entry => {
                    entry.level = 'error';
                    entry.errors.push(`[Echo Detection] ${echoResult.reason} | Matched: "${(echoResult.matchedLine || '').substring(0, 120)}"`);
                  });
                  reader.cancel();
                  if (streamReader) streamReader.cancel();
                  qwenAbortController.abort();

                  const correction = `[ECHO DETECTED — PREVENT RECURRENCE] You repeated a tool result verbatim (${(echoResult.similarity * 100).toFixed(0)}% match). This is not allowed. Analyze the result internally, then respond to the user in your own words — never copy tool output directly into your response.`;
                  pendingCorrections.set('__echo_retry__', [
                    ...(pendingCorrections.get('__echo_retry__') || []),
                    correction,
                  ]);
                  pendingCorrections.set(resolvedEmail, [
                    ...(pendingCorrections.get(resolvedEmail) || []),
                    correction,
                  ]);

                  try { streamWriter.writer?.abort(new Error('connection lost')); } catch { /* ignore */ }
                  streamDone = true;
                  return;
                }

                await writeDeferredThinking(streamWriter, completionId, body.model, deferredThinkingChunks);
                deferredThinkingChunks = [];
                const echoFilteredText = fullFilteredText || null;

                if (parserThinking) {
                  await writeReasoningEvent(streamWriter, completionId, body.model, parserThinking);
                }

                if (filteredThinking) {
                  const thinkingDelta = getSnapshotDelta(filteredThinking, lastThinkingSnapshot);
                  lastThinkingSnapshot = filteredThinking;
                  if (thinkingDelta) {
                    await writeReasoningEvent(streamWriter, completionId, body.model, thinkingDelta);
                  }
                }

                const pendingText = (toolCalls.length > 0 && echoFilteredText) ? echoFilteredText : null;
                const cleanedText = pendingText
                  ? cleanThinkTags(pendingText)
                  : (echoFilteredText ? cleanThinkTags(echoFilteredText) : null);

                if (cleanedText && !pendingText) {
                  const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
                  lastFilteredSnapshot = cleanedText;
                  if (contentDelta) {
                    await writeContentDelta(streamWriter, completionId, body.model, contentDelta, ampState, logId, resolvedEmail, lastRawContent, lastVStrRaw, logStore);
                  }
                }

                let allToolCallsValid = true;
                for (const tc of toolCalls) {
                  const guard = validateSingleToolCall(tc);
                  if (!guard.ok) {
                    allToolCallsValid = false;
                    logStore.updateEntry(logId, entry => {
                      entry.errors.push(`Guard rejected streaming tool call "${tc.name}": ${guard.errors.join(', ')}`);
                    });
                    continue;
                  }
                  await writeToolCallEvent(streamWriter, completionId, body.model, tc, toolParser.getEmittedToolCallCount() - toolCalls.length + toolCalls.indexOf(tc));
                }

                if (pendingText && allToolCallsValid && cleanedText) {
                  const contentDelta = stripStreamingDelta(getSnapshotDelta(cleanedText, lastFilteredSnapshot));
                  lastFilteredSnapshot = cleanedText;
                  if (contentDelta) {
                    await writeContentDelta(streamWriter, completionId, body.model, contentDelta, ampState, logId, resolvedEmail, lastRawContent, lastVStrRaw, logStore);
                  }
                }
              }
            }
          } catch (e) {
            console.error('[Chat] Streaming: parse error on chunk, ignoring partial:', (e as Error)?.message);
          }
        }
      }

      const remainingEchoDelta = streamingEchoFilter.flush(lastFullContent);
      if (remainingEchoDelta) {
        const flushEchoCleaned = cleanThinkTags(stripToolCallArtifacts(remainingEchoDelta));
        if (flushEchoCleaned) {
          const echoFlushDelta = stripStreamingDelta(getSnapshotDelta(flushEchoCleaned, lastFilteredSnapshot));
          lastFilteredSnapshot = flushEchoCleaned;
          if (echoFlushDelta) {
            await writeContentDelta(streamWriter, completionId, body.model, echoFlushDelta, ampState, logId, resolvedEmail, lastRawContent, lastVStrRaw, logStore);
          }
        }
      }

      const upstreamError = parseQwenErrorPayload(buffer);
      if (upstreamError) {
        await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ content: upstreamError.message })]));
        await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({}, 'stop')]));
        await streamWriter.write('data: [DONE]\n\n');
        return;
      }

      const { text: remainingText, toolCalls: remainingToolCalls, thinking: remainingThinking } = toolParser.flush();
      if (remainingThinking) {
        await writeReasoningEvent(streamWriter, completionId, body.model, remainingThinking);
      }
      if (remainingText) {
        lastFullContent += remainingText;
      }
      streamFilter.flush();
      const { cleanText: flushBase, thinking: flushThinking } = (enableContentFiltering && lastFullContent)
        ? filterContent(lastFullContent)
        : { cleanText: lastFullContent || '', thinking: '' };
      const flushFiltered = stripToolCallArtifacts(flushBase);
      const flushCleaned = cleanThinkTags(flushFiltered);

      if (flushThinking) {
        const thinkDelta = getSnapshotDelta(flushThinking, lastThinkingSnapshot);
        if (thinkDelta) {
          lastThinkingSnapshot = flushThinking;
          await writeReasoningEvent(streamWriter, completionId, body.model, thinkDelta);
        }
      }
      if (flushCleaned) {
        const contentDelta = getSnapshotDelta(flushCleaned, lastFilteredSnapshot);
        if (contentDelta) {
          if (checkAmplificationGuard(ampState, contentDelta.length, logId, resolvedEmail, body.model, lastRawContent, lastVStrRaw)) {
            lastFilteredSnapshot = flushCleaned;
          } else {
            lastFilteredSnapshot = flushCleaned;
            const ct = stripStreamingDelta(contentDelta).replace(/[\n\s]*$/, '');
            if (ct) {
              logStore.addProcessedOutput(logId, ct);
              ampState.emittedOutputBytes += ct.length;
              await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({ content: ct })]));
            }
          }
        }
      }
      for (const tc of remainingToolCalls) {
        const guard = validateSingleToolCall(tc);
        if (!guard.ok) {
          logStore.updateEntry(logId, entry => {
            entry.errors.push(`Guard rejected streaming flush tool call "${tc.name}": ${guard.errors.join(', ')}`);
          });
          continue;
        }
        await writeToolCallEvent(streamWriter, completionId, body.model, tc, toolParser.getEmittedToolCallCount() - remainingToolCalls.length + remainingToolCalls.indexOf(tc));
      }

      const usage = buildUsage(promptTokens, completionTokens, reasoningBuffer);
      const finalFinishReason = toolParser.getEmittedToolCallCount() > 0 ? 'tool_calls' : 'stop';

      await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [makeChoice({}, finalFinishReason)],
        body.stream_options?.include_usage ? undefined : { usage },
      ));

      if (body.stream_options?.include_usage) {
        await writeEvent(streamWriter, buildChunkEvent(completionId, body.model, [], { usage }));
      }
      await streamWriter.write('data: [DONE]\n\n');

      checkFinalAmplification(ampState, logId, resolvedEmail, logStore);

      logStore.updateEntry(logId, (entry) => {
        const now = Date.now();
        const startedAt = new Date(entry.timestamp).getTime();
        if (startedAt) entry.latency_ms = now - startedAt;
        if (lastFullContent) entry.remainingText = lastFullContent;
        entry.finalResponse = {
          finishReason: finalFinishReason || 'stop',
          toolCallCount: toolParser.getEmittedToolCallCount(),
          contentPreview: (lastFullContent || '').substring(0, 100),
        };
      });

      streamReleased = true;
      scheduleCleanup(reader, heartbeatInterval, session.chatId, nextParentId, sessionHeaders, resolvedEmail, sessionPool);

    } finally {
      if (!streamReleased) {
        cleanupImmediately(streamReader, heartbeatInterval, session.chatId, nextParentId, sessionHeaders, resolvedEmail, sessionPool);
      }
    }
  });
}
