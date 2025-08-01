import { findServiceAccessOrThrow } from '~/modules/llms/vendors/vendor.helpers';

import type { DMessage, DMessageGenerator } from '~/common/stores/chat/chat.message';
import type { MaybePromise } from '~/common/types/useful.types';
import { DLLM, DLLMId, LLM_IF_HOTFIX_NoTemperature, LLM_IF_OAI_Responses, LLM_IF_Outputs_Audio, LLM_IF_Outputs_Image, LLM_IF_Outputs_NoText } from '~/common/stores/llms/llms.types';
import { apiStream } from '~/common/util/trpc.client';
import { DMetricsChatGenerate_Lg, metricsChatGenerateLgToMd, metricsComputeChatGenerateCostsMd } from '~/common/stores/metrics/metrics.chatgenerate';
import { DModelParameterValues, getAllModelParameterValues } from '~/common/stores/llms/llms.parameters';
import { createErrorContentFragment, DMessageContentFragment, DMessageErrorPart, DMessageVoidFragment, isContentFragment, isErrorPart } from '~/common/stores/chat/chat.fragments';
import { findLLMOrThrow } from '~/common/stores/llms/store-llms';
import { getLabsDevMode, getLabsDevNoStreaming } from '~/common/stores/store-ux-labs';
import { metricsStoreAddChatGenerate } from '~/common/stores/metrics/store-metrics';
import { presentErrorToHumans } from '~/common/util/errorUtils';
import { webGeolocationCached } from '~/common/util/webGeolocationUtils';

// NOTE: pay particular attention to the "import type", as this is importing from the server-side Zod definitions
import type { AixAPI_Access, AixAPI_Context_ChatGenerate, AixAPI_Model, AixAPIChatGenerate_Request } from '../server/api/aix.wiretypes';

import { aixCGR_ChatSequence_FromDMessagesOrThrow, aixCGR_FromSimpleText, aixCGR_SystemMessage_FromDMessageOrThrow, AixChatGenerate_TextMessages, clientHotFixGenerateRequest_ApplyAll } from './aix.client.chatGenerateRequest';
import { ContentReassembler } from './ContentReassembler';
import { withDecimator } from './withDecimator';


// configuration
export const DEBUG_PARTICLES = false;
const AIX_CLIENT_DEV_ASSERTS = process.env.NODE_ENV === 'development';


export function aixCreateChatGenerateContext(name: AixAPI_Context_ChatGenerate['name'], ref: string | '_DEV_'): AixAPI_Context_ChatGenerate {
  return { method: 'chat-generate', name, ref };
}

