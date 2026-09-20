import {
  type JsonObject,
  type OneBotId,
  optionalBoolean,
  requireId,
  requireMessage,
  requireObject,
} from "./schema.js";
import type { Platform } from "./config.js";
import type { OneBotClient, OneBotPayload } from "./onebot-client.js";

type JsonSchema = Record<string, unknown>;
type PlatformMap<T> = Partial<Record<Platform, T>>;
type PropertyName = keyof typeof commonProperties;
type ToolContent = { type: "text"; text: string };
export type ToolResponse = { content: ToolContent[]; structuredContent: unknown };
type OneBotActionClient = Pick<OneBotClient, "action">;
type AdapterContext = { args: unknown; client: OneBotActionClient };
type ToolAdapter = (context: AdapterContext) => Promise<ToolResponse>;
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  adapters: PlatformMap<ToolAdapter>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

const PLATFORMS: Platform[] = ["napcat", "llonebot", "lagrange"];

const idValue = (description: string): JsonSchema => ({
  description,
  anyOf: [{ type: "number" }, { type: "string" }],
});

const idArray = (description: string): JsonSchema => ({
  description,
  type: "array",
  minItems: 1,
  items: {
    anyOf: [{ type: "number" }, { type: "string" }],
  },
});

const groupId = idValue("QQ group id.");
const userId = idValue("QQ user id.");
const messageId = idValue("OneBot message id.");
const fileId = idValue("OneBot file id.");
const folderId = idValue("OneBot group file folder id.");
const filePathOrUrl = {
  type: "string",
  minLength: 1,
  description: "Local path, URL, or platform-specific file identifier accepted by the OneBot implementation.",
};
const message = {
  description: "Plain text or OneBot message segment array.",
  anyOf: [{ type: "string" }, { type: "array" }],
};
const messages = {
  description: "OneBot forward message nodes or platform-specific forward message payload.",
  anyOf: [{ type: "array" }, { type: "object" }],
};

const commonProperties = {
  group_id: groupId,
  user_id: userId,
  user_ids: idArray("QQ user ids."),
  message_id: messageId,
  message,
  messages,
  auto_escape: {
    type: "boolean",
    description: "Whether OneBot should treat the message as plain text.",
  },
  no_cache: {
    type: "boolean",
    description: "Ask the platform to bypass cached metadata when supported.",
  },
  emoji_id: idValue("QQ emoji/reaction id."),
  set: {
    type: "boolean",
    description: "true to add, false to remove when supported.",
  },
  type: {
    type: "string",
    description: "OneBot/platform-specific query type.",
  },
  flag: {
    type: "string",
    minLength: 1,
    description: "OneBot request flag.",
  },
  approve: {
    type: "boolean",
    description: "Whether to approve the request.",
  },
  reason: {
    type: "string",
    description: "Reason/comment for request handling or moderation actions.",
  },
  comment: {
    type: "string",
    description: "Comment for request handling when supported.",
  },
  enable: {
    type: "boolean",
    description: "Whether to enable this state.",
  },
  reject_add_request: {
    type: "boolean",
    description: "Whether to reject future add requests when kicking a user, when supported.",
  },
  duration: {
    type: "integer",
    minimum: 0,
    description: "Duration in seconds.",
  },
  card: {
    type: "string",
    description: "Group member card.",
  },
  group_name: {
    type: "string",
    minLength: 1,
    description: "New group name.",
  },
  remark: {
    type: "string",
    description: "Friend or group remark.",
  },
  special_title: {
    type: "string",
    description: "Group member special title.",
  },
  file: filePathOrUrl,
  file_id: fileId,
  folder_id: folderId,
  folder_name: {
    type: "string",
    minLength: 1,
    description: "Group file folder name.",
  },
  name: {
    type: "string",
    minLength: 1,
    description: "Platform-specific name field.",
  },
  new_name: {
    type: "string",
    minLength: 1,
    description: "New file or folder name.",
  },
  parent_folder_id: folderId,
  target_folder_id: folderId,
  busid: idValue("OneBot file busid when required by the platform."),
} satisfies Record<string, JsonSchema>;

const basicPropertyNames = [
  "group_id",
  "user_id",
  "message_id",
  "message",
  "messages",
  "auto_escape",
  "no_cache",
  "emoji_id",
  "set",
  "type",
  "flag",
  "approve",
  "reason",
  "comment",
  "enable",
  "reject_add_request",
  "duration",
  "card",
  "group_name",
  "remark",
  "special_title",
  "file",
  "file_id",
  "folder_id",
  "folder_name",
  "name",
  "new_name",
  "parent_folder_id",
  "target_folder_id",
  "busid",
] as const;

