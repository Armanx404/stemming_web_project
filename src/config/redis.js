import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, {
  tls: {},
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: () => null
});

redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("error", (err) => {
  console.log("❌ Redis error:", err.message);
});

export default redis;