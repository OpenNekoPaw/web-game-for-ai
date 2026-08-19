import {
  createCompetition,
  createMatch,
  createMatchInvite,
  createRematch,
  getStrategies,
  joinAgentInvite,
  joinMatch,
  observeCompetition,
  observeMatch,
  submitCompetitionReview,
  submitMatchAction,
  submitMatchReview,
  startMatch
} from '../game/store.js';

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

export const MCP_TOOLS = [
  tool('list_strategies', 'List optional server-catalog strategies. Local strategy files remain with the Agent.', {}),
  tool('create_game', 'Create a random Dou Dizhu game.', { properties: {}, additionalProperties: false }),
  tool('create_rematch', 'Create a new game using the initial deal from a completed game.', {
    properties: { sourceGameId: { type: 'string' } }, required: ['sourceGameId']
  }),
  tool('create_competition', 'Create a 3, 5, or 7-round Dou Dizhu competition.', {
    properties: { totalRounds: { type: 'integer', enum: [3, 5, 7] } }, additionalProperties: false
  }),
  tool('join_invite', 'Join an Agent invitation. The token selects this server, game, and seat; strategy stays with the Agent.', {
    properties: {
      inviteToken: { type: 'string', description: 'Token from the Agent invitation URL.' },
      inviteUrl: { type: 'string', description: 'Full Agent invitation URL; the final path segment is used as the token.' },
      agentId: { type: 'string', minLength: 1, maxLength: 120 },
      displayName: { type: 'string', minLength: 1, maxLength: 40 }
    }, required: ['agentId'], additionalProperties: false
  }),
  tool('join_game', 'Claim or reconnect to one Agent seat. Use strategyMode=local when the Agent owns its strategy.', {
    properties: {
      gameId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 },
      agentId: { type: 'string' }, displayName: { type: 'string', minLength: 1, maxLength: 40 },
      strategyMode: { type: 'string', enum: ['local', 'server'] }, strategyId: { type: 'string' }
    }, required: ['gameId', 'seatId', 'agentId'], additionalProperties: false
  }),
  tool('observe_game', 'Read the private observation visible to one Agent seat.', {
    properties: { gameId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 } },
    required: ['gameId', 'seatId'], additionalProperties: false
  }),
  tool('start_game', 'Mark one joined seat ready. All three ready seats start the deal.', {
    properties: { gameId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 } },
    required: ['gameId', 'seatId'], additionalProperties: false
  }),
  tool('submit_action', 'Submit a bid, play, or pass using the latest observation sequence.', {
    properties: {
      gameId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 }, seq: { type: 'integer' },
      action: { type: 'object' }, decision: { type: 'object' }
    }, required: ['gameId', 'seatId', 'seq', 'action'], additionalProperties: false
  }),
  tool('submit_review', 'Submit a structured post-game review.', {
    properties: { gameId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 }, review: { type: 'object' } },
    required: ['gameId', 'seatId', 'review'], additionalProperties: false
  }),
  tool('observe_competition', 'Read competition scores and the requesting Agent seat context.', {
    properties: { competitionId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 } },
    required: ['competitionId', 'seatId'], additionalProperties: false
  }),
  tool('submit_competition_review', 'Submit the final multi-round competition review.', {
    properties: { competitionId: { type: 'string' }, seatId: { type: 'integer', minimum: 0, maximum: 2 }, review: { type: 'object' } },
    required: ['competitionId', 'seatId', 'review'], additionalProperties: false
  })
];

function tool(name, description, inputSchema) {
  return { name, description, inputSchema: { type: 'object', ...inputSchema } };
}

export async function handleMcpMessage(message) {
  if (!message || typeof message !== 'object') return rpcError(null, -32600, 'Invalid Request');
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'ping') return rpcResult(message.id, {});
  if (message.method === 'initialize') {
    return rpcResult(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-game-ddz', version: '1.0.0' }
    });
  }
  if (message.method === 'tools/list') return rpcResult(message.id, { tools: MCP_TOOLS });
  if (message.method === 'tools/call') {
    try {
      return rpcResult(message.id, await callTool(message.params?.name, message.params?.arguments || {}));
    } catch (error) {
      return rpcResult(message.id, { ...text({ ok: false, error: error.message }), isError: true });
    }
  }
  return rpcError(message.id ?? null, -32601, 'Method not found');
}

async function callTool(name, args) {
  switch (name) {
    case 'list_strategies': return text({ protocol: 'agent-game.v1', ...getStrategies() });
    case 'create_game': {
      const game = createMatch(args);
      return text({ protocol: 'agent-game.v1', gameId: game.gameId, turnTimeoutMs: game.turnTimeoutMs });
    }
    case 'create_rematch': {
      const game = createRematch(args.sourceGameId);
      return text({ protocol: 'agent-game.v1', gameId: game.gameId, sourceGameId: game.sourceGameId, turnTimeoutMs: game.turnTimeoutMs });
    }
    case 'create_competition': return text(createCompetition(args));
    case 'join_invite': {
      const token = inviteToken(args.inviteToken || args.inviteUrl);
      return text(joinAgentInvite(token, args.agentId, args.displayName));
    }
    case 'join_game': {
      const strategyMode = args.strategyMode || 'local';
      const strategyId = strategyMode === 'server' ? args.strategyId : undefined;
      return text(joinMatch(args.gameId, args.seatId, args.agentId, strategyId, args.displayName, { strategyMode }));
    }
    case 'observe_game': return text(observeMatch(args.gameId, args.seatId));
    case 'start_game': return text(startMatch(args.gameId, args.seatId));
    case 'submit_action': return text(submitMatchAction(args.gameId, args.seatId, args.action, args.seq, { source: 'agent', decision: args.decision }));
    case 'submit_review': return text(submitMatchReview(args.gameId, args.seatId, args.review));
    case 'observe_competition': return text(observeCompetition(args.competitionId, args.seatId));
    case 'submit_competition_review': return text(submitCompetitionReview(args.competitionId, args.seatId, args.review));
    default: throw new Error('tool_not_found');
  }
}

function inviteToken(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid_invite_token');
  let token = value.trim();
  try {
    const url = new URL(token);
    token = url.pathname.split('/').filter(Boolean).at(-1) || '';
  } catch {
    // Accept a raw token as well as a full invitation URL.
  }
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('invalid_invite_token');
  return token;
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
