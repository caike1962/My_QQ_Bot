# Full OneBot API Matrix

This document is a working matrix for mapping NapCat, LLOneBot, and Lagrange
APIs into a unified MCP tool surface.

It was generated from the public documentation indexes below, filtered to the
OneBot 11 API surface, and then grouped by best-effort capability names:

- NapCat: https://napcat.apifox.cn/llms.txt
- LLOneBot: https://api.luckylillia.com/llms.txt
- Lagrange.OneBot: https://lagrange-onebot.apifox.cn/llms.txt

The matrix is intentionally broad. A row means "these endpoints appear to serve
the same or closely related capability"; it does not guarantee that request or
response schemas are already compatible. Before exposing a row as an MCP tool,
check the linked platform docs and write adapter tests for parameter and return
shape differences.

Extracted coverage:

| Platform | Endpoint count |
| --- | ---: |
| NapCat | 169 |
| LLOneBot | 105 |
| Lagrange | 75 |
| Matrix rows | 197 |

Legend:

- `-` means no matching endpoint was found in the scanned docs.
- Milky and Satori APIs are intentionally excluded. This project only targets
  OneBot 11 plus platform-specific OneBot-style extensions.
- Leading-dot or underscore endpoints are kept as documented and should be
  treated as private/high-risk until manually reviewed.

## 消息与转发

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `ArkShareGroup` | 分享群 (Ark) | `/ArkShareGroup` | - | - |
| `ArkSharePeer` | 分享用户 (Ark) | `/ArkSharePeer` | - | - |
| `click_inline_keyboard_button` | 点击内联键盘按钮 | `/click_inline_keyboard_button` | - | - |
| `delete_essence_msg` | 移出精华消息<br>删除精华消息<br>删除群精华消息 | `/delete_essence_msg` | `/delete_essence_msg` | `/delete_essence_msg` |
| `fetch_ptt_text` | 获取语音转文字结果 | `/fetch_ptt_text` | - | - |
| `forward_friend_single_msg` | 转发单条消息<br>转发单条好友消息 | `/forward_friend_single_msg` | `/forward_friend_single_msg` | - |
| `forward_group_single_msg` | 转发单条消息<br>转发单条群消息 | `/forward_group_single_msg` | `/forward_group_single_msg` | - |
| `get_essence_msg_list` | 获取群精华消息<br>获取精华消息列表 | `/get_essence_msg_list` | `/get_essence_msg_list` | `/get_essence_msg_list` |
| `get_forward_msg` | 获取合并转发消息<br>获取转发消息详情 | `/get_forward_msg` | `/get_forward_msg` | `/get_forward_msg` |
| `get_group_system_msg` | 获取群系统消息 | `/get_group_system_msg` | `/get_group_system_msg` | - |
| `get_message` | 获取消息<br>获取消息详情 | `/get_msg` | `/get_msg` | `/get_msg` |
| `get_online_file_msg` | 获取在线文件消息 | `/get_online_file_msg` | - | - |
| `get_private_message_history` | 获取好友历史消息<br>获取好友历史聊天记录<br>获取好友历史消息记录 | `/get_friend_msg_history` | `/get_friend_msg_history` | `/get_friend_msg_history` |
| `mark_all_as_read` | 标记所有消息已读 | `/_mark_all_as_read` | - | - |
| `mark_group_message_read` | 标记群聊已读 | `/mark_group_msg_as_read` | - | - |
| `mark_msg_as_read` | 标记消息已读 (Go-CQHTTP)<br>标记消息为已读<br>标记消息已读 | `/mark_msg_as_read` | `/mark_msg_as_read` | `/mark_msg_as_read` |
| `mark_private_message_read` | 标记私聊已读 | `/mark_private_msg_as_read` | - | - |
| `recall_message` | 撤回消息 | `/delete_msg` | `/delete_msg` | `/delete_msg` |
| `send_ark_share` | 分享用户 (Ark) | `/send_ark_share` | - | - |
| `send_flash_msg` | 发送闪传消息 | `/send_flash_msg` | - | - |
| `send_forward_msg` | 发送合并转发消息<br>构造合并转发消息 | `/send_forward_msg` | - | `/send_forward_msg` |
| `send_group_ai_record` | 发送群 AI 语音<br>发送群 Ai 语音 | `/send_group_ai_record` | `/send_group_ai_record` | `/send_group_ai_record` |
| `send_group_ark_share` | 分享群 (Ark) | `/send_group_ark_share` | - | - |
| `send_group_bot_callback` | 调用群机器人回调 | - | - | `/send_group_bot_callback` |
| `send_group_forward_msg` | 发送群合并转发消息<br>发送群聊合并转发消息 | `/send_group_forward_msg` | `/send_group_forward_msg` | `/send_group_forward_msg` |
| `send_group_message` | 发送群消息<br>发送群聊文本消息<br>发送群聊回复消息 | `/send_group_msg` | `/send_group_msg` | `/send_group_msg` |
| `send_group_notice` | 发送群公告 | `/_send_group_notice` | `/_send_group_notice` | `/_send_group_notice` |
| `send_group_sign` | 群打卡 | `/send_group_sign` | `/send_group_sign` | - |
| `send_like` | 点赞<br>个人资料点赞 | `/send_like` | `/send_like` | `/send_like` |
| `send_message` | 发送消息 | `/send_msg` | - | `/send_msg` |
| `send_online_file` | 发送在线文件 | `/send_online_file` | - | - |
| `send_online_folder` | 发送在线文件夹 | `/send_online_folder` | - | - |
| `send_poke` | 发送戳一戳<br>发送戳一戳（双击头像） | `/send_poke` | `/send_poke` | - |
| `send_private_forward_msg` | 发送私聊合并转发消息 | `/send_private_forward_msg` | `/send_private_forward_msg` | `/send_private_forward_msg` |
| `send_private_message` | 发送私聊消息<br>发送私聊文本消息<br>发送私聊回复消息 | `/send_private_msg` | `/send_private_msg` | `/send_private_msg` |
| `set_essence_msg` | 设置精华消息<br>设置群精华消息 | `/set_essence_msg` | `/set_essence_msg` | `/set_essence_msg` |
| `set_group_msg_mask` | 设置群消息接收方式 | - | `/set_group_msg_mask` | - |
| `voice_msg_to_text` | 语音消息转文字 | - | `/voice_msg_to_text` | - |

