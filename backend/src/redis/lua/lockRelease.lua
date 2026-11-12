-- KEYS[1]: lock key (e.g. lock:txn:org_123:idem_abc)
-- ARGV[1]: expected lock token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