export function aixCreateModelFromLLMOptions(
  llmInterfaces: DLLM['interfaces'],
  llmOptions: DModelParameterValues,
  _llmOptionsOverride: Omit<DModelParameterValues, 'llmRef'> | undefined,
  debugLlmId: string,
): AixAPI_Model {

  // make sure llmRef is removed, if present in the override - excess of caution here
  const llmOptionsOverride = _llmOptionsOverride ? { ..._llmOptionsOverride } : undefined;
  if (llmOptionsOverride)
    delete (llmOptionsOverride as { llmRef?: any }).llmRef;

  // destructure input with the overrides
  const {
    llmRef, llmTemperature, llmResponseTokens, llmTopP, llmForceNoStream,
    llmVndAntThinkingBudget,
    llmVndGeminiShowThoughts, llmVndGeminiThinkingBudget,
    llmVndOaiReasoningEffort, llmVndOaiRestoreMarkdown, llmVndOaiWebSearchContext, llmVndOaiWebSearchGeolocation,
    llmVndPerplexityDateFilter, llmVndPerplexitySearchMode,
    llmVndXaiSearchMode, llmVndXaiSearchSources, llmVndXaiSearchDateFilter,
  } = {
    ...llmOptions,
    ...llmOptionsOverride,
  };

  // llmRef is absolutely required
  if (!llmRef)
    throw new Error(`AIX: Error in configuration for model ${debugLlmId} (missing ref, temperature): ${JSON.stringify(llmOptions)}`);

  // llmTemperature is highly recommended, so we display a note if it's missing
  if (llmTemperature === undefined)
    console.warn(`[DEV] AIX: Missing temperature for model ${debugLlmId}, using default.`);

  // Output modalities
  const acceptsOutputs: AixAPI_Model['acceptsOutputs'] = [];
  if (!llmInterfaces.includes(LLM_IF_Outputs_NoText)) acceptsOutputs.push('text');
  if (llmInterfaces.includes(LLM_IF_Outputs_Audio)) acceptsOutputs.push('audio');
  if (llmInterfaces.includes(LLM_IF_Outputs_Image)) acceptsOutputs.push('image');

  // Output APIs
  const llmVndOaiResponsesAPI = llmInterfaces.includes(LLM_IF_OAI_Responses);

  // Client-side late stage model HotFixes
  const hotfixOmitTemperature = llmInterfaces.includes(LLM_IF_HOTFIX_NoTemperature);

  // User Geolocation
  let userGeolocation: AixAPI_Model['userGeolocation'] | undefined;
  if (llmVndOaiWebSearchGeolocation) {
    const webGeolocation = webGeolocationCached();
    if (webGeolocation) {
      userGeolocation = {
        ...(webGeolocation.city ? { city: webGeolocation.city } : {}),
        ...(webGeolocation.country ? { country: webGeolocation.country } : {}),
        ...(webGeolocation.region ? { region: webGeolocation.region } : {}),
        timezone: webGeolocation.timezone,
      };
    } else
      console.log(`[DEV] AIX: Geolocation is requested for model ${debugLlmId}, but it's not available.`);
  }

  return {
    id: llmRef,
    acceptsOutputs: acceptsOutputs,
    ...(hotfixOmitTemperature ? { temperature: null } : llmTemperature !== undefined ? { temperature: llmTemperature } : {}),
    ...(llmResponseTokens /* null: similar to undefined, will omit the value */ ? { maxTokens: llmResponseTokens } : {}),
    ...(llmTopP !== undefined ? { topP: llmTopP } : {}),
    ...(llmForceNoStream ? { forceNoStream: llmForceNoStream } : {}),
    ...(llmVndAntThinkingBudget !== undefined ? { vndAntThinkingBudget: llmVndAntThinkingBudget } : {}),
    ...(llmVndGeminiShowThoughts ? { vndGeminiShowThoughts: llmVndGeminiShowThoughts } : {}),
    ...(llmVndGeminiThinkingBudget !== undefined ? { vndGeminiThinkingBudget: llmVndGeminiThinkingBudget } : {}),
    ...(llmVndOaiResponsesAPI ? { vndOaiResponsesAPI: true } : {}),
    ...(llmVndOaiReasoningEffort ? { vndOaiReasoningEffort: llmVndOaiReasoningEffort } : {}),
    ...(llmVndOaiRestoreMarkdown ? { vndOaiRestoreMarkdown: llmVndOaiRestoreMarkdown } : {}),
    ...(llmVndOaiWebSearchContext ? { vndOaiWebSearchContext: llmVndOaiWebSearchContext } : {}),
    ...(llmVndPerplexityDateFilter ? { vndPerplexityDateFilter: llmVndPerplexityDateFilter } : {}),
    ...(llmVndPerplexitySearchMode ? { vndPerplexitySearchMode: llmVndPerplexitySearchMode } : {}),
    ...(userGeolocation ? { userGeolocation } : {}),
    ...(llmVndXaiSearchMode ? { vndXaiSearchMode: llmVndXaiSearchMode } : {}),
    ...(llmVndXaiSearchSources ? { vndXaiSearchSources: llmVndXaiSearchSources } : {}),
    ...(llmVndXaiSearchDateFilter ? { vndXaiSearchDateFilter: llmVndXaiSearchDateFilter } : {}),
  };
}


/**
 * Accumulator for ChatGenerate output data, as it is being streamed.
 * The object is modified in-place from the lower layers and passed to the callback for efficiency.
 */
export interface AixChatGenerateContent_DMessage extends Pick<DMessage, 'fragments' | 'generator' | 'pendingIncomplete'> {
  fragments: (DMessageContentFragment | DMessageVoidFragment)[];
  generator: DMessageGenerator; // Extract<DMessageGenerator, { mgt: 'aix' }>;
  pendingIncomplete: boolean;
}

