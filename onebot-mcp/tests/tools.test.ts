import assert from "node:assert/strict";
import test from "node:test";
import type { Platform } from "../src/config.js";
import type { OneBotPayload } from "../src/onebot-client.js";
import { callTool, listToolsForPlatform, toolDefinitions, type ToolDefinition, type ToolResponse } from "../src/tools.js";

function fakeClient() {
  const calls: Array<{ actionName: string; body: OneBotPayload }> = [];
  return {
    calls,
    async action(actionName: string, body: OneBotPayload = {}) {
      calls.push({ actionName, body });
      return { status: "ok", retcode: 0, data: { actionName, body } };
    },
  };
}

function emptyToolResponse(): ToolResponse {
  return { content: [], structuredContent: {} };
}

test("lists only tools with an adapter for the active platform", () => {
  const definitions: ToolDefinition[] = [
    {
      name: "shared",
      description: "shared",
      inputSchema: { type: "object" },
      adapters: { napcat: async () => emptyToolResponse(), lagrange: async () => emptyToolResponse() },
    },
    {
      name: "napcat_only",
      description: "napcat only",
      inputSchema: { type: "object" },
      adapters: { napcat: async () => emptyToolResponse() },
    },
  ];

  assert.deepEqual(
    listToolsForPlatform("lagrange", definitions).map((tool) => tool.name),
    ["shared"],
  );
});

test("send group message maps to send_group_msg", async () => {
  const client = fakeClient();
  const result = await callTool({
    platform: "napcat",
    name: "send_group_message",
    args: { group_id: 10001, message: "hello" },
    client,
  });

  assert.equal(client.calls[0]!.actionName, "send_group_msg");
  assert.deepEqual(client.calls[0]!.body, { group_id: 10001, message: "hello" });
  assert.equal((result.structuredContent as { status: string }).status, "ok");
});

test("group info tools map to OneBot group actions on all supported platforms", async () => {
  for (const platform of ["napcat", "llonebot", "lagrange"] as const) {
    const client = fakeClient();

    await callTool({
      platform,
      name: "get_group_info",
      args: { group_id: 10001, no_cache: true },
      client,
    });
    await callTool({
      platform,
      name: "get_group_list",
      args: {},
      client,
    });
    await callTool({
      platform,
      name: "get_group_member_list",
      args: { group_id: "10001" },
      client,
    });

    assert.deepEqual(client.calls, [
      {
        actionName: "get_group_info",
        body: { group_id: 10001, no_cache: true },
      },
      {
        actionName: "get_group_list",
        body: {},
      },
      {
        actionName: "get_group_member_list",
        body: { group_id: "10001" },
      },
    ]);
  }
});

test("reaction maps to set_msg_emoji_like on NapCat and LLOneBot", async () => {
  for (const platform of ["napcat", "llonebot"] as const) {
    const client = fakeClient();
    await callTool({
      platform,
      name: "set_group_reaction",
      args: { group_id: 10001, message_id: 42, emoji_id: 128077, set: false },
      client,
    });

    assert.deepEqual(client.calls[0], {
      actionName: "set_msg_emoji_like",
      body: { message_id: 42, emoji_id: 128077 },
    });
  }
});

test("reaction maps to set_group_reaction on Lagrange", async () => {
  const client = fakeClient();
  await callTool({
    platform: "lagrange",
    name: "set_group_reaction",
    args: { group_id: 10001, message_id: 42, emoji_id: "128077", set: false },
    client,
  });

  assert.deepEqual(client.calls[0], {
    actionName: "set_group_reaction",
    body: { group_id: 10001, message_id: 42, code: "128077", is_add: false },
  });
});

