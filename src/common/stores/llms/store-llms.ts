//
// WARNING: Everything here is data at rest. Know what you're doing.
//

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { DOpenRouterServiceSettings } from '~/modules/llms/vendors/openrouter/openrouter.vendor';
import type { IModelVendor } from '~/modules/llms/vendors/IModelVendor';
import type { ModelVendorId } from '~/modules/llms/vendors/vendors.registry';

import type { DModelParameterId, DModelParameterValues } from './llms.parameters';
import type { DModelsService, DModelsServiceId } from './llms.service.types';
import { DLLM, DLLMId, LLM_IF_OAI_Fn, LLM_IF_OAI_Vision } from './llms.types';
import { createLlmsAssignmentsSlice, LlmsAssignmentsActions, LlmsAssignmentsSlice, LlmsAssignmentsState, llmsHeuristicUpdateAssignments } from './store-llms-assignments_slice';
import { portModelPricingV2toV3 } from './llms.pricing';


/// ModelsStore - a store for configured LLMs and configured services

export interface LlmsRootState {

  llms: DLLM[];

  sources: DModelsService<any>[];

  confServiceId: DModelsServiceId | null;

}

interface LlmsRootActions {

  setLLMs: (llms: DLLM[], serviceId: DModelsServiceId, deleteExpiredVendorLlms: boolean, keepUserEdits: boolean) => void;
  removeLLM: (id: DLLMId) => void;
  rerankLLMsByServices: (serviceIdOrder: DModelsServiceId[]) => void;
  updateLLM: (id: DLLMId, partial: Partial<DLLM>) => void;
  updateLLMUserParameters: (id: DLLMId, partial: Partial<DModelParameterValues>) => void;
  deleteLLMUserParameter: (id: DLLMId, parameterId: DModelParameterId) => void;

  createModelsService: (vendor: IModelVendor) => DModelsService;
  removeService: (id: DModelsServiceId) => void;
  updateServiceSettings: <TServiceSettings>(id: DModelsServiceId, partialSettings: Partial<TServiceSettings>) => void;

  setConfServiceId: (id: DModelsServiceId | null) => void;

  // special
  setOpenRouterKey: (key: string) => void;

}


type LlmsRootSlice = LlmsRootState & LlmsRootActions;
type LlmsStore = LlmsRootSlice & LlmsAssignmentsSlice;