type StreamMessageStatus = {
  outcome: 'success' | 'aborted' | 'errored',
  lastDMessage: AixChatGenerateContent_DMessage,
  errorMessage?: string
};


interface AixClientOptions {
  abortSignal: AbortSignal | 'NON_ABORTABLE'; // 'NON_ABORTABLE' is a special case for non-abortable operations
  throttleParallelThreads?: number; // 0: disable, 1: default throttle (12Hz), 2+ reduce frequency with the square root
  llmOptionsOverride?: Omit<DModelParameterValues, 'llmRef'>; // overrides for the LLM options
}


/**
 * Level 3 Generation from an LLM Id + Chat History.
 */
export async function aixChatGenerateContent_DMessage_FromConversation(
  // chat-inputs -> Partial<DMessage> outputs
  llmId: DLLMId,
  chatSystemInstruction: null | Pick<DMessage, 'fragments' | 'metadata' | 'userFlags'>,
  chatHistoryWithoutSystemMessages: Readonly<DMessage[]>,
  // aix inputs
  aixContextName: AixAPI_Context_ChatGenerate['name'],
  aixContextRef: AixAPI_Context_ChatGenerate['ref'],
  // others
  clientOptions: AixClientOptions,
  onStreamingUpdate: (update: AixChatGenerateContent_DMessage, isDone: boolean) => MaybePromise<void>,
): Promise<StreamMessageStatus> {

  let errorMessage: string | undefined;

  let lastDMessage: AixChatGenerateContent_DMessage = {
    fragments: [],
    generator: {
      mgt: 'named',
      name: llmId as any,
    },
    pendingIncomplete: true,
  };

  try {

    // Aix ChatGenerate Request
    const aixChatContentGenerateRequest: AixAPIChatGenerate_Request = {
      systemMessage: await aixCGR_SystemMessage_FromDMessageOrThrow(chatSystemInstruction),
      chatSequence: await aixCGR_ChatSequence_FromDMessagesOrThrow(chatHistoryWithoutSystemMessages),
    };

    await aixChatGenerateContent_DMessage(
      llmId,
      aixChatContentGenerateRequest,
      aixCreateChatGenerateContext(aixContextName, aixContextRef),
      true,
      clientOptions,
      async (update: AixChatGenerateContent_DMessage, isDone: boolean) => {
        lastDMessage = update;
        await onStreamingUpdate(lastDMessage, isDone);
      },
    );

  } catch (error: any) {

    // this can only be a large, user-visible error, such as LLM not found
    console.warn('[DEV] aixChatGenerateContentStreaming error:', { error });

    errorMessage = error.message || (typeof error === 'string' ? error : 'Chat stopped.');
    lastDMessage.fragments.push(createErrorContentFragment(`Issue: ${errorMessage}`));
    lastDMessage.generator = {
      ...lastDMessage.generator,
      tokenStopReason: 'issue',
    };
    lastDMessage.pendingIncomplete = false;
  }

  // TODO: check something beyond this return status (as exceptions almost never happen here)
  // - e.g. the generator.aix may have error/token stop codes

  return {
    outcome: errorMessage ? 'errored' : lastDMessage.generator?.tokenStopReason === 'client-abort' ? 'aborted' : 'success',
    lastDMessage: lastDMessage,
    errorMessage: errorMessage || undefined,
  };
}


/**
 * Accumulator for the simple text-only API
 */
interface AixChatGenerateText_Simple {
  text: string | null;
  generator: DMessageGenerator;
  isDone: boolean;
}

/**
 * Level 2 - Simpler facade to text-only inputs and text-only outputs - and nothing else. Old-school V1-like API.
 *
 * NOTE: this is a simplified version of the `aixChatGenerateContent_DMessage` function, with text-only inputs and outputs.
 * NOTE: it's missing throttling; there's the chance we could abstract and consolidate the two functions, because they are
 * NOTE: very similar in structure, just the inputs/outputs (and verifiers and transformations) are different.
 *
 * Contract - expects ONLY text/text in/out (e.g. no Tools, no upstream Error messages, no Empty messages):
 * - User aborts are thrown as AbortError
 * - Other issues are thrown as Error
 * - Aix issues (network, model, etc.) that became error fragments are re-thrown as Error
 *
 * @throws AbortError if the user aborts the operation
 * @throws Error if there are issues with the LLM Output, the Upstream AI service, the Aix API
 */