## 群组与群管理

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `.join_group_emoji_chain` | 加入群聊表情接龙 | - | - | `/.join_group_emoji_chain` |
| `batch_delete_group_member` | 批量踢出群成员 | - | `/batch_delete_group_member` | - |
| `cancel_group_album_media_like` | 取消点赞群相册媒体 | `/cancel_group_album_media_like` | - | - |
| `cancel_group_todo` | 取消群待办 | `/cancel_group_todo` | - | - |
| `complete_group_todo` | 完成群待办 | `/complete_group_todo` | - | - |
| `create_group_album` | 创建群相册 | - | `/create_group_album` | - |
| `create_group_file_folder` | 创建群文件目录<br>创建群文件文件夹 | `/create_group_file_folder` | `/create_group_file_folder` | `/create_group_file_folder` |
| `del_group_album_media` | 删除群相册媒体 | `/del_group_album_media` | - | - |
| `del_group_notice` | 删除群公告 | `/_del_group_notice` | - | `/_del_group_notice` |
| `delete_group_album` | 删除群相册 | - | `/delete_group_album` | - |
| `delete_group_file` | 删除群文件 | `/delete_group_file` | `/delete_group_file` | `/delete_group_file` |
| `delete_group_file_folder` | 删除群文件文件夹 | - | - | `/delete_group_file_folder` |
| `delete_group_folder` | 删除群文件目录<br>删除群文件文件夹 | `/delete_group_folder` | `/delete_group_folder` | - |
| `delete_group_notice` | 删除群公告 | - | `/_delete_group_notice` | - |
| `do_group_album_comment` | 发表群相册评论 | `/do_group_album_comment` | - | - |
| `get_group_album_list` | 获取群相册列表 | - | `/get_group_album_list` | - |
| `get_group_album_media_list` | 获取群相册媒体列表 | `/get_group_album_media_list` | `/get_group_album_media_list` | - |
| `get_group_at_all_remain` | 获取群艾特全体剩余次数<br>获取群 @全体成员 剩余次数 | `/get_group_at_all_remain` | `/get_group_at_all_remain` | - |
| `get_group_detail_info` | 获取群详细信息 | `/get_group_detail_info` | - | - |
| `get_group_file_system_info` | 获取群文件系统信息 | `/get_group_file_system_info` | `/get_group_file_system_info` | - |
| `get_group_file_url` | 获取群文件URL<br>获取群文件资源链接 | `/get_group_file_url` | `/get_group_file_url` | `/get_group_file_url` |
| `get_group_files_by_folder` | 获取群文件夹文件列表<br>获取群子目录文件列表 | `/get_group_files_by_folder` | `/get_group_files_by_folder` | `/get_group_files_by_folder` |
| `get_group_honor_info` | 获取群荣誉信息<br>获取群荣耀<br>群荣誉 | `/get_group_honor_info` | `/get_group_honor_info` | `/get_group_honor_info` |
| `get_group_ignore_add_request` | 获取群被忽略的加群请求<br>获取已过滤的加群通知 | `/get_group_ignore_add_request` | `/get_group_ignore_add_request` | - |
| `get_group_ignored_notifies` | 获取群忽略通知 | `/get_group_ignored_notifies` | - | - |
| `get_group_info` | 获取群信息 | `/get_group_info` | `/get_group_info` | `/get_group_info` |
| `get_group_info_ex` | 获取群详细信息 (扩展) | `/get_group_info_ex` | - | - |
| `get_group_list` | 获取群列表 | `/get_group_list` | `/get_group_list` | `/get_group_list` |
| `get_group_member_info` | 获取群成员信息 | `/get_group_member_info` | `/get_group_member_info` | `/get_group_member_info` |
| `get_group_member_list` | 获取群成员列表 | `/get_group_member_list` | `/get_group_member_list` | `/get_group_member_list` |
| `get_group_message_history` | 获取群历史消息<br>获取群历史聊天记录 | `/get_group_msg_history` | `/get_group_msg_history` | `/get_group_msg_history` |
| `get_group_notice` | 获取群公告 | `/_get_group_notice` | `/_get_group_notice` | `/_get_group_notice` |
| `get_group_root_files` | 获取群根目录文件列表 | `/get_group_root_files` | `/get_group_root_files` | `/get_group_root_files` |
| `get_group_shut_list` | 获取群禁言列表<br>获取被禁言群员列表 | `/get_group_shut_list` | `/get_group_shut_list` | - |
| `get_group_signed_list` | 获取群组今日打卡列表 | `/get_group_signed_list` | - | - |
| `get_qun_album_list` | 获取群相册列表 | `/get_qun_album_list` | - | - |
| `group_poke` | 发送戳一戳<br>群里戳一戳<br>群员戳一戳（双击头像） | `/group_poke` | `/group_poke` | `/group_poke` |
| `move_group_file` | 移动群文件 | `/move_group_file` | `/move_group_file` | `/move_group_file` |
| `rename_group_file` | 重命名群文件<br>重命名群文件名 | `/rename_group_file` | `/rename_group_file` | - |
| `rename_group_file_folder` | 重命名群文件文件夹名 | - | `/rename_group_file_folder` | `/rename_group_file_folder` |
| `set_group_add_option` | 设置群加群选项 | `/set_group_add_option` | - | - |
| `set_group_add_request` | 处理加群请求<br>处理加群请求／邀请 | `/set_group_add_request` | `/set_group_add_request` | `/set_group_add_request` |
| `set_group_admin` | 设置群管理员 | `/set_group_admin` | `/set_group_admin` | `/set_group_admin` |
| `set_group_album_media_like` | 点赞群相册媒体 | `/set_group_album_media_like` | - | - |
| `set_group_ban` | 群组禁言<br>设置群禁言<br>群禁言 | `/set_group_ban` | `/set_group_ban` | `/set_group_ban` |
| `set_group_bot_status` | 设置群Bot发言状态 | - | - | `/set_group_bot_status` |
| `set_group_card` | 设置群名片 | `/set_group_card` | `/set_group_card` | `/set_group_card` |
| `set_group_file_forever` | 群文件转永久 | - | `/set_group_file_forever` | - |
| `set_group_kick` | 群组踢人<br>踢出群成员<br>群踢人 | `/set_group_kick` | `/set_group_kick` | `/set_group_kick` |
| `set_group_kick_members` | 批量踢出群成员 | `/set_group_kick_members` | - | - |
| `set_group_leave` | 退出群组<br>退群 | `/set_group_leave` | `/set_group_leave` | `/set_group_leave` |
| `set_group_name` | 设置群名称<br>设置群名 | `/set_group_name` | `/set_group_name` | `/set_group_name` |
| `set_group_portrait` | 设置群头像 | `/set_group_portrait` | `/set_group_portrait` | `/set_group_portrait` |
| `set_group_reaction` | 设置消息表情点赞<br>表情回复操作<br>表情回应消息 | `/set_msg_emoji_like` | `/set_msg_emoji_like` | `/set_group_reaction` |
| `set_group_remark` | 设置群备注 | `/set_group_remark` | `/set_group_remark` | - |
| `set_group_robot_add_option` | 设置群机器人加群选项 | `/set_group_robot_add_option` | - | - |
| `set_group_search` | 设置群搜索选项 | `/set_group_search` | - | - |
| `set_group_sign` | 群打卡 | `/set_group_sign` | - | - |
| `set_group_special_title` | 设置专属头衔<br>设置群组专属头衔<br>设置群头衔 | `/set_group_special_title` | `/set_group_special_title` | `/set_group_special_title` |
| `set_group_todo` | 设置群待办 | `/set_group_todo` | - | - |
| `set_group_whole_ban` | 全员禁言<br>设置群全体禁言<br>群全体禁言 | `/set_group_whole_ban` | `/set_group_whole_ban` | `/set_group_whole_ban` |
| `trans_group_file` | 传输群文件 | `/trans_group_file` | - | - |
| `upload_group_album` | 上传群相册 | - | `/upload_group_album` | - |
| `upload_group_file` | 上传群文件 | `/upload_group_file` | `/upload_group_file` | `/upload_group_file` |

