# Implemented API Matrix

This file records implemented canonical MCP tools and their platform adapters.

The server reads `ONEBOT_PLATFORM` at startup and only exposes tools whose
adapter exists for that platform. Changing the platform requires restarting the
HTTP MCP server.

For the broader scanned API surface, see
[full-api-matrix.md](full-api-matrix.md).

Generic aliases such as `send_message`, `send_forward_msg`, and
`get_group_detail_info` are intentionally not exposed in this implemented
surface. Use the explicit group/private or common OneBot tools instead.

## Message Read And History

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `get_message` | `get_msg` | `get_msg` | `get_msg` | Fetches a message by id. |
| `get_group_message_history` | `get_group_msg_history` | `get_group_msg_history` | `get_group_msg_history` | Fetches group message history. |
| `get_private_message_history` | `get_friend_msg_history` | `get_friend_msg_history` | `get_friend_msg_history` | Fetches private/friend message history. |
| `get_forward_msg` | `get_forward_msg` | `get_forward_msg` | `get_forward_msg` | Fetches merged-forward message details. |
| `get_group_system_msg` | `get_group_system_msg` | `get_group_system_msg` | - | Fetches group system messages. |
| `get_image` | `get_image` | `get_image` | - | Fetches message image details. |

## Message Send, Recall, And Forward

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `send_group_message` | `send_group_msg` | `send_group_msg` | `send_group_msg` | Sends text or OneBot message segments to a group. |
| `send_private_message` | `send_private_msg` | `send_private_msg` | `send_private_msg` | Sends text or OneBot message segments to a private chat. |
| `recall_message` | `delete_msg` | `delete_msg` | `delete_msg` | Recalls/deletes a message by id. |
| `send_group_forward_msg` | `send_group_forward_msg` | `send_group_forward_msg` | `send_group_forward_msg` | Sends a group merged-forward message. |
| `send_private_forward_msg` | `send_private_forward_msg` | `send_private_forward_msg` | `send_private_forward_msg` | Sends a private merged-forward message. |
| `forward_friend_single_msg` | `forward_friend_single_msg` | `forward_friend_single_msg` | - | Forwards one message to a friend/private chat. |
| `forward_group_single_msg` | `forward_group_single_msg` | `forward_group_single_msg` | - | Forwards one message to a group. |

## Essence, Likes, Reactions, And Pokes

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `set_essence_msg` | `set_essence_msg` | `set_essence_msg` | `set_essence_msg` | Adds a message to group essence messages. |
| `delete_essence_msg` | `delete_essence_msg` | `delete_essence_msg` | `delete_essence_msg` | Removes a message from group essence messages. |
| `get_essence_msg_list` | `get_essence_msg_list` | `get_essence_msg_list` | `get_essence_msg_list` | Lists group essence messages. |
| `send_like` | `send_like` | `send_like` | `send_like` | Likes a user's profile. |
| `set_group_reaction` | `set_msg_emoji_like` | `set_msg_emoji_like` | `set_group_reaction` | Uses canonical `emoji_id`; Lagrange maps it to `code`. |
| `send_friend_poke` | `friend_poke` | `friend_poke` | `friend_poke` | Sends a friend/private poke. |
| `send_group_poke` | `group_poke` | `group_poke` | `group_poke` | Sends a group poke. |
| `send_group_sign` | `send_group_sign` | `send_group_sign` | - | Performs group sign-in/check-in. |

## Group Info, Notices, And Requests

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `get_group_info` | `get_group_info` | `get_group_info` | `get_group_info` | Fetches group metadata. |
| `get_group_list` | `get_group_list` | `get_group_list` | `get_group_list` | Fetches groups visible to the bot account. |
| `get_group_member_list` | `get_group_member_list` | `get_group_member_list` | `get_group_member_list` | Fetches members of a group. |
| `get_group_honor_info` | `get_group_honor_info` | `get_group_honor_info` | `get_group_honor_info` | Fetches group honor information. |
| `get_group_ignore_add_request` | `get_group_ignore_add_request` | `get_group_ignore_add_request` | - | Fetches ignored/filtered group join requests. |
| `get_group_shut_list` | `get_group_shut_list` | `get_group_shut_list` | - | Fetches muted group members. |
| `get_group_notice` | `_get_group_notice` | `_get_group_notice` | `_get_group_notice` | Fetches group notices. |
| `send_group_notice` | `_send_group_notice` | `_send_group_notice` | `_send_group_notice` | Sends a group notice. |
| `delete_group_notice` | `_del_group_notice` | `_delete_group_notice` | `_del_group_notice` | Deletes a group notice. |
| `set_group_add_request` | `set_group_add_request` | `set_group_add_request` | `set_group_add_request` | Handles group join requests/invitations. |