export async function aixChatGenerateText_Simple(
  // [V1-like text-only API] text inputs -> string output
  llmId: DLLMId,
  systemInstruction: null | string,
  aixTextMessages: AixChatGenerate_TextMessages | string, // if string, it's a single user message - maximum simplicity
  // aix inputs
  aixContextName: AixAPI_Context_ChatGenerate['name'],
  aixContextRef: AixAPI_Context_ChatGenerate['ref'],
  // optional options
  clientOptions?: Partial<AixClientOptions>, // this makes the abortController optional
  // optional callback for streaming
  onTextStreamUpdate?: (text: string, isDone: boolean, generator: DMessageGenerator) => MaybePromise<void>,
): Promise<string> {

  // Aix Access
  const llm = findLLMOrThrow(llmId);
  const { transportAccess: aixAccess, vendor: llmVendor, serviceSettings: llmServiceSettings } = findServiceAccessOrThrow<object, AixAPI_Access>(llm.sId);

  // Aix Model
  const llmParameters = getAllModelParameterValues(llm.initialParameters, llm.userParameters);
  const aixModel = aixCreateModelFromLLMOptions(llm.interfaces, llmParameters, clientOptions?.llmOptionsOverride, llmId);

  // Aix ChatGenerate Request
  const aixChatGenerate = aixCGR_FromSimpleText(
    systemInstruction,
    typeof aixTextMessages === 'string' ? [{ role: 'user', text: aixTextMessages }] : aixTextMessages,
  );

  // Aix Context
  const aixContext = aixCreateChatGenerateContext(aixContextName, aixContextRef);

  // Aix Streaming - implicit if the callback is provided
  let aixStreaming = !!onTextStreamUpdate;


  // Client-side late stage model HotFixes
  const { shallDisableStreaming } = clientHotFixGenerateRequest_ApplyAll(llm.interfaces, aixChatGenerate, llmParameters.llmRef || llm.id);
  if (shallDisableStreaming)
    aixStreaming = false;


  // Variable to store the final text
  const state: AixChatGenerateText_Simple = {
    text: null,
    generator: {
      mgt: 'aix',
      name: llmId,
      aix: {
        vId: llm.vId,
        mId: llm.id,
      },
    },
    isDone: false,
  };

  // NO streaming initial notification - only notified past the first real characters
  // await onTextStreamUpdate?.(dText.text, false);

  // apply any vendor-specific rate limit
  await llmVendor.rateLimitChatGenerate?.(llm, llmServiceSettings);


  // Abort: if no signal is provided, we will create a dummy signal
  const abortSignal = (clientOptions?.abortSignal && clientOptions.abortSignal !== 'NON_ABORTABLE') ? clientOptions?.abortSignal
    : new AbortController().signal; // since this is a 'simple' low-stakes API, we can 'ignore' the abort signal and not enforce it with the caller


  // Aix Low-Level Chat Generation - does not throw, but may return an error in the final text
  const ll = await _aixChatGenerateContent_LL(
    aixAccess,
    aixModel,
    aixChatGenerate,
    aixContext,
    aixStreaming,
    abortSignal,
    clientOptions?.throttleParallelThreads ?? 0,
    !aixStreaming ? undefined : async (ll: AixChatGenerateContent_LL, _isDone: boolean /* we want to issue this, in case the next action is an exception */) => {
      _llToText(ll, state);
      if (onTextStreamUpdate && state.text !== null)
        await onTextStreamUpdate(state.text, false, state.generator);
    },
  );

  // Mark as complete
  state.isDone = true;

  // LLM Cost computation & Aggregations
  _llToText(ll, state);
  _updateGeneratorCostsInPlace(state.generator, llm, `aix_chatgenerate_text-${aixContextName}`);


  // re-throw the user-initiated abort, as the former function catches it
  if (abortSignal.aborted)
    throw new DOMException('Stopped.', 'AbortError');

  // throw if there was no text generated
  if (state.text === null)
    throw new Error('AIX: Empty text response.');

  // throw if there are error fragments
  const errorMessage = ll.fragments
    .filter(f => isContentFragment(f) && isErrorPart(f.part))
    .map(f => (f.part as DMessageErrorPart).error).join('\n');
  if (errorMessage)
    throw new Error('AIX: Error in response: ' + errorMessage);

  // final update
  await onTextStreamUpdate?.(state.text, true, state.generator);

  return state.text;
}