## 用户与好友

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `.join_friend_emoji_chain` | 加入好友表情接龙 | - | - | `/.join_friend_emoji_chain` |
| `delete_friend` | 删除好友 | `/delete_friend` | `/delete_friend` | `/delete_friend` |
| `fetch_emoji_like` | 获取表情点赞详情 | `/fetch_emoji_like` | - | - |
| `friend_poke` | 发送戳一戳<br>私聊戳一戳<br>好友戳一戳（双击头像） | `/friend_poke` | `/friend_poke` | `/friend_poke` |
| `get_doubt_friends_add_request` | 获取可疑好友申请<br>获取被过滤好友请求 | `/get_doubt_friends_add_request` | `/get_doubt_friends_add_request` | - |
| `get_emoji_likes` | 获取消息表情点赞列表 | `/get_emoji_likes` | - | - |
| `get_friend_list` | 获取好友列表<br>好友列表 | `/get_friend_list` | `/get_friend_list` | `/get_friend_list` |
| `get_friends_with_category` | 获取带分组的好友列表<br>好友列表（带分组） | `/get_friends_with_category` | `/get_friends_with_category` | - |
| `get_guild_service_profile` | 获取频道个人信息 | `/get_guild_service_profile` | - | - |
| `get_profile_like` | 获取资料点赞<br>获取我赞过谁列表 | `/get_profile_like` | `/get_profile_like` | - |
| `get_profile_like_me` | 获取谁赞过我列表 | - | `/get_profile_like_me` | - |
| `get_qq_avatar` | 获取QQ或QQ群头像 | - | `/get_qq_avatar` | - |
| `get_recent_contact` | 获取最近会话 | `/get_recent_contact` | - | - |
| `get_stranger_info` | 获取陌生人信息 | `/get_stranger_info` | `/get_stranger_info` | `/get_stranger_info` |
| `get_unidirectional_friend_list` | 获取单向好友列表 | `/get_unidirectional_friend_list` | - | - |
| `set_doubt_friends_add_request` | 处理可疑好友申请<br>处理被过滤好友请求 | `/set_doubt_friends_add_request` | `/set_doubt_friends_add_request` | - |
| `set_friend_add_request` | 处理加好友请求<br>处理好友申请 | `/set_friend_add_request` | `/set_friend_add_request` | `/set_friend_add_request` |
| `set_friend_category` | 移动好友分组 | - | `/set_friend_category` | - |
| `set_friend_remark` | 设置好友备注 | `/set_friend_remark` | `/set_friend_remark` | - |
| `set_qq_avatar` | 设置QQ头像<br>设置个人头像 | `/set_qq_avatar` | `/set_qq_avatar` | `/set_qq_avatar` |
| `set_qq_profile` | 设置QQ资料<br>设置登录号资料 | `/set_qq_profile` | `/set_qq_profile` | - |

