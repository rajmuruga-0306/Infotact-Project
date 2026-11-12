-- Self-cleaning atomic sliding-window rate limiter
-- KEYS[1]: rate limit key, e.g. "ratelimit:auth:192.168.1.1"
-- ARGV[1]: current timestamp in milliseconds
-- ARGV[2]: window size in milliseconds (e.g. 900000)
-- ARGV[3]: maximum allowed requests (e.g. 10)
-- ARGV[4]: unique request ID to embed directly and prevent separate sequence keys
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local requestId = ARGV[4] or tostring(now)
local clearBefore = now - window

-- 1. Remove entries older than the sliding window
redis.call('ZREMRANGEBYSCORE', key, '-inf', clearBefore)

-- 2. Count active entries in the current window
local count = redis.call('ZCARD', key)

if count < limit then
    -- 3. Add current request with timestamp as score and unique member
    redis.call('ZADD', key, now, now .. ':' .. requestId)
    redis.call('PEXPIRE', key, window)
    return { 1, limit - count - 1 } -- { allowed: 1, remaining: number }
else
    return { 0, 0 } -- { allowed: 0, remaining: 0 }
end