/**
 * Down-casts the LL to plain text, and updates the destination object.
 * - text -> text
 * - error -> inline error text: DO NOT THROW HERE, as the LL will catch it and add another error part with the same text
 * - tool -> throw: the LL will catch it and add the error text. However when done outside the LL (secondary usage) this will throw freely
 */
function _llToText(src: AixChatGenerateContent_LL, dest: AixChatGenerateText_Simple) {
  // copy over Generator's
  if (src.genMetricsLg)
    dest.generator.metrics = metricsChatGenerateLgToMd(src.genMetricsLg); // reduce the size to store in DMessage
  if (src.genModelName)
    dest.generator.name = src.genModelName;
  if (src.genTokenStopReason)
    dest.generator.tokenStopReason = src.genTokenStopReason;

  // transform the fragments to plain text
  if (src.fragments.length) {
    dest.text = '';
    for (let fragment of src.fragments) {
      const pt = fragment.part.pt;
      switch (pt) {
        case 'text':
          dest.text += fragment.part.text;
          break;
        case 'error':
          dest.text += (dest.text ? '\n' : '') + fragment.part.error;
          break;
        case 'tool_invocation':
          throw new Error(`AIX: Unexpected tool invocation ${fragment.part.invocation?.type === 'function_call' ? fragment.part.invocation.name : fragment.part.id} in the Text response.`);
        case 'annotations': // citations - ignored
        case 'ma': // model annotations (thinking tokens) - ignored
        case 'ph': // placeholder - ignored
        case 'reference': // impossible
        case 'image_ref': // impossible
        case 'tool_response': // impossible - stopped at the invocation already
        case '_pt_sentinel': // impossible
          break;
        default:
          const _exhaustiveCheck: never = pt;
      }
    }
  }
}


/**
 * Level 1 - Generates chat content using a specified LLM and ChatGenerateRequest (incl. Tools) and returns a DMessage-compatible object.
 *
 * Contract:
 * - empty fragments means no content yet, and no error
 * - pendingIncomplete is true until the final update & final object (or unless this throws)
 * - errors become Error fragments, and they can be dialect-sent, dispatch-excepts, client-read issues or even user aborts
 * @throws Error if the LLM is not found or other misconfigurations, but handles most other errors internally.
 *
 * Features:
 * - Throttling if requrested (decimates the requests based on the square root of the number parllel hints)
 * - computes the costs and metrics for the chat generation
 * - vendor-specific rate limit
 * - 'pendingIncomplete' logic
 * - 'o1-preview' hotfix for OpenAI models
 * - [NOT PORTED YET: checks for harmful content with the free 'moderation' API (OpenAI-only)]
 *
 * @param llmId - ID of the Language Model to use
 * @param aixChatGenerate - Multi-modal chat generation request specifics, including Tools and high-level metadata
 * @param aixContext - Information about how this chat generation is being used
 * @param aixStreaming - Whether to use streaming for generation
 * @param clientOptions - Client options for the operation
 * @param onStreamingUpdate - Optional callback for streaming updates
 *
 * @returns Promise<AixChatGenerateContent_DMessage> - The final DMessage-compatible object
 */