## 文件与媒体资源

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `can_send_image` | 是否可以发送图片<br>检查是否可以发送图片 | `/can_send_image` | - | `/can_send_image` |
| `can_send_record` | 是否可以发送语音<br>检查是否可以发送语音 | `/can_send_record` | - | `/can_send_record` |
| `cancel_online_file` | 取消在线文件 | `/cancel_online_file` | - | - |
| `create_flash_task` | 创建闪传任务 | `/create_flash_task` | - | - |
| `download_file` | 下载文件<br>下载文件到缓存目录 | `/download_file` | `/download_file` | - |
| `download_fileset` | 下载文件集 | `/download_fileset` | - | - |
| `download_flash_file` | 下载闪传文件 | - | `/download_flash_file` | - |
| `get_ai_record` | 获取 AI 语音<br>获取群 Ai 语音 | `/get_ai_record` | - | `/get_ai_record` |
| `get_file` | 获取文件<br>获取消息文件详情 | `/get_file` | `/get_file` | - |
| `get_fileset_id` | 获取文件集 ID | `/get_fileset_id` | - | - |
| `get_fileset_info` | 获取文件集信息 | `/get_fileset_info` | - | - |
| `get_flash_file_info` | 获取闪传文件详情 | - | `/get_flash_file_info` | - |
| `get_flash_file_list` | 获取闪传文件列表 | `/get_flash_file_list` | - | - |
| `get_flash_file_url` | 获取闪传文件链接 | `/get_flash_file_url` | - | - |
| `get_image` | 获取图片<br>获取消息图片详情 | `/get_image` | `/get_image` | - |
| `get_private_file_url` | 获取私聊文件URL<br>获取私聊文件资源链接 | `/get_private_file_url` | `/get_private_file_url` | `/get_private_file_url` |
| `get_record` | 获取语音<br>获取消息语音详情 | `/get_record` | `/get_record` | - |
| `get_share_link` | 获取文件分享链接 | `/get_share_link` | - | - |
| `ocr_image` | 图片 OCR 识别<br>OCR图像识别<br>图片 OCR | `/ocr_image` | `/ocr_image` | `/ocr_image` |
| `receive_online_file` | 接收在线文件 | `/receive_online_file` | - | - |
| `refuse_online_file` | 拒绝在线文件 | `/refuse_online_file` | - | - |
| `reshare_flash_file` | 重新分享闪传文件 | - | `/reshare_flash_file` | - |
| `upload_flash_file` | 上传闪传文件 | - | `/upload_flash_file` | - |
| `upload_image` | 上传图片 | - | - | `/upload_image` |
| `upload_image_to_qun_album` | 上传图片到群相册 | `/upload_image_to_qun_album` | - | - |
| `upload_private_file` | 上传私聊文件 | `/upload_private_file` | `/upload_private_file` | `/upload_private_file` |

