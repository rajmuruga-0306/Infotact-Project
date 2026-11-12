-- KEYS[1]: refresh_family:<familyId>
-- KEYS[2]: revoked_family:<familyId>
-- ARGV[1]: tokenPrefix (e.g. "refresh_token:")
-- ARGV[2]: revokeTTL in seconds (e.g. 900)
local familyKey = KEYS[1]
local revokedKey = KEYS[2]
local tokenPrefix = ARGV[1]
local ttl = tonumber(ARGV[2])

-- 1. Retrieve all active token hashes in this family
local tokens = redis.call('SMEMBERS', familyKey)

-- 2. Atomically delete every active refresh token record
for _, tokenHash in ipairs(tokens) do
    redis.call('DEL', tokenPrefix .. tokenHash)
end

-- 3. Delete the family set itself
redis.call('DEL', familyKey)

-- 4. Set the immediate access token revocation marker
redis.call('SET', revokedKey, '1', 'EX', ttl)

return 1