export async function aixChatGenerateContent_DMessage<TServiceSettings extends object = {}, TAccess extends AixAPI_Access = AixAPI_Access>(
  // llm Id input -> access & model
  llmId: DLLMId,
  // aix inputs
  aixChatGenerate: AixAPIChatGenerate_Request,
  aixContext: AixAPI_Context_ChatGenerate,
  aixStreaming: boolean,
  // others
  clientOptions: AixClientOptions,
  onStreamingUpdate?: (update: AixChatGenerateContent_DMessage, isDone: boolean) => MaybePromise<void>,
): Promise<AixChatGenerateContent_DMessage> {

  // Aix Access
  const llm = findLLMOrThrow(llmId);
  const { transportAccess: aixAccess, vendor: llmVendor, serviceSettings: llmServiceSettings } = findServiceAccessOrThrow<TServiceSettings, TAccess>(llm.sId);

  // Aix Model
  const llmParameters = getAllModelParameterValues(llm.initialParameters, llm.userParameters);
  const aixModel = aixCreateModelFromLLMOptions(llm.interfaces, llmParameters, clientOptions?.llmOptionsOverride, llmId);

  // Client-side late stage model HotFixes
  const { shallDisableStreaming } = clientHotFixGenerateRequest_ApplyAll(llm.interfaces, aixChatGenerate, llmParameters.llmRef || llm.id);
  if (shallDisableStreaming)
    aixStreaming = false;


  // [OpenAI-only] check for harmful content with the free 'moderation' API, if the user requests so
  // if (aixAccess.dialect === 'openai' && aixAccess.moderationCheck) {
  //   const moderationUpdate = await _openAIModerationCheck(aixAccess, messages.at(-1) ?? null);
  //   if (moderationUpdate)
  //     return onUpdate({ textSoFar: moderationUpdate, typing: false }, true);
  // }

  // Aix Low-Level Chat Generation
  const dMessage: AixChatGenerateContent_DMessage = {
    fragments: [],
    generator: {
      mgt: 'aix',
      name: llmId,
      aix: {
        vId: llm.vId,
        mId: llm.id, // NOTE: using llm.id instead of aixModel.id (the ref) so we can re-select them in the UI (Beam)
      },
      // metrics: undefined,
      // tokenStopReason: undefined,
    },
    pendingIncomplete: true,
  };

  // streaming initial notification, for UI updates
  await onStreamingUpdate?.(dMessage, false);

  // apply any vendor-specific rate limit
  await llmVendor.rateLimitChatGenerate?.(llm, llmServiceSettings);

  // Abort: if the operation is non-abortable, we can't use the AbortSignal
  if (clientOptions.abortSignal === 'NON_ABORTABLE') {
    // [DEV] UGLY: here we have non-abortable operations -- we silence the warning, but something may be done in the future
    // console.log('[DEV] Aix non-abortable operation:', { aixContext, llmId });
    clientOptions.abortSignal = new AbortController().signal;
  }

  // Aix Low-Level Chat Generation
  const llAccumulator = await _aixChatGenerateContent_LL(aixAccess, aixModel, aixChatGenerate, aixContext, aixStreaming, clientOptions.abortSignal, clientOptions.throttleParallelThreads ?? 0,
    async (ll: AixChatGenerateContent_LL, isDone: boolean) => {
      if (isDone) return; // optimization, as there aren't branches between here and the final update below
      if (onStreamingUpdate) {
        _llToDMessage(ll, dMessage);
        await onStreamingUpdate(dMessage, false);
      }
    },
  );

  // Mark as complete
  dMessage.pendingIncomplete = false;

  // LLM Cost computation & Aggregations
  _llToDMessage(llAccumulator, dMessage);
  _updateGeneratorCostsInPlace(dMessage.generator, llm, `aix_chatgenerate_content-${aixContext.name}`);

  // final update (could ignore and take the dMessage)
  await onStreamingUpdate?.(dMessage, true);

  return dMessage;
}

function _llToDMessage(src: AixChatGenerateContent_LL, dest: AixChatGenerateContent_DMessage) {
  if (src.fragments.length)
    dest.fragments = src.fragments; // Note: this gets replaced once, and then it's the same from that point on
  if (src.genMetricsLg)
    dest.generator.metrics = metricsChatGenerateLgToMd(src.genMetricsLg); // reduce the size to store in DMessage
  if (src.genModelName)
    dest.generator.name = src.genModelName;
  if (src.genTokenStopReason)
    dest.generator.tokenStopReason = src.genTokenStopReason;
}

