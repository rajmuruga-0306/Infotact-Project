-- Atomic refresh token rotation with tripwire reuse detection
-- KEYS[1]: refresh_token:<oldTokenHash>
-- KEYS[2]: rotated_token:<oldTokenHash>
-- KEYS[3]: refresh_token:<newTokenHash>
-- ARGV[1]: oldTokenHash
-- ARGV[2]: newTokenHash
-- ARGV[3]: newTokenDataJson
-- ARGV[4]: refreshTokenTTL (seconds, e.g. 604800)
-- ARGV[5]: rotatedMarkerTTL (seconds, e.g. 300)
-- ARGV[6]: accessRevokeTTL (seconds, e.g. 900)

-- 1. Check if token was already rotated (TRIPWIRE REUSE DETECTION)
local rotatedFamily = redis.call('GET', KEYS[2])
if rotatedFamily then
    -- Token was previously rotated and is now being reused!
    -- Revoke the entire token family immediately and blacklist its access tokens
    local familyKey = 'refresh_family:' .. rotatedFamily
    local allTokens = redis.call('SMEMBERS', familyKey)
    for _, tHash in ipairs(allTokens) do
        redis.call('DEL', 'refresh_token:' .. tHash)
    end
    redis.call('DEL', familyKey)
    redis.call('SET', 'revoked_family:' .. rotatedFamily, '1', 'EX', tonumber(ARGV[6]))
    return { 'REUSE_DETECTED', rotatedFamily }
end

-- 2. Check if active token exists
local data = redis.call('GET', KEYS[1])
if not data then
    return { 'INVALID_TOKEN' }
end

-- 3. Parse familyId from JSON data
local cjson = cjson.decode(data)
local familyId = cjson.familyId
local familyKey = 'refresh_family:' .. familyId

-- 4. Rotate token atomically
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], familyId, 'EX', tonumber(ARGV[5]))
redis.call('SET', KEYS[3], ARGV[3], 'EX', tonumber(ARGV[4]))
redis.call('SREM', familyKey, ARGV[1])
redis.call('SADD', familyKey, ARGV[2])
redis.call('EXPIRE', familyKey, tonumber(ARGV[4]))

return { 'OK', data }
