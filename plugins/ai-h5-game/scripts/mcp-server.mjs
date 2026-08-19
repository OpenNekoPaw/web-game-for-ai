import { createInterface } from 'node:readline';

const baseUrl = (process.env.DDZ_SERVER_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

const tools = [
  {
    name: 'list_strategies',
    description: 'List editable Markdown strategies available for an agent seat.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_game',
    description: 'Create a local Dou Dizhu game. The H5 game service must already be running.',
    inputSchema: {
      type: 'object',
      properties: {
        turnTimeoutMs: {
          type: 'integer',
          minimum: 60000,
          maximum: 60000,
          description: 'Turn timeout is fixed at 60000 milliseconds (1 minute).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'create_rematch',
    description: 'Create an independent game with the same initial hands, bottom cards, and first bidder as a completed source game.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceGameId: { type: 'string', description: 'Completed source gameId to replay with new seats and strategies.' }
      },
      required: ['sourceGameId'],
      additionalProperties: false
    }
  },
  {
    name: 'create_competition',
    description: 'Create a 3, 5, or 7-round Dou Dizhu competition. The first gameId is returned for seat joins.',
    inputSchema: {
      type: 'object',
      properties: {
        totalRounds: { type: 'integer', enum: [3, 5, 7], description: 'Number of rounds; defaults to 3.' },
        turnTimeoutMs: { type: 'integer', minimum: 60000, maximum: 60000, description: 'Turn timeout is fixed at 60000 milliseconds (1 minute).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'observe_competition',
    description: 'Read competition scores, round state, and the requesting agent seat\'s private review context.',
    inputSchema: {
      type: 'object',
      properties: {
        competitionId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 }
      },
      required: ['competitionId', 'seatId'],
      additionalProperties: false
    }
  },
  {
    name: 'submit_competition_review',
    description: 'Submit a concise multi-round competition summary after all rounds finish.',
    inputSchema: {
      type: 'object',
      properties: {
        competitionId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 },
        review: {
          type: 'object',
          properties: {
            assessment: { type: 'string', minLength: 1, maxLength: 800 },
            recurringProblems: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 220 } },
            validatedImprovements: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 220 } },
            finalStrategySuggestions: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 260 } }
          },
          required: ['assessment', 'recurringProblems', 'validatedImprovements', 'finalStrategySuggestions'],
          additionalProperties: false
        }
      },
      required: ['competitionId', 'seatId', 'review'],
      additionalProperties: false
    }
  },
  {
    name: 'join_game',
    description: 'Claim one seat for an agent and return that seat\'s private observation.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 },
        agentId: { type: 'string' },
        displayName: { type: 'string', minLength: 1, maxLength: 40, description: 'Public name shown at the table; agentId remains the stable seat identity.' },
        strategyId: { type: 'string', description: 'Markdown strategy id; defaults to the server default.' }
      },
      required: ['gameId', 'seatId', 'agentId'],
      additionalProperties: false
    }
  },
  {
    name: 'observe_game',
    description: 'Read the private game observation visible to one seat.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 }
      },
      required: ['gameId', 'seatId'],
      additionalProperties: false
    }
  },
  {
    name: 'start_game',
    description: 'Start dealing after all three agent seats have joined and are ready.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 }
      },
      required: ['gameId', 'seatId'],
      additionalProperties: false
    }
  },
  {
    name: 'submit_action',
    description: 'Submit a bid, play, or pass using the seq from the latest observation.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 },
        seq: { type: 'integer' },
        action: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['bid', 'play', 'pass'] },
            value: { type: 'integer', enum: [0, 1] },
            cards: { type: 'array', items: { type: 'string' }, uniqueItems: true }
          },
          required: ['type'],
          additionalProperties: false
        },
        decision: {
          type: 'object',
          description: 'Optional concise decision summary for global spectators and replay. Do not include hidden chain-of-thought.',
          properties: {
            summary: { type: 'string', minLength: 1, maxLength: 160 },
            intent: { type: 'string', maxLength: 80 },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['summary'],
          additionalProperties: false
        }
      },
      required: ['gameId', 'seatId', 'seq', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'submit_review',
    description: 'Submit a structured post-game review with concrete strategy improvement suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string' },
        seatId: { type: 'integer', minimum: 0, maximum: 2 },
        review: {
          type: 'object',
          properties: {
            assessment: { type: 'string', minLength: 1, maxLength: 500 },
            problems: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 180 } },
            improvements: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 180 } },
            strategySuggestions: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 220 } }
          },
          required: ['assessment', 'problems', 'improvements', 'strategySuggestions'],
          additionalProperties: false
        }
      },
      required: ['gameId', 'seatId', 'review'],
      additionalProperties: false
    }
  }
];

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options
    });
  } catch {
    throw new Error(`game_service_unavailable: start the game service at ${baseUrl}`);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `http_${response.status}`);
  return data;
}

async function callTool(name, args) {
  if (name === 'list_strategies') return request('/agent/v1/strategies');
  if (name === 'create_game') {
    return request('/agent/v1/games', {
      method: 'POST',
      body: JSON.stringify(args)
    });
  }
  if (name === 'create_rematch') {
    return request(`/api/replays/${encodeURIComponent(args.sourceGameId)}/rematch`, { method: 'POST', body: '{}' });
  }
  if (name === 'create_competition') {
    return request('/agent/v1/competitions', { method: 'POST', body: JSON.stringify(args) });
  }
  if (name === 'observe_competition') {
    return request(`/agent/v1/competitions/${encodeURIComponent(args.competitionId)}?seatId=${args.seatId}`);
  }
  if (name === 'submit_competition_review') {
    return request(`/agent/v1/competitions/${encodeURIComponent(args.competitionId)}/review`, {
      method: 'POST',
      body: JSON.stringify(args)
    });
  }
  if (name === 'join_game') {
    return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/join`, {
      method: 'POST',
      body: JSON.stringify(args)
    });
  }
  if (name === 'observe_game') {
    return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/observe?seatId=${args.seatId}`);
  }
  if (name === 'start_game') {
    return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/start`, { method: 'POST', body: JSON.stringify(args) });
  }
  if (name === 'submit_action') {
    return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/actions`, {
      method: 'POST',
      body: JSON.stringify(args)
    });
  }
  if (name === 'submit_review') {
    return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/review`, {
      method: 'POST',
      body: JSON.stringify(args)
    });
  }
  throw new Error('tool_not_found');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') {
    sendResult(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-h5-game', version: '0.1.0' }
    });
    return;
  }
  if (message.method === 'ping') {
    sendResult(message.id, {});
    return;
  }
  if (message.method === 'tools/list') {
    sendResult(message.id, { tools });
    return;
  }
  if (message.method === 'tools/call') {
    try {
      const value = await callTool(message.params?.name, message.params?.arguments || {});
      sendResult(message.id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value
      });
    } catch (error) {
      sendResult(message.id, {
        content: [{ type: 'text', text: error.message }],
        isError: true
      });
    }
    return;
  }
  if (message.id !== undefined) sendError(message.id, -32601, 'Method not found');
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
lines.on('line', (line) => {
  queue = queue
    .then(async () => {
      try {
        await handle(JSON.parse(line));
      } catch (error) {
        sendError(null, -32700, error.message);
      }
    });
});
