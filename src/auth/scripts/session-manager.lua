-- I do NOT use the KEYS array because I don't use Redis cluster currently.
-- In the future if I use cluster, I'll use key{session} to let ALL session related keys to be put to the same slot.

-- We use a auto increment ID as session's ID.
local REDIS_KEY_USER_SESSION_ID_AUTO_INCREMENT = "user-session-auto-increment"

-- We manage a user's session list with a ZSET.
-- The score of a item is that session's timestamp.
-- The member of a item is that session's ID.
-- Whenever a session is accessed, the timestamp will be refreshed to the current time.
-- A user can only have one session. When a new session is created, all old sessions are revoked atomically.
local REDIS_KEY_USER_SESSION_LIST = "user-session-list:%d";

-- Session info uses an individual key so Redis can remove it automatically at the session expiration time.
local REDIS_KEY_USER_SESSION_INFO = "user-session-info:%s";

-- Sessions created by older versions used this hash. It is only retained so the upgrade can clean them up.
local REDIS_KEY_LEGACY_USER_SESSION_INFO_MAP = "user-session-info-map";

-- We track each user's most recent activity time globally for recent-active-user queries.
local REDIS_KEY_ACTIVE_USER_LIST = "active-user-list";
local ACTIVE_USER_RETENTION = 30 * 24 * 60 * 60 * 1000;

local function touch_active_user(timestamp, user_id)
  redis.call("zadd", REDIS_KEY_ACTIVE_USER_LIST, timestamp, user_id)
  redis.call("zremrangebyscore", REDIS_KEY_ACTIVE_USER_LIST, "-inf", tonumber(timestamp) - ACTIVE_USER_RETENTION)
end

local function get_session_info_key(session_id)
  return string.format(REDIS_KEY_USER_SESSION_INFO, session_id)
end

local function get_session_info(session_id)
  return redis.call("get", get_session_info_key(session_id)) or
    redis.call("hget", REDIS_KEY_LEGACY_USER_SESSION_INFO_MAP, session_id)
end

local function delete_session_info(session_id)
  redis.call("del", get_session_info_key(session_id))
  redis.call("hdel", REDIS_KEY_LEGACY_USER_SESSION_INFO_MAP, session_id)
end

local function session_is_unexpired(session_info, timestamp)
  if session_info == false then
    return false
  end

  local decode_success, decoded_session_info = pcall(cjson.decode, session_info)
  if not decode_success or type(decoded_session_info) ~= "table" then
    return false
  end

  local expires_at = tonumber(decoded_session_info.expiresAt)
  return expires_at ~= nil and tonumber(timestamp) < expires_at
end

-- Delete a session manually (when user logs out or its expiration is detected)
-- Returns success or not
local function revoke_session(user_id, session_id)
  local session_list_key = string.format(REDIS_KEY_USER_SESSION_LIST, user_id)

  -- To prevent a user from revoking a session ID not owned by itself, first check its session list.
  if redis.call("zrem", session_list_key, session_id) == 1 then
    delete_session_info(session_id)
    return true
  end

  return false
end

-- Create a new session (when the user logged in or registered and so on)
-- The session info is immutable for a session
-- Returns the new session ID
local function new_session(timestamp, expires_at, user_id, session_info)
  local session_list_key = string.format(REDIS_KEY_USER_SESSION_LIST, user_id)

  -- Revoke every old session before creating the new one. The entire script is atomic, so the newest login wins.
  local old_session_ids = redis.call("zrange", session_list_key, 0, -1)
  for _, old_session_id in ipairs(old_session_ids) do
    delete_session_info(old_session_id)
  end
  redis.call("del", session_list_key)

  local session_id = redis.call("incr", REDIS_KEY_USER_SESSION_ID_AUTO_INCREMENT)
  local session_info_key = get_session_info_key(session_id)
  redis.call("set", session_info_key, session_info)
  redis.call("pexpireat", session_info_key, expires_at)

  -- Add new session's item to user's session list
  redis.call("zadd", session_list_key, timestamp, session_id)
  redis.call("pexpireat", session_list_key, expires_at)
  touch_active_user(timestamp, user_id)

  return session_id
end

-- Access a existing session
-- The session's timestamp will be refreshed
-- Returns true if the session is valid, false if the session has been deleted
local function access_session(timestamp, user_id, session_id)
  local session_list_key = string.format(REDIS_KEY_USER_SESSION_LIST, user_id)
  if redis.call("zscore", session_list_key, session_id) == false then
    -- The list may have expired automatically. Remove any remaining legacy session info as well.
    delete_session_info(session_id)
    return false
  end

  if not session_is_unexpired(get_session_info(session_id), timestamp) then
    revoke_session(user_id, session_id)
    return false
  end

  redis.call("zadd", session_list_key, "XX", timestamp, session_id)
  touch_active_user(timestamp, user_id)
  return true
end

-- Delete a user's ALL sessions except one
-- Returns nothing
local function revoke_all_sessions_except(user_id, except_session_id)
  local session_list_key = string.format(REDIS_KEY_USER_SESSION_LIST, user_id)
  local session_ids = redis.call("zrange", session_list_key, 0, -1)
  for _, session_id in ipairs(session_ids) do
    if session_id ~= except_session_id then
      redis.call("zrem", session_list_key, session_id)
      delete_session_info(session_id)
    end
  end

  if redis.call("zcard", session_list_key) == 0 then
    redis.call("del", session_list_key)
  end
end

-- Get a list of sessions of a user
-- Returns a table of sessions, each is {session_id, timestamp, session_info}
local function list_sessions(current_timestamp, user_id)
  local result = {}

  local session_list_key = string.format(REDIS_KEY_USER_SESSION_LIST, user_id)
  local session_list = redis.call("zrange", session_list_key, 0, -1, "withscores")
  local session_count = #session_list / 2
  for i = 1, session_count do
    local session_id = session_list[i * 2 - 1]
    local last_access_timestamp = session_list[i * 2]
    local session_info = get_session_info(session_id)

    if session_is_unexpired(session_info, current_timestamp) then
      table.insert(result, {session_id, last_access_timestamp, session_info})
    else
      redis.call("zrem", session_list_key, session_id)
      delete_session_info(session_id)
    end
  end

  return result
end

-- Get a list of recently active users.
-- Returns a flat list of {user_id, last_access_time, user_id, last_access_time, ...}
local function list_active_users(since_timestamp, take_count)
  return redis.call(
    "zrevrangebyscore",
    REDIS_KEY_ACTIVE_USER_LIST,
    "+inf",
    since_timestamp,
    "withscores",
    "limit",
    0,
    take_count
  )
end

-- Handle commands from Redis client
if ARGV[1] == "new" then
  return new_session(ARGV[2], ARGV[3], ARGV[4], ARGV[5])
elseif ARGV[1] == "access" then
  return access_session(ARGV[2], ARGV[3], ARGV[4])
elseif ARGV[1] == "revoke" then
  return revoke_session(ARGV[2], ARGV[3])
elseif ARGV[1] == "revoke_all_except" then
  return revoke_all_sessions_except(ARGV[2], ARGV[3])
elseif ARGV[1] == "list" then
  return list_sessions(ARGV[2], ARGV[3])
elseif ARGV[1] == "list_active_users" then
  return list_active_users(ARGV[2], ARGV[3])
end
