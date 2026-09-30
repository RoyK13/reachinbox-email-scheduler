/**
 * Atomically reserves the next send slot for one (tenant, sender).
 *
 * Redis runs a Lua script as a single atomic operation, so any number of
 * concurrent workers / processes / hosts calling this get distinct slots:
 *   - consecutive slots are at least `delay` ms apart (minimum delay), and
 *   - no hourly window ever gets more than `limit` reservations
 *     (check and increment happen together — no overshoot).
 *
 * KEYS[1]  slot key   – "email-slot:<senderId>" holds the next free send time (epoch ms)
 * KEYS[2]  rate prefix – "email-rate:<userId>:<senderId>:"; the UTC hour label is appended
 * ARGV[1]  now (epoch ms)
 * ARGV[2]  minimum delay between sends (ms)
 * ARGV[3]  hourly limit
 * ARGV[4]  max hour windows to look ahead when the current one is full
 * ARGV[5]  tolerance (ms): a slot within now+tolerance counts as "send now"
 *
 * Returns { status, slotAt, window, hitWindow, count }
 *   status = ALLOWED | DELAYED | RATE_LIMITED
 *
 * Note: rate keys are derived inside the script from the hour window, which is
 * fine on a single Redis node (this project's topology) but not Redis Cluster.
 */
export const RESERVE_SEND_SLOT_LUA = `
local HOUR = 3600000
local now = tonumber(ARGV[1])
local delay = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local maxAhead = tonumber(ARGV[4])
local tolerance = tonumber(ARGV[5])

-- Howard Hinnant's civil_from_days: days since 1970-01-01 -> y, m, d (UTC)
local function civil(days)
  days = days + 719468
  local era = math.floor(days / 146097)
  local doe = days - era * 146097
  local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365)
  local y = yoe + era * 400
  local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100))
  local mp = math.floor((5 * doy + 2) / 153)
  local d = doy - math.floor((153 * mp + 2) / 5) + 1
  local m
  if mp < 10 then m = mp + 3 else m = mp - 9 end
  if m <= 2 then y = y + 1 end
  return y, m, d
end

local function hourLabel(h)
  local days = math.floor(h / 24)
  local hh = h - days * 24
  local y, m, d = civil(days)
  return string.format('%04d-%02d-%02dT%02d', y, m, d, hh)
end

local function countFor(h)
  return tonumber(redis.call('GET', KEYS[2] .. hourLabel(h)) or '0')
end

-- 1. Earliest time this sender may send: respects the minimum delay.
local t = math.max(now, tonumber(redis.call('GET', KEYS[1]) or '0'))
local h = math.floor(t / HOUR)

-- 2. Hourly limit: if the window is full, walk forward to the first window with capacity.
local hitWindow = false
local steps = 0
while countFor(h) >= limit do
  if not hitWindow then hitWindow = hourLabel(h) end
  h = h + 1
  steps = steps + 1
  if steps > maxAhead then
    return redis.error_reply('RATE_LIMIT_HORIZON_EXCEEDED')
  end
end
if hitWindow then
  t = math.max(t, h * HOUR)
end

-- 3. Reserve: bump the hourly counter and push the sender's next free slot.
local window = hourLabel(h)
local countKey = KEYS[2] .. window
local count = redis.call('INCR', countKey)
redis.call('PEXPIREAT', countKey, string.format('%d', (h + 2) * HOUR))

local nextFree = t + delay
redis.call('SET', KEYS[1], string.format('%d', nextFree), 'PX', string.format('%d', math.max(nextFree - now, 0) + HOUR))

local status
if hitWindow then
  status = 'RATE_LIMITED'
elseif t <= now + tolerance then
  status = 'ALLOWED'
else
  status = 'DELAYED'
end

return { status, string.format('%d', t), window, hitWindow or '', count }
`;
