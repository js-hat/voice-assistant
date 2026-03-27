import 'dotenv/config';

const required = ['OPENAI_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env variable: ${key}`);
    process.exit(1);
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  openaiApiKey: process.env.OPENAI_API_KEY,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '30', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  // OpenAI Realtime defaults
  model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini',
  voice: process.env.OPENAI_VOICE || 'marin',
  instructions: process.env.ASSISTANT_INSTRUCTIONS || `Ты — голосовой мост. Твоя единственная задача — вызывать инструменты. СТРОГО ЗАПРЕЩЕНО: отвечать текстом, перефразировать, дополнять, переводить, интерпретировать. Когда пользователь говорит что-либо — вызови run_claude и передай его слова ДОСЛОВНО в параметре "prompt". Копируй речь пользователя один-к-одному, без изменений. Один вызов на одно сообщение — никогда не вызывай run_claude дважды подряд.`,
};