## Group Moderation And Metadata

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `set_group_admin` | `set_group_admin` | `set_group_admin` | `set_group_admin` | Sets or unsets a group administrator. |
| `set_group_ban` | `set_group_ban` | `set_group_ban` | `set_group_ban` | Mutes one group member. |
| `set_group_whole_ban` | `set_group_whole_ban` | `set_group_whole_ban` | `set_group_whole_ban` | Enables/disables whole-group mute. |
| `set_group_kick` | `set_group_kick` | `set_group_kick` | `set_group_kick` | Kicks one group member. |
| `batch_kick_group_members` | `set_group_kick_members` | `batch_delete_group_member` | - | Batch-kicks group members. |
| `set_group_card` | `set_group_card` | `set_group_card` | `set_group_card` | Sets a group member card. |
| `set_group_name` | `set_group_name` | `set_group_name` | `set_group_name` | Sets group name. |
| `set_group_portrait` | `set_group_portrait` | `set_group_portrait` | `set_group_portrait` | Sets group avatar/portrait. |
| `set_group_remark` | `set_group_remark` | `set_group_remark` | - | Sets local group remark. |
| `set_group_special_title` | `set_group_special_title` | `set_group_special_title` | `set_group_special_title` | Sets group member special title. |

## Group Files

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `get_group_root_files` | `get_group_root_files` | `get_group_root_files` | `get_group_root_files` | Lists root-level group files. |
| `get_group_files_by_folder` | `get_group_files_by_folder` | `get_group_files_by_folder` | `get_group_files_by_folder` | Lists files in a group folder. |
| `get_group_file_url` | `get_group_file_url` | `get_group_file_url` | `get_group_file_url` | Gets a group file download URL. |
| `create_group_file_folder` | `create_group_file_folder` | `create_group_file_folder` | `create_group_file_folder` | Creates a group file folder. |
| `delete_group_file` | `delete_group_file` | `delete_group_file` | `delete_group_file` | Deletes a group file. |
| `delete_group_folder` | `delete_group_folder` | `delete_group_folder` | `delete_group_file_folder` | Deletes a group file folder. |
| `move_group_file` | `move_group_file` | `move_group_file` | `move_group_file` | Moves a group file. |
| `rename_group_file` | `rename_group_file` | `rename_group_file` | - | Renames a group file. |
| `rename_group_file_folder` | - | `rename_group_file_folder` | `rename_group_file_folder` | Renames a group file folder. |
| `set_group_file_forever` | - | `set_group_file_forever` | - | Converts a group file to permanent when supported. |
| `trans_group_file` | `trans_group_file` | - | - | Transfers/persists a group file when supported. |
| `upload_group_file` | `upload_group_file` | `upload_group_file` | `upload_group_file` | Uploads a file to a group. |
| `upload_group_album` | - | `upload_group_album` | - | Uploads to a group album when supported. |

## Friends, Private Files, And Profile

| MCP tool | NapCat action | LLOneBot action | Lagrange action | Notes |
| --- | --- | --- | --- | --- |
| `get_friend_list` | `get_friend_list` | `get_friend_list` | `get_friend_list` | Fetches friend list. |
| `get_friends_with_category` | `get_friends_with_category` | `get_friends_with_category` | - | Fetches friend list grouped by category. |
| `set_friend_add_request` | `set_friend_add_request` | `set_friend_add_request` | `set_friend_add_request` | Handles friend add requests. |
| `set_friend_remark` | `set_friend_remark` | `set_friend_remark` | - | Sets a friend remark. |
| `delete_friend` | `delete_friend` | `delete_friend` | `delete_friend` | Deletes a friend. |
| `upload_private_file` | `upload_private_file` | `upload_private_file` | `upload_private_file` | Uploads a private-chat file. |
| `get_private_file_url` | `get_private_file_url` | `get_private_file_url` | `get_private_file_url` | Gets a private file download URL. |
| `get_profile_like` | `get_profile_like` | `get_profile_like` | - | Fetches profile-like data. |
| `get_profile_like_me` | - | `get_profile_like_me` | - | Fetches users who liked the bot account profile. |
| `get_qq_avatar` | - | `get_qq_avatar` | - | Gets a QQ user/group avatar URL. |
| `set_qq_avatar` | `set_qq_avatar` | `set_qq_avatar` | `set_qq_avatar` | Sets the bot account avatar. |