## 媒体增强与 AI

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `fetch_custom_face_detail` | 获取自定义表情详情 | `/fetch_custom_face_detail` | - | - |
| `get_ai_characters` | 获取AI角色列表<br>获取群 Ai 语音可用声色列表 | `/get_ai_characters` | `/get_ai_characters` | `/get_ai_characters` |
| `get_mini_app_ark` | 获取小程序 Ark | `/get_mini_app_ark` | - | - |
| `get_music_ark` | 获取音乐卡片 Json | - | - | `/get_music_ark` |
| `translate_en2zh` | 英文单词翻译 | `/translate_en2zh` | - | - |

## 系统、登录与凭证

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `add_custom_face` | 添加自定义表情 | `/add_custom_face` | - | - |
| `bot_exit` | 退出登录 | `/bot_exit` | - | - |
| `clean_cache` | 清理缓存 | `/clean_cache` | `/clean_cache` | - |
| `delete_custom_face` | 删除自定义表情 | `/delete_custom_face` | - | - |
| `fetch_custom_face` | 获取自定义表情<br>获取自定义Face<br>获取收藏表情 | `/fetch_custom_face` | `/fetch_custom_face` | `/fetch_custom_face` |
| `get_clientkey` | 获取ClientKey | `/get_clientkey` | - | - |
| `get_collection_list` | 获取收藏列表 | `/get_collection_list` | - | - |
| `get_cookies` | 获取 Cookies<br>获取cookies | `/get_cookies` | `/get_cookies` | `/get_cookies` |
| `get_credentials` | 获取登录凭证<br>获取 QQ 相关接口凭证 | `/get_credentials` | - | `/get_credentials` |
| `get_csrf_token` | 获取 CSRF Token | `/get_csrf_token` | - | `/get_csrf_token` |
| `get_login_info` | 获取登录号信息<br>获取登陆信息<br>获取登录号信息 Copy | `/get_login_info` | `/get_login_info` | `/get_login_info` |
| `get_online_clients` | 获取在线客户端 | `/get_online_clients` | - | - |
| `get_recommend_face` | 获取推荐表情 | - | `/get_recommend_face` | - |
| `get_rkey` | 获取扩展 RKey<br>获取rkey<br>获取图片rkey | `/get_rkey` | `/get_rkey` | `/get_rkey` |
| `get_rkey_server` | 获取 RKey 服务器 | `/get_rkey_server` | - | - |
| `get_robot_uin_range` | 获取机器人 UIN 范围<br>获取官方机器人QQ号范围 | `/get_robot_uin_range` | `/get_robot_uin_range` | - |
| `get_status` | 获取运行状态<br>获取状态<br>bot状态 | `/get_status` | `/get_status` | `/get_status` |
| `get_version_info` | 获取版本信息 | `/get_version_info` | `/get_version_info` | `/get_version_info` |
| `nc_get_rkey` | 获取 RKey | `/nc_get_rkey` | - | - |
| `nc_get_user_status` | 获取用户在线状态 | `/nc_get_user_status` | - | - |
| `scan_qrcode` | 扫描二维码 | - | `/scan_qrcode` | - |
| `set_custom_face_desc` | 修改自定义表情描述 | `/set_custom_face_desc` | - | - |
| `set_diy_online_status` | 设置自定义在线状态 | `/set_diy_online_status` | - | - |
| `set_input_status` | 设置输入状态 | `/set_input_status` | `/set_input_status` | - |
| `set_online_status` | 设置在线状态 | `/set_online_status` | `/set_online_status` | - |
| `set_restart` | 重启服务<br>重启Lagrange.OneBot<br>重启 | `/set_restart` | `/set_restart` | `/set_restart` |
| `set_self_longnick` | 设置个性签名 | `/set_self_longnick` | - | - |

