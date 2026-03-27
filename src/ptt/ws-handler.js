import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getToolDefinitions, executeTool } from '../shared/tools.js';

const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${config.model}`;

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (browserWs) => {
    logger.info('PTT client connected');

    const openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    let alive = true;
    const pingInterval = setInterval(() => {
      if (browserWs.readyState === WebSocket.OPEN) browserWs.ping();
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.ping();
    }, 30_000);

    function cleanup() {
      if (!alive) return;
      alive = false;
      clearInterval(pingInterval);
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
      if (browserWs.readyState === WebSocket.OPEN) browserWs.close();
      logger.info('PTT session cleaned up');
    }

    openaiWs.on('open', () => {
      logger.info('OpenAI WebSocket connected (PTT mode)');

      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text'],
          instructions: config.instructions,
          tools: getToolDefinitions(),
          tool_choice: 'required',
          temperature: 0.6,
          input_audio_format: 'pcm16',
          input_audio_transcription: { model: 'gpt-4o-transcribe' },
          turn_detection: null, // PTT: no VAD, client controls turns
        },
      }));
    });

    openaiWs.on('message', async (data) => {
      const raw = data.toString();
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      switch (event.type) {
        case 'response.function_call_arguments.done': {
          const { call_id, name, arguments: args } = event;
          logger.info({ name }, 'Tool call received');
          safeSend(browserWs, raw);

          let result;
          try {
            const parsed = typeof args === 'string' ? JSON.parse(args) : args;
            result = await executeTool(name, parsed);
          } catch (err) {
            result = { error: err.message };
          }

          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id,
              output: JSON.stringify(result),
            },
          }));

          if (!result.silent) {
            openaiWs.send(JSON.stringify({
              type: 'response.create',
              response: { modalities: ['text'] },
            }));
          }

          safeSend(browserWs, JSON.stringify({
            type: 'tool.result',
            name,
            result,
          }));
          break;
        }

        default: {
          const forwardTypes = [
            'session.created',
            'session.updated',
            'conversation.item.input_audio_transcription.completed',
            'response.text.delta',
            'response.text.done',
            'response.created',
            'response.done',
            'error',
          ];
          if (forwardTypes.includes(event.type)) {
            safeSend(browserWs, raw);
          }
          break;
        }
      }
    });

    browserWs.on('message', (data) => {
      const raw = data.toString();
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      const allowed = [
        'input_audio_buffer.append',
        'input_audio_buffer.commit',
        'response.create',
      ];

      if (!allowed.includes(event.type)) {
        logger.warn({ type: event.type }, 'Blocked PTT client event');
        return;
      }

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(raw);
      }
    });

    openaiWs.on('error', (err) => {
      logger.error({ err: err.message }, 'OpenAI WebSocket error');
      safeSend(browserWs, JSON.stringify({
        type: 'error',
        error: { message: 'OpenAI connection error' },
      }));
      cleanup();
    });

    openaiWs.on('close', () => {
      logger.info('OpenAI WebSocket closed');
      cleanup();
    });

    browserWs.on('close', () => {
      logger.info('PTT client disconnected');
      cleanup();
    });

    browserWs.on('error', (err) => {
      logger.error({ err: err.message }, 'PTT client error');
      cleanup();
    });
  });

  logger.info('PTT WebSocket handler attached on /ws');
}

function safeSend(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}