function _updateGeneratorCostsInPlace(generator: DMessageGenerator, llm: DLLM, debugCostSource: string) {
  // Compute costs
  const llmParameters = getAllModelParameterValues(llm.initialParameters, llm.userParameters);
  const costs = metricsComputeChatGenerateCostsMd(generator.metrics, llm.pricing?.chat, llmParameters.llmRef || llm.id);
  if (!costs) {
    // FIXME: we shall warn that the costs are missing, as the only way to get pricing is through surfacing missing prices
    return;
  }

  // Add the costs to the generator.metrics object
  if (generator.metrics)
    Object.assign(generator.metrics, costs);

  // Run aggregations
  const m = generator.metrics;
  const inputTokens = (m?.TIn || 0) + (m?.TCacheRead || 0) + (m?.TCacheWrite || 0);
  const outputTokens = (m?.TOut || 0) /* + (m?.TOutR || 0) THIS IS A BREAKDOWN, IT'S ALREADY IN */;
  metricsStoreAddChatGenerate(costs, inputTokens, outputTokens, llm, debugCostSource);
}


/**
 * Accumulator for Lower Level ChatGenerate output data, as it is being streamed.
 * The object is modified in-place and passed to the callback for efficiency.
 */
export interface AixChatGenerateContent_LL {
  // source of truth for any caller
  // - empty array means no content yet, and no error
  fragments: (DMessageContentFragment | DMessageVoidFragment)[];

  // pieces of generator
  genMetricsLg?: DMetricsChatGenerate_Lg;
  genModelName?: string;
  genTokenStopReason?: DMessageGenerator['tokenStopReason'];
}

/**
 * Low-level-0 client-side ChatGenerateContent, with optional streaming.
 *
 * Contract:
 * - empty fragments means no content yet, and no error
 * - aixStreaming hints the source, but can be respected or not
 *   - onReassemblyUpdate is optional, you can ignore the updates and await the final result
 * - errors become Error fragments, and they can be dialect-sent, dispatch-excepts, client-read issues or even user aborts
 *   - DOES NOT THROW, but the final accumulator may contain error fragments
 * - empty fragments:
 *   - in the interim updates, means no content yet
 *   - in the final update, means there was no content received at all
 * - the output (accumulator) is always a complete object with all fragments
 *   - of the reasons, 'client-abort' and 'out-of-tokens' are the only ones that can be set without any fragments
 *
 * Inputs are all Aix_* objects:
 *
 * @param aixAccess abstracts the provider-specific configuration
 * @param aixModel selects and provides the model-specific configuration
 * @param aixChatGenerate the chat generation request specifics, which includes system instructions and various tools use:
 *    - tools include Function Declaration (for function calling), Gemini Code Execution, etc.
 *    - special parts include 'In Reference To' (a decorator of messages)
 *    - other special parts include the Anthropic Caching hints, on select message
 * @param aixContext specifies the scope of the caller, such as what's the high level objective of this call
 * @param aixStreaming requests the source to provide incremental updates
 * @param abortSignal allows the caller to stop the operation
 * @param throttleParallelThreads allows the caller to limit the number of parallel threads
 *
 * The output is an accumulator object with the fragments, and the generator
 * pieces (metrics, model name, token stop reason)
 *
 * @param onGenerateContentUpdate updated with the same accumulator at every step, and at the end (with isDone=true)
 * @returns the final accumulator object
 *
 */