## 频道

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `get_guild_list` | 获取频道列表 | `/get_guild_list` | - | - |

## 流式传输

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `clean_stream_temp_file` | 清理流式传输临时文件 | `/clean_stream_temp_file` | - | - |
| `download_file_image_stream` | 下载图片文件流 | `/download_file_image_stream` | - | - |
| `download_file_record_stream` | 下载语音文件流 | `/download_file_record_stream` | - | - |
| `download_file_stream` | 下载文件流 | `/download_file_stream` | - | - |
| `test_download_stream` | 测试下载流 | `/test_download_stream` | - | - |
| `upload_file_stream` | 上传文件流 | `/upload_file_stream` | - | - |

## 底层与高风险接口

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `nc_get_packet_status` | 获取Packet状态 | `/nc_get_packet_status` | - | - |
| `send_packet` | 发送原始数据包 | `/send_packet` | - | - |
| `send_pb` | 发送Protobuf数据包 | - | `/send_pb` | - |

## 其他

| Capability | Human-facing names | NapCat | LLOneBot | Lagrange |
| --- | --- | --- | --- | --- |
| `.handle_quick_operation` | 处理快速操作 | `/.handle_quick_operation` | - | - |
| `check_url_safely` | 检查URL安全性 | `/check_url_safely` | - | - |
| `create_collection` | 创建收藏 | `/create_collection` | - | - |
| `fetch_mface_key` | 获取mface key | - | - | `/fetch_mface_key` |
| `get_model_show` | 获取机型显示 | `/_get_model_show` | - | - |
| `set_model_show` | 设置机型 | `/_set_model_show` | - | - |