const idFields = new Set([
  "group_id",
  "user_id",
  "message_id",
  "emoji_id",
  "file_id",
  "folder_id",
  "parent_folder_id",
  "target_folder_id",
  "busid",
]);

const messageFields = new Set(["message"]);
const booleanFields = new Set(["auto_escape", "no_cache", "set", "approve", "enable", "reject_add_request"]);

function textToolResponse(data: unknown): ToolResponse {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
  };
}

function defineTool({ name, description, inputSchema, adapters }: ToolDefinition): ToolDefinition {
  return { name, description, inputSchema, adapters };
}

function stripActionName(actionName: string): string {
  return actionName.replace(/^\/+/, "");
}

function schemaFor({
  required = [],
  propertyNames = basicPropertyNames,
}: {
  required?: readonly PropertyName[];
  propertyNames?: readonly PropertyName[];
}): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const name of propertyNames) {
    properties[name] = commonProperties[name];
  }

  return {
    type: "object",
    additionalProperties: true,
    ...(required.length > 0 ? { required } : {}),
    properties,
    description: "Additional platform-specific OneBot parameters are forwarded unchanged.",
  };
}

function normalizeForwardedArgs(args: unknown, { required = [] }: { required?: readonly PropertyName[] } = {}): OneBotPayload {
  const input = requireObject(args);
  for (const field of required) {
    if (input[field] == null) {
      throw new Error(`${field} is required`);
    }
  }

  const body: JsonObject = { ...input };
  for (const [field, value] of Object.entries(body)) {
    if (idFields.has(field)) {
      body[field] = requireId(value, field);
    } else if (field === "user_ids") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new Error("user_ids must be a non-empty array");
      }
      body[field] = value.map((item) => requireId(item, "user_ids item"));
    } else if (messageFields.has(field)) {
      body[field] = requireMessage(value, field);
    } else if (booleanFields.has(field)) {
      body[field] = optionalBoolean(value, field);
    }
  }

  return body;
}

function buildAdapters({
  actions,
  normalize,
}: {
  actions: PlatformMap<string>;
  normalize: (args: unknown, platform: Platform) => OneBotPayload;
}): PlatformMap<ToolAdapter> {
  const adapters: PlatformMap<ToolAdapter> = {};
  for (const platform of PLATFORMS) {
    const actionName = actions[platform];
    if (!actionName) continue;
    adapters[platform] = async ({ args, client }) => {
      const body = normalize(args, platform);
      return textToolResponse(await client.action(stripActionName(actionName), body));
    };
  }
  return adapters;
}

function defineActionTool({
  name,
  description,
  actions,
  required = [],
  propertyNames,
  normalize = (args) => normalizeForwardedArgs(args, { required }),
}: {
  name: string;
  description: string;
  actions: PlatformMap<string>;
  required?: readonly PropertyName[];
  propertyNames?: readonly PropertyName[];
  normalize?: (args: unknown, platform: Platform) => OneBotPayload;
}): ToolDefinition {
  return defineTool({
    name,
    description,
    inputSchema: schemaFor(propertyNames === undefined ? { required } : { required, propertyNames }),
    adapters: buildAdapters({ actions, normalize }),
  });
}

function allPlatforms(actionName: string): Record<Platform, string> {
  return {
    napcat: actionName,
    llonebot: actionName,
    lagrange: actionName,
  };
}

function napcatLlonebot(actionName: string): PlatformMap<string> {
  return {
    napcat: actionName,
    llonebot: actionName,
  };
}

function napcatOnly(actionName: string): PlatformMap<string> {
  return { napcat: actionName };
}

function llonebotOnly(actionName: string): PlatformMap<string> {
  return { llonebot: actionName };
}