export const useModelsStore = create<LlmsStore>()(persist(
  (set, get, _store) => ({

    // include slices
    ...createLlmsAssignmentsSlice(set, get, _store),

    // initial state

    llms: [],
    sources: [],
    confServiceId: null,

    // actions

    setLLMs: (llms: DLLM[], serviceId: DModelsServiceId, deleteExpiredVendorLlms: boolean, keepUserEdits: boolean) =>
      set(state => {

        // keep existing model customizations
        if (keepUserEdits) {
          llms = llms.map((llm: DLLM): DLLM => {
            const existing = state.llms.find(m => m.id === llm.id);
            return !existing ? llm : {
              ...llm,
              ...(existing.userLabel !== undefined ? { userLabel: existing.userLabel } : {}),
              ...(existing.userHidden !== undefined ? { userHidden: existing.userHidden } : {}),
              ...(existing.userParameters !== undefined ? { userParameters: { ...existing.userParameters } } : {}),
            };
          });
        }

        const otherLlms = deleteExpiredVendorLlms
          ? state.llms.filter(llm => llm.sId !== serviceId)
          : state.llms;

        // replace existing llms with the same id
        const newLlms = [...llms, ...otherLlms.filter(llm => !llms.find(m => m.id === llm.id))];
        return {
          llms: newLlms,
          ...llmsHeuristicUpdateAssignments(newLlms, state.chatLLMId, state.fastLLMId),
        };
      }),

    removeLLM: (id: DLLMId) =>
      set(state => {
        const newLlms = state.llms.filter(llm => llm.id !== id);
        return {
          llms: newLlms,
          ...llmsHeuristicUpdateAssignments(newLlms, state.chatLLMId, state.fastLLMId),
        };
      }),

    rerankLLMsByServices: (serviceIdOrder: DModelsServiceId[]) =>
      set(state => {
        // Create a mapping of service IDs to their index in the provided order
        const serviceIdToIndex = serviceIdOrder.reduce((acc, sId, idx) => {
          acc[sId] = idx;
          return acc;
        }, {} as Record<DModelsServiceId, number>);

        // Sort the LLMs based on the order of their service IDs
        const orderedLlms = [...state.llms].sort((a, b) => {
          const aIndex = serviceIdToIndex[a.sId] ?? Number.MAX_SAFE_INTEGER;
          const bIndex = serviceIdToIndex[b.sId] ?? Number.MAX_SAFE_INTEGER;
          return aIndex - bIndex;
        });

        return {
          llms: orderedLlms,
        };
      }),

    updateLLM: (id: DLLMId, partial: Partial<DLLM>) =>
      set(state => ({
        llms: state.llms.map((llm: DLLM): DLLM =>
          llm.id === id
            ? { ...llm, ...partial }
            : llm,
        ),
      })),

    updateLLMUserParameters: (id: DLLMId, partialUserParameters: Partial<DModelParameterValues>) =>
      set(({ llms }) => ({
        llms: llms.map((llm: DLLM): DLLM =>
          llm.id === id
            ? { ...llm, userParameters: { ...llm.userParameters, ...partialUserParameters } }
            : llm,
        ),
      })),

    deleteLLMUserParameter: (id: DLLMId, parameterId: DModelParameterId) =>
      set(({ llms }) => ({
        llms: llms.map((llm: DLLM): DLLM =>
          llm.id === id && llm.userParameters
            ? { ...llm, userParameters: Object.fromEntries(Object.entries(llm.userParameters).filter(([key]) => key !== parameterId)) }
            : llm,
        ),
      })),

    createModelsService: (vendor: IModelVendor): DModelsService => {

      function _locallyUniqueServiceId(vendorId: ModelVendorId, existingServices: DModelsService[]): DModelsServiceId {
        let serviceId: DModelsServiceId = vendorId;
        let serviceIdx = 0;
        while (existingServices.find(s => s.id === serviceId)) {
          serviceIdx++;
          serviceId = `${vendorId}-${serviceIdx}`;
        }
        return serviceId;
      }

      function _relabelServicesFromSameVendor(vendorId: ModelVendorId, services: DModelsService[]): DModelsService[] {
        let n = 0;
        return services.map((s: DModelsService): DModelsService =>
          (s.vId !== vendorId) ? s
            : { ...s, label: s.label.replace(/ #\d+$/, '') + (++n > 1 ? ` #${n}` : '') },
        );
      }

      const { sources: existingServices, confServiceId } = get();

      // create the service
      const newService: DModelsService = {
        id: _locallyUniqueServiceId(vendor.id, existingServices),
        label: vendor.name,
        vId: vendor.id,
        setup: vendor.initializeSetup?.() || {},
      };

      const newServices = _relabelServicesFromSameVendor(vendor.id, [...existingServices, newService]);

      set({
        sources: newServices,
        confServiceId: confServiceId ?? newService.id,
      });

      return newServices[newServices.length - 1];
    },

    removeService: (id: DModelsServiceId) =>
      set(state => {
        const llms = state.llms.filter(llm => llm.sId !== id);
        return {
          llms,
          sources: state.sources.filter(s => s.id !== id),
          ...llmsHeuristicUpdateAssignments(llms, state.chatLLMId, state.fastLLMId),
        };
      }),

    updateServiceSettings: <TServiceSettings>(id: DModelsServiceId, partialSettings: Partial<TServiceSettings>) =>
      set(state => ({
        sources: state.sources.map((s: DModelsService): DModelsService =>
          s.id === id
            ? { ...s, setup: { ...s.setup, ...partialSettings } }
            : s,
        ),
      })),

    setConfServiceId: (id: DModelsServiceId | null) =>
      set({ confServiceId: id }),

    setOpenRouterKey: (key: string) =>
      set(state => {
        const firstOpenRouterService = state.sources.find(s => s.vId === 'openrouter');
        return !firstOpenRouterService ? state : {
          sources: state.sources.map((s: DModelsService): DModelsService =>
            s.id === firstOpenRouterService.id
              ? { ...s, setup: { ...s.setup, oaiKey: key satisfies DOpenRouterServiceSettings['oaiKey'] } }
              : s,
          ),
        };
      }),

  }),
  {
    name: 'app-models',

    /* versioning:
     *  1: adds maxOutputTokens (default to half of contextTokens)
     *  2: large changes on all LLMs, and reset chat/fast/func LLMs
     *  3: big-AGI v2
     *  4: migrate .options to .initialParameters/.userParameters
     */
    version: 4,
    migrate: (_state: any, fromVersion: number): LlmsStore => {

      if (!_state) return _state;
      const state: LlmsStore = _state;

      // 0 -> 1: add 'maxOutputTokens' where missing
      if (fromVersion < 1)
        for (const llm of state.llms)
          if (llm.maxOutputTokens === undefined)
            llm.maxOutputTokens = llm.contextTokens ? Math.round(llm.contextTokens / 2) : null;

      // 1 -> 2: large changes
      if (fromVersion < 2) {
        for (const llm of state.llms) {
          delete (llm as any)['tags'];
          llm.interfaces = ['oai-chat' /* this is here like this to reduce dependencies */];
          // llm.inputTypes = { 'text': {} };
        }
        state.chatLLMId = null;
        state.fastLLMId = null;
      }

      // 2 -> 3: big-AGI v2: update all models for pricing info
      if (fromVersion < 3) {
        try {
          state.llms.forEach(portModelPricingV2toV3);
        } catch (error) {
          // ... if there's any error, ignore - shall be okay
        }
      }

      // 3 -> 4: migrate .options to .initialParameters/.userParameters
      if (fromVersion < 4) {
        try {
          state.llms.forEach(_port_V3Options_to_V4Parameters_inline);
        } catch (error) {
          // ... if there's any error, ignore - shall be okay
        }
      }

      return state;
    },

    // Pre-saving: omit the memory references from the persisted state
    // partialize: (state) => ({
    //   ...state,
    //   llms: state.llms.map((llm: DLLM): Omit<DLLM, 'itemToRemove'> => {
    //     const { itemToRemove, ...rest } = llm;
    //     return rest;
    //   }),
    // }),

    // Post-loading: ensure a valid starting state
    onRehydrateStorage: () => (state) => {
      if (!state) return;

      // [GC] remove models that do not refer to a valid service
      state.llms = state.llms.map((llm: DLLM): DLLM | null => {
        // finds the service that provides the model
        const service = state.sources.find(s => s.id === llm.sId);
        if (!service || !service.vId) return null;

        // ensure the vId link exists and is valid (this was a pre-TF update)
        return llm.vId ? llm : { ...llm, vId: service.vId };
      }).filter(llm => !!llm) as DLLM[];

      // Select the best LLMs automatically, if not set
      try {
        if (!state.chatLLMId || !state.fastLLMId)
          Object.assign(state, llmsHeuristicUpdateAssignments(state.llms, state.chatLLMId, state.fastLLMId));
      } catch (error) {
        console.error('Error in autoPickModels', error);
      }
    },

  },
));


export function findLLMOrThrow(llmId: DLLMId): DLLM {
  const llm: DLLM | undefined = llmsStoreState().llms.find(llm => llm.id === llmId);
  if (!llm)
    throw new Error(`Large Language Model ${llmId} not found`);
  return llm;
}

export function findModelsServiceOrNull<TServiceSettings extends object>(serviceId: DModelsServiceId): DModelsService<TServiceSettings> | null {
  return llmsStoreState().sources.find(s => s.id === serviceId) ?? null;
}

export function getChatLLMId(): DLLMId | null {
  return llmsStoreState().chatLLMId;
}


export function getLLMIdOrThrow(order: ('chat' | 'fast')[], supportsFunctionCallTool: boolean, supportsImageInput: boolean, useCaseLabel: string): DLLMId {
  const { chatLLMId, fastLLMId } = llmsStoreState();

  for (const preference of order) {
    const llmId = preference === 'chat' ? chatLLMId : fastLLMId;
    // we don't have one of those assigned, skip
    if (!llmId)
      continue;
    try {
      const llm = findLLMOrThrow(llmId);
      if (supportsFunctionCallTool && !llm.interfaces.includes(LLM_IF_OAI_Fn))
        continue;
      if (supportsImageInput && !llm.interfaces.includes(LLM_IF_OAI_Vision))
        continue;
      return llmId;
    } catch (error) {
      // Try next or fall back to the error
    }
  }

  throw new Error(`No model available for '${useCaseLabel}'. Pease select a ${order.join(' or ')} model that supports${supportsFunctionCallTool ? ' function calls' : ' text input'}${supportsImageInput ? ' and image input' : ''} in the Model Configuration.`);
}


export function llmsStoreState(): LlmsRootState & LlmsAssignmentsState {
  return useModelsStore.getState();
}

export function llmsStoreActions(): LlmsRootActions & LlmsAssignmentsActions {
  return useModelsStore.getState();
}

export function getLLMsDebugInfo() {
  const { llms, sources, chatLLMId, fastLLMId } = llmsStoreState();
  return { services: sources.length, llmsCount: llms.length, chatId: chatLLMId, fastId: fastLLMId };
}


function _port_V3Options_to_V4Parameters_inline(llm: DLLM): void {

  // skip if already migrated
  if ('initialParameters' in (llm as object)) return;

  // initialize initialParameters and userParameters if they don't exist
  if (!llm.initialParameters) llm.initialParameters = {};
  if (!llm.userParameters) llm.userParameters = {};

  // migrate options to initialParameters/userParameters
  type DLLMV3_Options = DLLM & { options?: { llmRef: string, llmTemperature?: number, llmResponseTokens?: number } & Record<string, any> };
  const llmV3 = llm as DLLMV3_Options;
  if ('options' in llmV3 && typeof llmV3.options === 'object') {
    if ('llmRef' in llmV3.options)
      llm.initialParameters.llmRef = llmV3.options.llmRef;
    if ('llmTemperature' in llmV3.options && typeof llmV3.options.llmTemperature === 'number')
      llm.initialParameters.llmTemperature = Math.max(0, Math.min(1, llmV3.options.llmTemperature));
    if ('llmResponseTokens' in llmV3.options && typeof llmV3.options.llmResponseTokens === 'number')
      llm.initialParameters.llmResponseTokens = llmV3.options.llmResponseTokens;
    delete llmV3.options;
  }

}