test("first batch tools are exposed without generic send aliases", () => {
  const toolNames = toolDefinitions.map((tool) => tool.name);
  const requiredTools = [
    "get_message",
    "get_group_message_history",
    "get_private_message_history",
    "get_forward_msg",
    "get_group_system_msg",
    "get_image",
    "send_group_message",
    "send_private_message",
    "recall_message",
    "send_group_forward_msg",
    "send_private_forward_msg",
    "forward_friend_single_msg",
    "forward_group_single_msg",
    "set_essence_msg",
    "delete_essence_msg",
    "get_essence_msg_list",
    "send_like",
    "set_group_reaction",
    "send_friend_poke",
    "send_group_poke",
    "send_group_sign",
    "get_group_info",
    "get_group_honor_info",
    "get_group_ignore_add_request",
    "get_group_shut_list",
    "get_group_notice",
    "send_group_notice",
    "delete_group_notice",
    "set_group_add_request",
    "set_group_admin",
    "set_group_ban",
    "set_group_whole_ban",
    "set_group_kick",
    "batch_kick_group_members",
    "set_group_card",
    "set_group_name",
    "set_group_portrait",
    "set_group_remark",
    "set_group_special_title",
    "get_group_root_files",
    "get_group_files_by_folder",
    "get_group_file_url",
    "create_group_file_folder",
    "delete_group_file",
    "delete_group_folder",
    "move_group_file",
    "rename_group_file",
    "rename_group_file_folder",
    "set_group_file_forever",
    "trans_group_file",
    "upload_group_file",
    "upload_group_album",
    "get_friend_list",
    "get_friends_with_category",
    "set_friend_add_request",
    "set_friend_remark",
    "delete_friend",
    "upload_private_file",
    "get_private_file_url",
    "get_profile_like",
    "get_profile_like_me",
    "get_qq_avatar",
    "set_qq_avatar",
  ];

  for (const name of requiredTools) {
    assert.ok(toolNames.includes(name), `${name} should be registered`);
  }

  assert.ok(!toolNames.includes("send_message"));
  assert.ok(!toolNames.includes("send_forward_msg"));
  assert.ok(!toolNames.includes("get_group_detail_info"));
});

test("platform-specific duplicate capabilities map to their concrete OneBot actions", async () => {
  const cases: Array<{
    platform: Platform;
    name: string;
    args: OneBotPayload;
    actionName: string;
    body: OneBotPayload;
  }> = [
    {
      platform: "napcat",
      name: "delete_group_notice",
      args: { group_id: 10001, message_id: 42 },
      actionName: "_del_group_notice",
      body: { group_id: 10001, message_id: 42 },
    },
    {
      platform: "llonebot",
      name: "delete_group_notice",
      args: { group_id: 10001, message_id: 42 },
      actionName: "_delete_group_notice",
      body: { group_id: 10001, message_id: 42 },
    },
    {
      platform: "lagrange",
      name: "delete_group_folder",
      args: { group_id: 10001, folder_id: "folder" },
      actionName: "delete_group_file_folder",
      body: { group_id: 10001, folder_id: "folder" },
    },
    {
      platform: "napcat",
      name: "batch_kick_group_members",
      args: { group_id: 10001, user_ids: [20002], reject_add_request: false },
      actionName: "set_group_kick_members",
      body: { group_id: 10001, user_ids: [20002], reject_add_request: false },
    },
    {
      platform: "llonebot",
      name: "batch_kick_group_members",
      args: { group_id: 10001, user_ids: [20002], reject_add_request: false },
      actionName: "batch_delete_group_member",
      body: { group_id: 10001, user_ids: [20002], reject_add_request: false },
    },
  ];

  for (const testCase of cases) {
    const client = fakeClient();
    await callTool({
      platform: testCase.platform,
      name: testCase.name,
      args: testCase.args,
      client,
    });

    assert.deepEqual(client.calls[0], {
      actionName: testCase.actionName,
      body: testCase.body,
    });
  }
});

test("selected platform-only tools are hidden on unsupported platforms", () => {
  const lagrangeTools = new Set(listToolsForPlatform("lagrange").map((tool) => tool.name));
  assert.ok(!lagrangeTools.has("get_group_system_msg"));
  assert.ok(!lagrangeTools.has("batch_kick_group_members"));
  assert.ok(!lagrangeTools.has("send_group_sign"));

  const napcatTools = new Set(listToolsForPlatform("napcat").map((tool) => tool.name));
  assert.ok(napcatTools.has("trans_group_file"));
  assert.ok(!napcatTools.has("set_group_file_forever"));
  assert.ok(!napcatTools.has("get_qq_avatar"));
});

test("unavailable tools are rejected before hitting OneBot", async () => {
  const client = fakeClient();
  await assert.rejects(
    () =>
      callTool({
        platform: "lagrange",
        name: "napcat_only",
        args: {},
        client,
        definitions: [
          {
            name: "napcat_only",
            description: "napcat only",
            inputSchema: { type: "object" },
            adapters: { napcat: async () => emptyToolResponse() },
          },
        ],
      }),
    /not available/,
  );

  assert.equal(client.calls.length, 0);
});
