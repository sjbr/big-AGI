import { TRPCError } from '@trpc/server';
import * as z from 'zod/v4';

import { createTRPCRouter, publicProcedure } from '~/server/trpc/trpc.server';
import { fetchTextOrTRPCThrow } from '~/server/trpc/trpc.router.fetchers';

import { chatGptParseConversation, chatGptSharedChatSchema } from './chatgpt';
import { storageGetProcedure, storageMarkAsDeletedProcedure, storagePutProcedure, storageUpdateDeletionKeyProcedure } from './link';


export const importChatGptShareInputSchema = z.union([
  z.object({
    url: z.url().startsWith('https://chatgpt.com/share/'),
  }),
  z.object({
    htmlPage: z.string(),
  }),
]);


export const tradeRouter = createTRPCRouter({

  /** ChatGPT Shared Chats Importer */
  importChatGptShare: publicProcedure
    .input(importChatGptShareInputSchema)
    .output(z.object({ data: chatGptSharedChatSchema, conversationId: z.string() }))
    .mutation(async ({ input }) => {

      // download the page if URL is given, else use the source
      let htmlPage: string;

      if ('htmlPage' in input) {
        htmlPage = input.htmlPage;
      } else {
        // add headers that make it closest to a browser request
        htmlPage = await fetchTextOrTRPCThrow({
          url: input.url,
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
          },
          name: 'ChatGPT Importer',
        });
      }

      const data = chatGptParseConversation(htmlPage);

      return {
        data: data.props.pageProps.serverResponse.data,
        conversationId: data.props.pageProps.sharedConversationId,
      };
    }),

  /**
   * Write an object to storage, and return the ID, owner, and deletion key
   */
  storagePut: storagePutProcedure,

  /**
   * Read a stored object by ID (optional owner)
   */
  storageGet: storageGetProcedure,

  /**
   * Delete a stored object by ID and deletion key
   */
  storageDelete: storageMarkAsDeletedProcedure,

  /**
   * Update the deletion Key of a stored object by ID and deletion key
   */
  storageUpdateDeletionKey: storageUpdateDeletionKeyProcedure,


});