-- KEYS[1]: lock key (e.g. lock:txn:org_123:idem_abc)
-- ARGV[1]: expected lock token
-- ARGV[2]: renewal ttl in milliseconds
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