async function _aixChatGenerateContent_LL(
  // aix inputs
  aixAccess: AixAPI_Access,
  aixModel: AixAPI_Model,
  aixChatGenerate: AixAPIChatGenerate_Request,
  aixContext: AixAPI_Context_ChatGenerate,
  aixStreaming: boolean,
  // others
  abortSignal: AbortSignal,
  throttleParallelThreads: number | undefined,
  // optional streaming callback: not fired until the first piece of content
  onGenerateContentUpdate?: (accumulator: AixChatGenerateContent_LL, isDone: boolean) => MaybePromise<void>,
): Promise<AixChatGenerateContent_LL> {

  // Aix Low-Level Chat Generation Accumulator
  const accumulator_LL: AixChatGenerateContent_LL = {
    fragments: [],
    /* rest start as undefined (missing in reality) */
  };

  const sendContentUpdate = !onGenerateContentUpdate ? undefined : withDecimator(throttleParallelThreads ?? 0, async () => {
    /**
     * We want the first update to have actual content.
     * However note that we won't be sending out the model name very fast this way,
     * but it's probably what we want because of the ParticleIndicators (VFX!)
     */
    if (!accumulator_LL.fragments.length)
      return;

    await onGenerateContentUpdate(accumulator_LL, false);
  });

  /**
   * DEBUG note: early we were filtering (aixContext.name === 'conversation'), but with the new debugger we don't
   * - 'sudo' mode is enabled by the UX Labs, and activates debug
   * - every request thereafter both sends back the Aix server-side dispatch packet, and appends all the particles received by the client side
   */
  const requestServerDebugging = getLabsDevMode();
  const debugContext = !requestServerDebugging ? undefined : { contextName: aixContext.name, contextRef: aixContext.ref };

  /**
   * Particles Reassembler.
   * - uses this accumulator
   * - calls a partial update callback with built-in decimation
   * - optional. forwards particles to the debugger
   * - abort will interrupt the fetch, and also the reassembly (for pieces coming still down the wire)
   */
  const reassembler = new ContentReassembler(
    accumulator_LL,
    sendContentUpdate,
    debugContext,
    abortSignal,
  );

  try {

    // tRPC Aix Chat Generation (streaming) API - inside the try block for deployment path errors
    const particles = await apiStream.aix.chatGenerateContent.mutate({
      access: aixAccess,
      model: aixModel,
      chatGenerate: aixChatGenerate,
      context: aixContext,
      streaming: getLabsDevNoStreaming() ? false : aixStreaming, // [DEV] disable streaming if set in the UX (testing)
      /**
       * Debugging/Profiling is only active when the "Debug Mode" is on.
       */
      ...(requestServerDebugging && {
        connectionOptions: {
          /**
           * Request a round-trip of the upstream AIX dispatch request.
           * Note: the server-side will only send the Body of the call on production builds, while headers will be shown on "Dev Builds".
           */
          debugDispatchRequest: true,
          /**
           * Request profiling data for a successful call (only streaming for now).
           * Note: the server-side won't enable profiling on non-production builds.
           */
          debugProfilePerformance: true,
        },
      }),
    }, {
      signal: abortSignal,
    });

    /**
     * Reassemble the particles by enqueueing them as they come in.
     * Processing is done asynchronously and in batches.
     *
     * Workaround: we cannot use Asyncs insie the 'for...await' loop, as we'd get
     * a 'closed connection' exception thrown when looping and a slow operation.
     */
    for await (const particle of particles)
      reassembler.enqueueWireParticle(particle);

    // synchronize any pending async tasks
    await reassembler.waitForWireComplete();

  } catch (error: any) {

    // something else broke, likely a User Abort, or an Aix server error (e.g. tRPC)
    const isUserAbort = abortSignal.aborted;
    const isErrorAbort = (error instanceof Error) && (error.name === 'AbortError' || (error.cause instanceof DOMException && error.cause.name === 'AbortError'));
    if (isUserAbort || isErrorAbort) {
      if (isUserAbort !== isErrorAbort)
        if (AIX_CLIENT_DEV_ASSERTS)
          console.error(`[DEV] Aix streaming AbortError mismatch (${isUserAbort}, ${isErrorAbort})`, { error: error });
      await reassembler.setClientAborted().catch(console.error /* never */);
    } else {
      // NOTE: this code path has also been almost replicated on `ContentReassembler.#processWireBacklog.catch() {...}`
      if (AIX_CLIENT_DEV_ASSERTS)
        console.error('[DEV] Aix streaming Error:', error);
      const showAsBold = !!accumulator_LL.fragments.length;
      const errorText = (presentErrorToHumans(error, showAsBold, true) || 'Unknown error').replace('[TRPCClientError]', '');
      await reassembler.setClientExcepted(`An unexpected error occurred: ${errorText} Please retry.`).catch(console.error /* never */);
    }

  }

  // and we're done
  reassembler.finalizeAccumulator();

  // final update (could ignore and take the final accumulator)
  await onGenerateContentUpdate?.(accumulator_LL, true /* Last message, done */);

  // return the final accumulated message
  return accumulator_LL;
}
