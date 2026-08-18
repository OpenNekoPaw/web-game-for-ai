import { createInterface } from 'node:readline';

const baseUrl = process.env.DDZ_SERVER_URL || 'http://127.0.0.1:3000';
const tools = [
  { name:'create_game', description:'Create a new Dou Dizhu game.', inputSchema:{ type:'object', properties:{}, additionalProperties:false } },
  { name:'join_game', description:'Claim one seat for an agent and receive its private observation.', inputSchema:{ type:'object', properties:{ gameId:{type:'string'}, seatId:{type:'integer',minimum:0,maximum:2}, agentId:{type:'string'} }, required:['gameId','seatId','agentId'], additionalProperties:false } },
  { name:'observe_game', description:'Read the observation visible to one seat.', inputSchema:{ type:'object', properties:{ gameId:{type:'string'}, seatId:{type:'integer',minimum:0,maximum:2} }, required:['gameId','seatId'], additionalProperties:false } },
  { name:'submit_action', description:'Submit a bid, play, or pass for one seat. Include the seq from the latest observation.', inputSchema:{ type:'object', properties:{ gameId:{type:'string'}, seatId:{type:'integer',minimum:0,maximum:2}, seq:{type:'integer'}, action:{ type:'object', properties:{ type:{type:'string',enum:['bid','play','pass']}, value:{type:'integer',enum:[0,1]}, cards:{type:'array',items:{type:'string'}} }, required:['type'], additionalProperties:false } }, required:['gameId','seatId','seq','action'], additionalProperties:false } },
];

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers:{'content-type':'application/json'}, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `http_${response.status}`);
  return data;
}

async function callTool(name, args) {
  if (name === 'create_game') return request('/agent/v1/games', { method:'POST', body:'{}' });
  if (name === 'join_game') return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/join`, { method:'POST', body:JSON.stringify(args) });
  if (name === 'observe_game') return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/observe?seatId=${args.seatId}`);
  if (name === 'submit_action') return request(`/agent/v1/games/${encodeURIComponent(args.gameId)}/actions`, { method:'POST', body:JSON.stringify(args) });
  throw new Error('tool_not_found');
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, value) { send({ jsonrpc:'2.0', id, result:value }); }
function error(id, code, message) { send({ jsonrpc:'2.0', id, error:{code,message} }); }

async function handle(message) {
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'initialize') return result(message.id, { protocolVersion:message.params?.protocolVersion || '2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'ddz-agent-game',version:'0.1.0'} });
  if (message.method === 'ping') return result(message.id, {});
  if (message.method === 'tools/list') return result(message.id, { tools });
  if (message.method === 'tools/call') {
    try { const value = await callTool(message.params?.name, message.params?.arguments || {}); return result(message.id, { content:[{type:'text',text:JSON.stringify(value,null,2)}], structuredContent:value }); }
    catch (caught) { return result(message.id, { content:[{type:'text',text:caught.message}], isError:true }); }
  }
  if (message.id !== undefined) error(message.id, -32601, 'Method not found');
}

const lines = createInterface({ input:process.stdin, crlfDelay:Infinity });
let queue = Promise.resolve();
lines.on('line', (line) => {
  queue = queue.then(() => handle(JSON.parse(line))).catch((caught) => error(null, -32700, caught.message));
});