const actionToolDefinitions = [
  defineActionTool({
    name: "send_group_message",
    description: "Send a message to a QQ group through the configured OneBot platform.",
    actions: allPlatforms("send_group_msg"),
    required: ["group_id", "message"],
    propertyNames: ["group_id", "message", "auto_escape"],
  }),
  defineActionTool({
    name: "get_message",
    description: "Get one message by OneBot message id.",
    actions: allPlatforms("get_msg"),
    required: ["message_id"],
    propertyNames: ["message_id"],
  }),
  defineActionTool({
    name: "get_group_info",
    description: "Get QQ group metadata by group id.",
    actions: allPlatforms("get_group_info"),
    required: ["group_id"],
    propertyNames: ["group_id", "no_cache"],
  }),
  defineActionTool({
    name: "get_group_list",
    description: "Get the list of QQ groups visible to the bot account.",
    actions: allPlatforms("get_group_list"),
    propertyNames: [],
  }),
  defineActionTool({
    name: "get_group_member_list",
    description: "Get the member list of a QQ group.",
    actions: allPlatforms("get_group_member_list"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_group_message_history",
    description: "Get recent message history for a QQ group.",
    actions: allPlatforms("get_group_msg_history"),
    required: ["group_id"],
    propertyNames: ["group_id", "message_id"],
  }),
  defineActionTool({
    name: "get_private_message_history",
    description: "Get recent private message history for a QQ user.",
    actions: allPlatforms("get_friend_msg_history"),
    required: ["user_id"],
    propertyNames: ["user_id", "message_id"],
  }),
  defineActionTool({
    name: "get_forward_msg",
    description: "Get forwarded message details.",
    actions: allPlatforms("get_forward_msg"),
    required: ["message_id"],
    propertyNames: ["message_id"],
  }),
  defineActionTool({
    name: "get_group_system_msg",
    description: "Get group system messages such as join requests and invitations.",
    actions: napcatLlonebot("get_group_system_msg"),
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_image",
    description: "Get image details for a message image file.",
    actions: napcatLlonebot("get_image"),
    required: ["file"],
    propertyNames: ["file"],
  }),
  defineActionTool({
    name: "send_private_message",
    description: "Send a private message to a QQ user.",
    actions: allPlatforms("send_private_msg"),
    required: ["user_id", "message"],
    propertyNames: ["user_id", "message", "auto_escape"],
  }),
  defineActionTool({
    name: "recall_message",
    description: "Recall or delete a sent message by message id.",
    actions: allPlatforms("delete_msg"),
    required: ["message_id"],
    propertyNames: ["message_id"],
  }),
  defineActionTool({
    name: "send_group_forward_msg",
    description: "Send a merged-forward message to a QQ group.",
    actions: allPlatforms("send_group_forward_msg"),
    required: ["group_id", "messages"],
    propertyNames: ["group_id", "messages"],
  }),
  defineActionTool({
    name: "send_private_forward_msg",
    description: "Send a merged-forward message to a QQ user.",
    actions: allPlatforms("send_private_forward_msg"),
    required: ["user_id", "messages"],
    propertyNames: ["user_id", "messages"],
  }),
  defineActionTool({
    name: "forward_friend_single_msg",
    description: "Forward one existing message to a QQ user.",
    actions: napcatLlonebot("forward_friend_single_msg"),
    required: ["user_id", "message_id"],
    propertyNames: ["user_id", "message_id"],
  }),
  defineActionTool({
    name: "forward_group_single_msg",
    description: "Forward one existing message to a QQ group.",
    actions: napcatLlonebot("forward_group_single_msg"),
    required: ["group_id", "message_id"],
    propertyNames: ["group_id", "message_id"],
  }),
  defineActionTool({
    name: "set_essence_msg",
    description: "Mark a group message as an essence message.",
    actions: allPlatforms("set_essence_msg"),
    required: ["message_id"],
    propertyNames: ["message_id"],
  }),
  defineActionTool({
    name: "delete_essence_msg",
    description: "Remove a group message from the essence message list.",
    actions: allPlatforms("delete_essence_msg"),
    required: ["message_id"],
    propertyNames: ["message_id"],
  }),
  defineActionTool({
    name: "get_essence_msg_list",
    description: "Get the essence message list of a QQ group.",
    actions: allPlatforms("get_essence_msg_list"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "send_like",
    description: "Like a QQ user's profile.",
    actions: allPlatforms("send_like"),
    required: ["user_id"],
    propertyNames: ["user_id"],
  }),
  defineActionTool({
    name: "send_friend_poke",
    description: "Send a private/friend poke.",
    actions: allPlatforms("friend_poke"),
    required: ["user_id"],
    propertyNames: ["user_id"],
  }),
  defineActionTool({
    name: "send_group_poke",
    description: "Send a group poke to a group member.",
    actions: allPlatforms("group_poke"),
    required: ["group_id", "user_id"],
    propertyNames: ["group_id", "user_id"],
  }),
  defineActionTool({
    name: "send_group_sign",
    description: "Perform group sign-in/check-in.",
    actions: napcatLlonebot("send_group_sign"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_group_honor_info",
    description: "Get group honor information.",
    actions: allPlatforms("get_group_honor_info"),
    required: ["group_id"],
    propertyNames: ["group_id", "type"],
  }),
  defineActionTool({
    name: "get_group_ignore_add_request",
    description: "Get ignored or filtered group join requests.",
    actions: napcatLlonebot("get_group_ignore_add_request"),
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_group_shut_list",
    description: "Get the muted member list of a QQ group.",
    actions: napcatLlonebot("get_group_shut_list"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_group_notice",
    description: "Get group notices.",
    actions: allPlatforms("_get_group_notice"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "send_group_notice",
    description: "Send a group notice.",
    actions: allPlatforms("_send_group_notice"),
    required: ["group_id"],
    propertyNames: ["group_id", "message"],
  }),
  defineActionTool({
    name: "delete_group_notice",
    description: "Delete a group notice.",
    actions: {
      napcat: "_del_group_notice",
      llonebot: "_delete_group_notice",
      lagrange: "_del_group_notice",
    },
    required: ["group_id"],
    propertyNames: ["group_id", "message_id", "file_id"],
  }),
  defineActionTool({
    name: "set_group_add_request",
    description: "Handle a group join request or invitation.",
    actions: allPlatforms("set_group_add_request"),
    required: ["flag", "approve"],
    propertyNames: ["flag", "approve", "reason", "comment"],
  }),
  defineActionTool({
    name: "set_group_admin",
    description: "Set or unset a group administrator.",
    actions: allPlatforms("set_group_admin"),
    required: ["group_id", "user_id", "enable"],
    propertyNames: ["group_id", "user_id", "enable"],
  }),
  defineActionTool({
    name: "set_group_ban",
    description: "Mute a group member for a duration.",
    actions: allPlatforms("set_group_ban"),
    required: ["group_id", "user_id", "duration"],
    propertyNames: ["group_id", "user_id", "duration"],
  }),
  defineActionTool({
    name: "set_group_whole_ban",
    description: "Enable or disable whole-group mute.",
    actions: allPlatforms("set_group_whole_ban"),
    required: ["group_id", "enable"],
    propertyNames: ["group_id", "enable"],
  }),
  defineActionTool({
    name: "set_group_kick",
    description: "Kick one member from a QQ group.",
    actions: allPlatforms("set_group_kick"),
    required: ["group_id", "user_id"],
    propertyNames: ["group_id", "user_id", "reject_add_request"],
  }),
  defineActionTool({
    name: "batch_kick_group_members",
    description: "Kick multiple members from a QQ group when the platform supports batch kicking.",
    actions: {
      napcat: "set_group_kick_members",
      llonebot: "batch_delete_group_member",
    },
    required: ["group_id", "user_ids"],
    propertyNames: ["group_id", "user_ids", "reject_add_request"],
  }),
  defineActionTool({
    name: "set_group_card",
    description: "Set a group member card.",
    actions: allPlatforms("set_group_card"),
    required: ["group_id", "user_id", "card"],
    propertyNames: ["group_id", "user_id", "card"],
  }),
  defineActionTool({
    name: "set_group_name",
    description: "Set a QQ group name.",
    actions: allPlatforms("set_group_name"),
    required: ["group_id", "group_name"],
    propertyNames: ["group_id", "group_name"],
  }),
  defineActionTool({
    name: "set_group_portrait",
    description: "Set a QQ group avatar/portrait.",
    actions: allPlatforms("set_group_portrait"),
    required: ["group_id", "file"],
    propertyNames: ["group_id", "file"],
  }),
  defineActionTool({
    name: "set_group_remark",
    description: "Set the local remark for a QQ group.",
    actions: napcatLlonebot("set_group_remark"),
    required: ["group_id", "remark"],
    propertyNames: ["group_id", "remark"],
  }),
  defineActionTool({
    name: "set_group_special_title",
    description: "Set a group member special title.",
    actions: allPlatforms("set_group_special_title"),
    required: ["group_id", "user_id", "special_title"],
    propertyNames: ["group_id", "user_id", "special_title"],
  }),
  defineActionTool({
    name: "get_group_root_files",
    description: "Get root-level group files.",
    actions: allPlatforms("get_group_root_files"),
    required: ["group_id"],
    propertyNames: ["group_id"],
  }),
  defineActionTool({
    name: "get_group_files_by_folder",
    description: "Get group files under a folder.",
    actions: allPlatforms("get_group_files_by_folder"),
    required: ["group_id", "folder_id"],
    propertyNames: ["group_id", "folder_id"],
  }),
  defineActionTool({
    name: "get_group_file_url",
    description: "Get a group file download URL.",
    actions: allPlatforms("get_group_file_url"),
    required: ["group_id", "file_id"],
    propertyNames: ["group_id", "file_id", "busid"],
  }),
  defineActionTool({
    name: "create_group_file_folder",
    description: "Create a group file folder.",
    actions: allPlatforms("create_group_file_folder"),
    required: ["group_id", "folder_name"],
    propertyNames: ["group_id", "folder_name", "parent_folder_id"],
  }),
  defineActionTool({
    name: "delete_group_file",
    description: "Delete a group file.",
    actions: allPlatforms("delete_group_file"),
    required: ["group_id", "file_id"],
    propertyNames: ["group_id", "file_id", "busid"],
  }),
  defineActionTool({
    name: "delete_group_folder",
    description: "Delete a group file folder.",
    actions: {
      napcat: "delete_group_folder",
      llonebot: "delete_group_folder",
      lagrange: "delete_group_file_folder",
    },
    required: ["group_id", "folder_id"],
    propertyNames: ["group_id", "folder_id"],
  }),
  defineActionTool({
    name: "move_group_file",
    description: "Move a group file.",
    actions: allPlatforms("move_group_file"),
    required: ["group_id", "file_id"],
    propertyNames: ["group_id", "file_id", "parent_folder_id", "target_folder_id"],
  }),
  defineActionTool({
    name: "rename_group_file",
    description: "Rename a group file.",
    actions: napcatLlonebot("rename_group_file"),
    required: ["group_id", "file_id", "new_name"],
    propertyNames: ["group_id", "file_id", "new_name", "busid"],
  }),
  defineActionTool({
    name: "rename_group_file_folder",
    description: "Rename a group file folder.",
    actions: {
      llonebot: "rename_group_file_folder",
      lagrange: "rename_group_file_folder",
    },
    required: ["group_id", "folder_id", "new_name"],
    propertyNames: ["group_id", "folder_id", "new_name"],
  }),
  defineActionTool({
    name: "set_group_file_forever",
    description: "Convert a group file into a permanent group file when supported.",
    actions: llonebotOnly("set_group_file_forever"),
    required: ["group_id", "file_id"],
    propertyNames: ["group_id", "file_id", "busid"],
  }),
  defineActionTool({
    name: "trans_group_file",
    description: "Transfer or persist a group file when supported.",
    actions: napcatOnly("trans_group_file"),
    required: ["group_id", "file_id"],
    propertyNames: ["group_id", "file_id", "busid"],
  }),
  defineActionTool({
    name: "upload_group_file",
    description: "Upload a file to a QQ group.",
    actions: allPlatforms("upload_group_file"),
    required: ["group_id", "file"],
    propertyNames: ["group_id", "file", "name", "folder_id"],
  }),
  defineActionTool({
    name: "upload_group_album",
    description: "Upload a file or image to a group album when supported.",
    actions: llonebotOnly("upload_group_album"),
    required: ["group_id", "file"],
    propertyNames: ["group_id", "file", "name"],
  }),
  defineActionTool({
    name: "get_friend_list",
    description: "Get the bot account's friend list.",
    actions: allPlatforms("get_friend_list"),
    propertyNames: [],
  }),
  defineActionTool({
    name: "get_friends_with_category",
    description: "Get friends grouped by category when supported.",
    actions: napcatLlonebot("get_friends_with_category"),
    propertyNames: [],
  }),
  defineActionTool({
    name: "set_friend_add_request",
    description: "Handle a friend add request.",
    actions: allPlatforms("set_friend_add_request"),
    required: ["flag", "approve"],
    propertyNames: ["flag", "approve", "reason", "comment"],
  }),
  defineActionTool({
    name: "set_friend_remark",
    description: "Set a QQ friend remark.",
    actions: napcatLlonebot("set_friend_remark"),
    required: ["user_id", "remark"],
    propertyNames: ["user_id", "remark"],
  }),
  defineActionTool({
    name: "delete_friend",
    description: "Delete a QQ friend.",
    actions: allPlatforms("delete_friend"),
    required: ["user_id"],
    propertyNames: ["user_id"],
  }),
  defineActionTool({
    name: "upload_private_file",
    description: "Upload a file to a private chat.",
    actions: allPlatforms("upload_private_file"),
    required: ["user_id", "file"],
    propertyNames: ["user_id", "file", "name"],
  }),
  defineActionTool({
    name: "get_private_file_url",
    description: "Get a private file download URL.",
    actions: allPlatforms("get_private_file_url"),
    required: ["user_id", "file_id"],
    propertyNames: ["user_id", "file_id"],
  }),
  defineActionTool({
    name: "get_profile_like",
    description: "Get profile-like information or users liked by the bot account.",
    actions: napcatLlonebot("get_profile_like"),
    propertyNames: ["user_id"],
  }),
  defineActionTool({
    name: "get_profile_like_me",
    description: "Get users who liked the bot account profile when supported.",
    actions: llonebotOnly("get_profile_like_me"),
    propertyNames: [],
  }),
  defineActionTool({
    name: "get_qq_avatar",
    description: "Get a QQ user or group avatar URL when supported.",
    actions: llonebotOnly("get_qq_avatar"),
    propertyNames: ["user_id", "group_id"],
  }),
  defineActionTool({
    name: "set_qq_avatar",
    description: "Set the bot account QQ avatar.",
    actions: allPlatforms("set_qq_avatar"),
    required: ["file"],
    propertyNames: ["file"],
  }),
];

const reactionTool = defineTool({
  name: "set_group_reaction",
  description: "Add or remove a QQ group message reaction using the current platform's extension API.",
  inputSchema: schemaFor({
    required: ["group_id", "message_id", "emoji_id"],
    propertyNames: ["group_id", "message_id", "emoji_id", "set"],
  }),
  adapters: {
    napcat: async ({ args, client }) => {
      const body = normalizeEmojiLike(args);
      return textToolResponse(await client.action("set_msg_emoji_like", body));
    },
    llonebot: async ({ args, client }) => {
      const body = normalizeEmojiLike(args);
      return textToolResponse(await client.action("set_msg_emoji_like", body));
    },
    lagrange: async ({ args, client }) => {
      const body = normalizeLagrangeReaction(args);
      return textToolResponse(await client.action("set_group_reaction", body));
    },
  },
});

export const toolDefinitions: ToolDefinition[] = insertAfter(actionToolDefinitions, "send_like", reactionTool);

export function listToolsForPlatform(platform: Platform, definitions: readonly ToolDefinition[] = toolDefinitions): McpTool[] {
  return definitions
    .filter((tool) => Object.hasOwn(tool.adapters, platform))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool({
  platform,
  name,
  args,
  client,
  definitions = toolDefinitions,
}: {
  platform: Platform;
  name: string;
  args: unknown;
  client: OneBotActionClient;
  definitions?: readonly ToolDefinition[];
}): Promise<ToolResponse> {
  const tool = definitions.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const adapter = tool.adapters[platform];
  if (!adapter) {
    throw new Error(`Tool ${name} is not available on platform ${platform}`);
  }

  return adapter({ args: requireObject(args, "tool arguments"), client });
}

function insertAfter(definitions: readonly ToolDefinition[], afterName: string, tool: ToolDefinition): ToolDefinition[] {
  const index = definitions.findIndex((candidate) => candidate.name === afterName);
  if (index === -1) return [...definitions, tool];
  return [...definitions.slice(0, index + 1), tool, ...definitions.slice(index + 1)];
}

function normalizeEmojiLike(args: unknown): OneBotPayload {
  const input = requireObject(args);
  return {
    message_id: requireId(input.message_id, "message_id"),
    emoji_id: requireId(input.emoji_id, "emoji_id"),
  };
}

function normalizeLagrangeReaction(args: unknown): OneBotPayload {
  const input = requireObject(args);
  const set = optionalBoolean(input.set, "set");
  return {
    group_id: requireId(input.group_id, "group_id"),
    message_id: requireId(input.message_id, "message_id"),
    code: requireId(input.emoji_id, "emoji_id"),
    is_add: set ?? true,
  };
}
