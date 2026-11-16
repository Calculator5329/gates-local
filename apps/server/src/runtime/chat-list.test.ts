import { CHAT_MODELS } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { chatList, onChatList, useChatList } from "./chat-list.ts";
import { curatedModels } from "./recommended.ts";

afterEach(() => useChatList(CHAT_MODELS));

it("a list put in use shows on the next read, and listeners hear only another list", () => {
  const heard: number[] = [];
  const off = onChatList((list) => heard.push(list.revision));
  useChatList(CHAT_MODELS);
  expect(heard).toEqual([]);

  const newer = { ...CHAT_MODELS, revision: CHAT_MODELS.revision + 1, models: CHAT_MODELS.models.slice(0, 1) };
  useChatList(newer);
  expect(chatList()).toBe(newer);
  expect(curatedModels().map((m) => m.name)).toEqual(newer.models.map((m) => m.name));
  expect(heard).toEqual([newer.revision]);

  useChatList(newer);
  off();
  useChatList(CHAT_MODELS);
  expect(heard).toEqual([newer.revision]);
});
